// bff/design-rag/render-service.ts — a shared, concurrency-capped render queue.
//
// Problem it solves: enrollment used to launch a fresh Chromium per render
// (launch -> render -> close), so a burst of enrollments meant a burst of
// browsers — the in-process resource risk. This owns ONE shared browser,
// launched lazily and reused across renders, and caps how many renders run at
// once; excess jobs queue. The browser auto-closes after an idle period so we
// don't hold Chromium open forever.
//
// The browser lifecycle can't be unit-tested offline, so it's isolated behind an
// injectable renderImpl. The valuable part — the concurrency/queue logic — IS
// tested by injecting a fake impl.

import { DESIGN_RAG_RENDER_CONCURRENCY, DESIGN_RAG_RENDER_IDLE_MS } from "./config";

export interface RenderJobOpts { width?: number; height?: number; settleMs?: number; fullPage?: boolean; }
export type RenderImpl = (html: string, opts: RenderJobOpts) => Promise<Buffer>;

const DEFAULT_VIEWPORT = { width: 1280, height: 900 };

/** Owns a single shared Chromium: lazy launch, reuse, idle auto-close. */
class SharedBrowser {
  private browser: any = null;
  private launching: Promise<any> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private idleMs: number) {}

  private async get(): Promise<any> {
    if (this.browser) return this.browser;
    if (!this.launching) {
      const spec = "playwright"; // non-literal: lazy devDep, defeats TS resolution
      this.launching = (async () => {
        let pw: any;
        try { pw = await import(spec); }
        catch { throw new Error("playwright not installed — run: npm i -D playwright && npx playwright install chromium"); }
        this.browser = await pw.chromium.launch({ headless: true });
        this.launching = null;
        return this.browser;
      })();
    }
    return this.launching;
  }

  async render(html: string, opts: RenderJobOpts): Promise<Buffer> {
    this.cancelIdle();
    const browser = await this.get();
    const page = await browser.newPage({
      viewport: { width: opts.width ?? DEFAULT_VIEWPORT.width, height: opts.height ?? DEFAULT_VIEWPORT.height },
      deviceScaleFactor: 2,
    });
    try {
      await page.setContent(html, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(opts.settleMs ?? 1800); // let recharts finish drawing
      return (await page.screenshot({ type: "png", fullPage: opts.fullPage ?? false })) as Buffer;
    } finally {
      await page.close().catch(() => {});
      this.scheduleIdle();
    }
  }

  /** Navigate to a live URL and screenshot it (for full-app capture imports). */
  async capture(url: string, opts: RenderJobOpts): Promise<Buffer> {
    this.cancelIdle();
    const browser = await this.get();
    const page = await browser.newPage({
      viewport: { width: opts.width ?? DEFAULT_VIEWPORT.width, height: opts.height ?? DEFAULT_VIEWPORT.height },
      deviceScaleFactor: 2,
    });
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(opts.settleMs ?? 1800); // let charts finish drawing
      return (await page.screenshot({ type: "png", fullPage: opts.fullPage ?? false })) as Buffer;
    } finally {
      await page.close().catch(() => {});
      this.scheduleIdle();
    }
  }

  private scheduleIdle() {
    this.cancelIdle();
    if (this.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => { void this.close(); }, this.idleMs);
    this.idleTimer.unref?.(); // don't keep the process alive just for this
  }
  private cancelIdle() { if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; } }

  async close() {
    this.cancelIdle();
    const b = this.browser; this.browser = null; this.launching = null;
    if (b) { try { await b.close(); } catch { /* ignore */ } }
  }
}

/** A concurrency-capped queue around a RenderImpl. */
export class RenderQueue {
  private readonly concurrency: number;
  private readonly impl: RenderImpl;
  private readonly captureImpl: RenderImpl | null;
  private readonly shared: SharedBrowser | null;
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(opts: { concurrency?: number; idleMs?: number; renderImpl?: RenderImpl; captureImpl?: RenderImpl } = {}) {
    this.concurrency = Math.max(1, opts.concurrency ?? DESIGN_RAG_RENDER_CONCURRENCY);
    if (opts.renderImpl) { this.impl = opts.renderImpl; this.shared = null; }
    else {
      this.shared = new SharedBrowser(opts.idleMs ?? DESIGN_RAG_RENDER_IDLE_MS);
      this.impl = (h, o) => this.shared!.render(h, o);
    }
    this.captureImpl = opts.captureImpl ?? (this.shared ? (u, o) => this.shared!.capture(u, o) : null);
  }

  async render(html: string, opts: RenderJobOpts = {}): Promise<Buffer> {
    await this.acquire();
    try { return await this.impl(html, opts); }
    finally { this.release(); }
  }

  /** Navigate to a live URL and screenshot it — shares the same browser + cap. */
  async capture(url: string, opts: RenderJobOpts = {}): Promise<Buffer> {
    if (!this.captureImpl) throw new Error("RenderQueue: no captureImpl configured");
    await this.acquire();
    try { return await this.captureImpl(url, opts); }
    finally { this.release(); }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) { this.active++; return Promise.resolve(); }
    return new Promise<void>((resolve) => this.waiters.push(() => { this.active++; resolve(); }));
  }
  private release() {
    this.active--;
    this.waiters.shift()?.();
  }

  /** In-flight render count (for tests / health checks). */
  get activeCount(): number { return this.active; }
  /** Queued (waiting) render count. */
  get pendingCount(): number { return this.waiters.length; }

  async close(): Promise<void> { if (this.shared) await this.shared.close(); }
}

let singleton: RenderQueue | null = null;
/** Process-wide shared render queue (browser reuse + concurrency cap). */
export function getRenderQueue(): RenderQueue {
  if (!singleton) singleton = new RenderQueue();
  return singleton;
}
