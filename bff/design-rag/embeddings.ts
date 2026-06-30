// bff/design-rag/embeddings.ts — the embedding boundary for Design Retrieval.
//
// Ingest, enrollment, and retrieval all go through EmbeddingClient — never a
// concrete vendor — so the model is swappable (locked decision #2) without
// touching call sites.
//
// Default impl: Google gemini-embedding-2, the first multimodal model on the
// Gemini Developer API. Same endpoint + GEMINI_API_KEY as generation
// (aiflow.ts), so no extra credentials. Image and text land in ONE shared
// space, so a text/schema query can retrieve a screenshot.

import { DESIGN_EMBED_MODEL, DESIGN_EMBED_DIM } from "./config";

export interface EmbeddingClient {
  /** Embed a PNG image into the shared multimodal space. Returns `dim` floats. */
  embedImage(png: Buffer): Promise<number[]>;
  /** Embed text (a query or a caption) into the same space. */
  embedText(text: string): Promise<number[]>;
  /** Output dimensionality; matches the pgvector column width. */
  readonly dim: number;
}

// Minimal shape we use from fetch — injectable so tests need no network.
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<any> }>;

const GEMINI_KEY = process.env.GEMINI_API_KEY ?? "";
const embedUrl = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`;

export interface GoogleEmbeddingOptions {
  apiKey?: string;
  model?: string;
  dim?: number;
  fetchImpl?: FetchLike;
  maxRetries?: number;
}

export class GoogleEmbeddingClient implements EmbeddingClient {
  readonly dim: number;
  private model: string;
  private apiKey: string;
  private fetchImpl: FetchLike;
  private maxRetries: number;

  constructor(opts: GoogleEmbeddingOptions = {}) {
    this.model = opts.model ?? DESIGN_EMBED_MODEL;
    this.dim = opts.dim ?? DESIGN_EMBED_DIM;
    this.apiKey = opts.apiKey ?? GEMINI_KEY;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.maxRetries = opts.maxRetries ?? 3;
  }

  embedText(text: string): Promise<number[]> {
    return this.embed({ parts: [{ text }] });
  }

  embedImage(png: Buffer): Promise<number[]> {
    const data = png.toString("base64");
    return this.embed({ parts: [{ inline_data: { mime_type: "image/png", data } }] });
  }

  /** One embedContent call with light backoff. Returns exactly `dim` floats.
   *  NOTE: `outputDimensionality` is the documented REST field for Matryoshka
   *  truncation; confirm against the live API when wiring the key (this is built
   *  without live access). It is trivial to adjust here without touching callers. */
  private async embed(content: { parts: any[] }): Promise<number[]> {
    if (!this.apiKey) throw new Error("GoogleEmbeddingClient: GEMINI_API_KEY is not set");
    const body = JSON.stringify({ content, outputDimensionality: this.dim });
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchImpl(embedUrl(this.model), {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
          body,
        });
        if (!res.ok) {
          const txt = await res.text();
          // 429/5xx are transient; back off + retry. Other 4xx are fatal.
          if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
            await sleep(400 * 2 ** attempt + Math.random() * 200);
            continue;
          }
          throw new Error(`embedContent HTTP ${res.status}: ${txt.slice(0, 200)}`);
        }
        const json = await res.json();
        const values = extractValues(json);
        if (!values || values.length === 0) {
          throw new Error("embedContent: no embedding values in response");
        }
        return values;
      } catch (err) {
        lastErr = err;
        if (attempt < this.maxRetries) {
          await sleep(400 * 2 ** attempt + Math.random() * 200);
          continue;
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

/** REST embedContent returns { embedding: { values } }; the genai SDK returns
 *  { embeddings: [{ values }] }. Accept either, so we're robust to the surface. */
function extractValues(json: any): number[] | null {
  if (Array.isArray(json?.embedding?.values)) return json.embedding.values;
  if (Array.isArray(json?.embeddings?.[0]?.values)) return json.embeddings[0].values;
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Deterministic, network-free client for offline tests and as a safe stand-in.
 *  Hashes the input into a unit-norm pseudo-vector of the right dim: the same
 *  input always yields the same vector, and cosine math behaves sensibly. */
export class FakeEmbeddingClient implements EmbeddingClient {
  readonly dim: number;
  constructor(dim: number = DESIGN_EMBED_DIM) {
    this.dim = dim;
  }
  embedText(text: string): Promise<number[]> {
    return Promise.resolve(this.hashVec(`t:${text}`));
  }
  embedImage(png: Buffer): Promise<number[]> {
    return Promise.resolve(this.hashVec(`i:${png.toString("base64").slice(0, 64)}`));
  }
  private hashVec(seed: string): number[] {
    // FNV-1a string hash seeds an xorshift PRNG → deterministic floats in [-1,1].
    let h = 2166136261 >>> 0;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    const v = new Array<number>(this.dim);
    let x = h || 1;
    for (let i = 0; i < this.dim; i++) {
      x ^= x << 13; x >>>= 0;
      x ^= x >> 17;
      x ^= x << 5; x >>>= 0;
      v[i] = (x / 0xffffffff) * 2 - 1;
    }
    const norm = Math.sqrt(v.reduce((s, n) => s + n * n, 0)) || 1;
    return v.map((n) => n / norm);
  }
}

/** Default client factory. Swap the vendor here (or via env) — call sites only
 *  ever see EmbeddingClient. */
export function makeEmbeddingClient(): EmbeddingClient {
  return new GoogleEmbeddingClient();
}
