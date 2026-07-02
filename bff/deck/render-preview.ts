// bff/deck/render-preview.ts — the exact-preview renderer (Phase A#3). Converts the real
// .pptx to a PDF with headless LibreOffice, then rasterizes each PDF page to a PNG with
// pdfjs + a prebuilt canvas (no poppler / no native build). These are the ACTUAL rendered
// slides, so the in-app preview matches the download exactly — unlike the SVG approximation.
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createCanvas } from "@napi-rs/canvas";

const execFileP = promisify(execFile);

/** LibreOffice binary. Override with SOFFICE_PATH; sensible per-OS defaults otherwise. */
export function sofficeBin(): string {
  if (process.env.SOFFICE_PATH) return process.env.SOFFICE_PATH;
  if (process.platform === "win32") return "C:\\Program Files\\LibreOffice\\program\\soffice.exe";
  if (process.platform === "darwin") return "/Applications/LibreOffice.app/Contents/MacOS/soffice";
  return "soffice";
}

let availabilityCache: boolean | undefined;
/** Is LibreOffice callable? Cached after first probe. */
export async function sofficeAvailable(): Promise<boolean> {
  if (availabilityCache !== undefined) return availabilityCache;
  try { await execFileP(sofficeBin(), ["--version"], { timeout: 8000, windowsHide: true }); availabilityCache = true; }
  catch { availabilityCache = false; }
  return availabilityCache;
}

async function pptxToPdf(pptx: Buffer, timeoutMs: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "deck-"));
  const profile = await mkdtemp(join(tmpdir(), "loprofile-"));   // isolated profile → safe concurrent runs
  const inPath = join(dir, "deck.pptx");
  try {
    await writeFile(inPath, pptx);
    await execFileP(sofficeBin(), [
      "--headless", "--norestore", "--nolockcheck", "--nodefault",
      `-env:UserInstallation=file://${profile.replace(/\\/g, "/")}`,
      "--convert-to", "pdf", "--outdir", dir, inPath,
    ], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 27 });
    return await readFile(join(dir, "deck.pdf"));
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
    rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

async function pdfToPngDataUrls(pdf: Buffer, scale: number): Promise<string[]> {
  // Dynamic import: pdfjs legacy build is ESM and has no types for the deep path.
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: true, disableFontFace: true }).promise;
  const out: string[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D, viewport }).promise;
      out.push("data:image/png;base64," + canvas.toBuffer("image/png").toString("base64"));
      page.cleanup();
    }
  } finally {
    try { await doc.destroy?.(); } catch { /* ignore cleanup errors */ }
  }
  return out;
}

/** Render a .pptx buffer to one PNG data URL per slide. Throws if LibreOffice is missing. */
export async function pptxToSlideImages(pptx: Buffer, scale = 1.5, timeoutMs = 45000): Promise<string[]> {
  if (!(await sofficeAvailable())) throw new Error("LibreOffice (soffice) not found — set SOFFICE_PATH");
  const pdf = await pptxToPdf(pptx, timeoutMs);
  return pdfToPngDataUrls(pdf, scale);
}