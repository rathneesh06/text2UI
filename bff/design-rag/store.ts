// bff/design-rag/store.ts — the pgvector data-access layer for Design Retrieval.
//
// Wraps the public.text2ui_design_refs table created in postgres.ts init() (§5.1).
// Depends only on a structural `Queryable` (query(text, params) -> { rows }),
// which pg.Pool satisfies at runtime and a mock satisfies in tests — so all of
// the SQL/param/row-mapping logic is verifiable with no database.
//
// pgvector specifics:
//   - vectors bind as a "[a,b,c]" string literal, cast with $n::vector;
//   - ANN uses the cosine-distance operator <=> (matches the vector_cosine_ops
//     HNSW index), so smaller distance = more similar.

import pg from "pg";
import { DESIGN_EMBED_DIM } from "./config";
import { isSimilarHash } from "./hash";

export type DesignMode = "dashboard" | "pdf" | "ppt";

/** Minimal DB surface we need — pg.Pool/PoolClient satisfy it structurally. */
export interface Queryable {
  query(text: string, params?: any[]): Promise<{ rows: any[] }>;
}

/** What ingest/enrollment hands us to store. */
export interface DesignRefInsert {
  id: string;
  domain: string;
  mode: DesignMode;
  imagePath: string;
  phash: string;
  caption?: string | null;
  tags?: Record<string, unknown>;
  source: string;          // 'generation' | 'exemplar-seed' | 'figma' | 'import:<name>'
  license?: string | null; // SPDX-ish id, e.g. 'MIT', 'Apache-2.0', 'CC-BY-4.0'
  attribution?: string | null; // human-readable credit (required for CC-BY)
  sourceUrl?: string | null;   // where it came from (repo/file URL)
  quality?: number;        // P7 score that gated enrollment
  imgEmbed: number[];      // multimodal image embedding
  capEmbed?: number[] | null; // caption text embedding (optional)
}

/** A stored row, as returned by reads. `distance` is only set by annSearch. */
export interface DesignRefRow {
  id: string;
  domain: string;
  mode: string;
  imagePath: string;
  phash: string;
  caption: string | null;
  tags: Record<string, unknown>;
  source: string;
  license: string | null;
  attribution: string | null;
  sourceUrl: string | null;
  quality: number;
  retrievals: number;
  distance?: number;       // cosine distance from the query vector (annSearch)
}

export interface AnnSearchOpts {
  queryVec: number[];
  mode: DesignMode;
  domains?: string[];      // if set, domain = ANY(domains); else no domain filter
  minQuality?: number;     // if set, quality >= minQuality
  k: number;
}

/** Format a JS number[] as a pgvector literal: [0.1,0.2,0.3]. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

function mapRow(r: any): DesignRefRow {
  return {
    id: r.id,
    domain: r.domain,
    mode: r.mode,
    imagePath: r.image_path,
    phash: r.phash,
    caption: r.caption ?? null,
    tags: r.tags ?? {},
    source: r.source,
    license: r.license ?? null,
    attribution: r.attribution ?? null,
    sourceUrl: r.source_url ?? null,
    quality: typeof r.quality === "number" ? r.quality : Number(r.quality ?? 0),
    retrievals: typeof r.retrievals === "number" ? r.retrievals : Number(r.retrievals ?? 0),
    ...(r.distance !== undefined ? { distance: Number(r.distance) } : {}),
  };
}

export class PgVectorStore {
  constructor(private db: Queryable, private dim: number = DESIGN_EMBED_DIM) {}

  /** Insert a reference. Deduped by phash: returns true if stored, false if a
   *  near-identical design already existed (ON CONFLICT (phash) DO NOTHING). */
  async insert(ref: DesignRefInsert): Promise<boolean> {
    if (ref.imgEmbed.length !== this.dim) {
      throw new Error(`insert: imgEmbed dim ${ref.imgEmbed.length} != store dim ${this.dim}`);
    }
    const capLit = ref.capEmbed && ref.capEmbed.length ? toVectorLiteral(ref.capEmbed) : null;
    const res = await this.db.query(
      `INSERT INTO public.text2ui_design_refs
         (id, domain, mode, image_path, phash, caption, tags, source, license, attribution, source_url, quality, img_embed, cap_embed)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::vector,$14::vector)
       ON CONFLICT (phash) DO NOTHING
       RETURNING id`,
      [
        ref.id, ref.domain, ref.mode, ref.imagePath, ref.phash,
        ref.caption ?? null, JSON.stringify(ref.tags ?? {}), ref.source,
        ref.license ?? null, ref.attribution ?? null, ref.sourceUrl ?? null, ref.quality ?? 0,
        toVectorLiteral(ref.imgEmbed), capLit,
      ],
    );
    return res.rows.length > 0;
  }

  /** ANN over the image embedding, filtered by mode (+ optional domains/quality).
   *  Returns up to `k` rows ordered by ascending cosine distance. */
  async annSearch(opts: AnnSearchOpts): Promise<DesignRefRow[]> {
    if (opts.queryVec.length !== this.dim) {
      throw new Error(`annSearch: queryVec dim ${opts.queryVec.length} != store dim ${this.dim}`);
    }
    const params: any[] = [toVectorLiteral(opts.queryVec), opts.mode];
    const where: string[] = ["mode = $2"];
    if (opts.domains && opts.domains.length) {
      params.push(opts.domains);
      where.push(`domain = ANY($${params.length})`);
    }
    if (typeof opts.minQuality === "number") {
      params.push(opts.minQuality);
      where.push(`quality >= $${params.length}`);
    }
    params.push(Math.max(1, opts.k));
    const limitIdx = params.length;
    const sql =
      `SELECT id, domain, mode, image_path, phash, caption, tags, source, license, attribution, source_url,
              quality, retrievals, (img_embed <=> $1::vector) AS distance
         FROM public.text2ui_design_refs
        WHERE ${where.join(" AND ")}
        ORDER BY img_embed <=> $1::vector
        LIMIT $${limitIdx}`;
    const res = await this.db.query(sql, params);
    return res.rows.map(mapRow);
  }

  /** Bump the usage counter for retrieved refs (drives retire-low-value later). */
  async incRetrievals(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.query(
      `UPDATE public.text2ui_design_refs SET retrievals = retrievals + 1 WHERE id = ANY($1)`,
      [ids],
    );
  }

  /** True if a reference with this phash already exists (pre-ingest dedup check,
   *  so we can skip the expensive caption/embed work for a near-duplicate). */
  async existsByPhash(phash: string): Promise<boolean> {
    const res = await this.db.query(
      `SELECT 1 FROM public.text2ui_design_refs WHERE phash = $1 LIMIT 1`,
      [phash],
    );
    return res.rows.length > 0;
  }

  /** Find an existing reference whose phash is the SAME design — exact match, or
   *  perceptually within maxHamming. Returns its id, or null. Hamming distance
   *  can't be expressed in SQL over hex, so we scan candidate phashes in JS
   *  (fine at this corpus size; bucket by prefix if it ever grows large). */
  async findSimilarPhash(phash: string, maxHamming: number, mode?: DesignMode): Promise<string | null> {
    const res = await this.db.query(
      `SELECT id, phash FROM public.text2ui_design_refs${mode ? " WHERE mode = $1" : ""}`,
      mode ? [mode] : [],
    );
    for (const row of res.rows) {
      if (isSimilarHash(phash, row.phash as string, maxHamming)) return row.id as string;
    }
    return null;
  }

  /** Corpus size, optionally per mode (handy for health checks / tests). */
  async count(mode?: DesignMode): Promise<number> {
    const res = await this.db.query(
      `SELECT count(*)::int AS n FROM public.text2ui_design_refs WHERE ($1::text IS NULL OR mode = $1)`,
      [mode ?? null],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /** Prune dead weight: refs below a quality floor, or never retrieved after a
   *  grace period. Protected sources (exemplar seeds) are never removed.
   *  Returns the removed rows so the caller can delete their image files. */
  async retireRefs(opts: { minQuality: number; graceDays: number; protectedSources?: string[] }): Promise<{ id: string; imagePath: string }[]> {
    const protectedSources = opts.protectedSources ?? ["exemplar-seed"];
    const res = await this.db.query(
      `DELETE FROM public.text2ui_design_refs
        WHERE source <> ALL($1)
          AND ( quality < $2
                OR (retrievals = 0 AND created_at < now() - (($3)::text || ' days')::interval) )
        RETURNING id, image_path`,
      [protectedSources, opts.minQuality, opts.graceDays],
    );
    return res.rows.map((r: any) => ({ id: r.id, imagePath: r.image_path }));
  }
}

/** Build a store from PG_URL. Returns null when Postgres isn't configured, so
 *  callers degrade gracefully (retrieval -> text exemplar). */
export function makePgVectorStore(connectionString = process.env.PG_URL): PgVectorStore | null {
  if (!connectionString) return null;
  const pool = new pg.Pool({ connectionString, max: 3 });
  return new PgVectorStore(pool);
}
