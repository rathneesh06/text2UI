// bff/dashboard/layout.ts — the deterministic layout pass. Runs after validation,
// before SQL/render, so every pipeline (agents, planner, edits) benefits.
//
// Guarantee: NO ROW SHIPS UNFILLED. Widgets carry fixed widths (kpi=quarter,
// chart=half, table=full), so any odd count used to leave a hole in the grid —
// e.g. three half-width charts rendered as a full pair plus a lonely half chart
// next to dead white space. This pass:
//   1. packs each section's widgets greedily into 12-column rows,
//   2. rebalances trailing orphans (5 KPIs become rows of 3+2, not 4+1),
//   3. re-widths every row by its widget count so each row sums to exactly 12
//      (1 → full, 2 → half+half, 3 → third×3, 4 → quarter×4).
// Validation may drop widgets AFTER the planner chose widths — this pass is what
// keeps the grid whole no matter what survived.
import type { DashboardSpec, Section, Widget, WidgetWidth } from "../../shared/dashboard-spec";

const SPAN: Record<WidgetWidth, number> = { quarter: 3, third: 4, half: 6, full: 12 };
const WIDTH_BY_COUNT: Record<number, WidgetWidth> = { 1: "full", 2: "half", 3: "third", 4: "quarter" };

const spanOf = (w: Widget): number => SPAN[w.width ?? defaultWidth(w)] ?? 6;
const defaultWidth = (w: Widget): WidgetWidth => (w.kind === "kpi" ? "quarter" : w.kind === "table" ? "full" : "half");

/** Pack widgets into rows of <= 12 columns using their current widths. */
export function packRows(widgets: Widget[]): Widget[][] {
  const rows: Widget[][] = [];
  let row: Widget[] = [];
  let used = 0;
  for (const w of widgets) {
    const s = spanOf(w);
    if (row.length && used + s > 12) { rows.push(row); row = []; used = 0; }
    row.push(w); used += s;
  }
  if (row.length) rows.push(row);
  return rows;
}

/** Move items from a crowded previous row into a trailing orphan row until the
 *  two are balanced: [4,1] → [3,2], [4,4,1] → [4,3,2]. Never crosses sections. */
function rebalanceOrphans(rows: Widget[][]): Widget[][] {
  for (let i = rows.length - 1; i > 0; i--) {
    while (rows[i].length + 1 < rows[i - 1].length) {
      const moved = rows[i - 1].pop();
      if (!moved) break;
      rows[i].unshift(moved);
    }
  }
  return rows;
}

/** Re-width a row purely by its count so it always sums to 12 columns. Rows of
 *  5+ (possible only via hand-written specs) fall back to quarter — a small
 *  overflow wraps gracefully instead of crashing. */
function fillRow(row: Widget[]): Widget[] {
  const width = WIDTH_BY_COUNT[row.length] ?? "quarter";
  return row.map((w) => ({ ...w, width }));
}

/** Balance one section: pack → rebalance orphans → fill every row. */
export function balanceSection(section: Section): Section {
  if (!section.widgets.length) return section;
  const rows = rebalanceOrphans(packRows(section.widgets));
  return { ...section, widgets: rows.flatMap(fillRow) };
}

/** Balance every section of a spec. Pure — returns a new spec. */
export function balanceLayout(spec: DashboardSpec): DashboardSpec {
  return { ...spec, sections: spec.sections.map(balanceSection) };
}
