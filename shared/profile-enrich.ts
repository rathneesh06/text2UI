// shared/profile-enrich.ts — derive topValues + min/max for column profiles.
//
// WHY: every value-aware feature downstream — the A1 select filters, the
// observed-value guard (which killed the "SLA attainment 0.0%" guessed-literal
// class), the avg+percent 0..100 range gate, and the model's own ability to
// emit CORRECT category literals — depends on profiles carrying the observed
// values and ranges. Until this module existed, no producer populated them, so
// all of those features were silently inert on real sources.
//
// This helper works over whatever rows the producer has in memory. For
// full-data producers (client-side upload ingestion) the result is EXACT; for
// sample-based producers it is a floor — DB-backed profilers should prefer
// exact SQL stats (see exactColumnStats in the source modules) and fall back
// to this.
import type { ColumnProfile } from "./types";

export const TOP_VALUES_LIMIT = 25;
/** Only track topValues for string columns whose distinct count stays sane. */
export const TOP_VALUES_MAX_DISTINCT = 50;

/** Enrich one column profile from its (sampled or full) values. Mutates a COPY. */
export function enrichColumn(profile: ColumnProfile, values: unknown[]): ColumnProfile {
  const out: ColumnProfile = { ...profile };
  const nonNull = values.filter((v) => v !== null && v !== undefined);

  if (profile.type === "string") {
    const counts = new Map<string, number>();
    for (const v of nonNull) {
      const s = String(v);
      counts.set(s, (counts.get(s) ?? 0) + 1);
      if (counts.size > TOP_VALUES_MAX_DISTINCT) break; // id-like / free text — not a category
    }
    if (counts.size >= 1 && counts.size <= TOP_VALUES_MAX_DISTINCT) {
      out.topValues = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, TOP_VALUES_LIMIT)
        .map(([value, count]) => ({ value, count }));
    }
  }

  if (profile.type === "integer" || profile.type === "number") {
    let lo = Infinity, hi = -Infinity;
    for (const v of nonNull) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      if (n < lo) lo = n;
      if (n > hi) hi = n;
    }
    if (lo <= hi) { out.min = lo; out.max = hi; }
  }

  if (profile.type === "date") {
    let lo: string | undefined, hi: string | undefined;
    for (const v of nonNull) {
      const s = v instanceof Date ? v.toISOString() : String(v);
      if (!s) continue;
      if (lo === undefined || s < lo) lo = s;
      if (hi === undefined || s > hi) hi = s;
    }
    if (lo !== undefined) { out.min = lo; out.max = hi; }
  }

  return out;
}

/** Enrich every column of a profile from a row array (rows keyed by column name). */
export function enrichColumns(columns: ColumnProfile[], rows: Record<string, unknown>[]): ColumnProfile[] {
  return columns.map((c) => enrichColumn(c, rows.map((r) => r[c.name])));
}
