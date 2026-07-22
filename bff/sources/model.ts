// sources/model.ts — STEP 3 of the MySQL track: a clean analytics model over the
// full snapshot (helpdesk / SOS tickets). Converts epoch → timestamp, joins
// the type/priority/status lookups to human titles, normalizes the join key
// (logs use `ticketid` for what everyone else calls `itilticketid`), and derives
// open/closed + age. These VIEWS are what the dashboard charts — not the raw,
// 100-column source tables.
//
// Run against the snapshot DuckDB produced by db:snapshot.
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { qid, duckTypeToColumnType } from "./mysql";
import type { Dataset, ColumnProfile } from "../../shared/types";
import { enrichColumns } from "../../shared/profile-enrich";
import { exactColumnStats } from "./exact-stats";

/** Each view is defensive: source tables may be absent if you snapshotted a
 *  subset, so creation failures are recorded as warnings, not fatal. */
const MODEL: { name: string; sql: string }[] = [
  {
    name: "tickets",
    sql: `CREATE OR REPLACE VIEW tickets AS
      SELECT
        t.itilticketid,
        t.rfcno,
        NULLIF(t.subject, '')                                  AS subject,
        to_timestamp(t.createdon)                              AS created_at,
        CASE WHEN t.closedon > 0 THEN to_timestamp(t.closedon) END AS closed_at,
        (t.closedon > 0)                                       AS is_closed,
        COALESCE(tt.typetittle, 'Unknown')                     AS ticket_type,
        COALESCE(pr.prioritytitle, 'Unknown')                  AS priority,
        COALESCE(st.statustitle, 'Unknown')                    AS status,
        t.deptid, t.groupid, t.ownerid, t.organizationid,
        ROUND((COALESCE(NULLIF(t.closedon, 0), CAST(epoch(now()) AS BIGINT)) - t.createdon) / 3600.0, 2) AS age_hours
      FROM my_tickets_sos t
      LEFT JOIN myshift__my_tickettypes tt ON tt.typeid = t.tickettypeid
      LEFT JOIN myshift__my_priority   pr ON pr.priorityid = t.priorityid
      LEFT JOIN myshift__my_status     st ON st.statusid = t.statusid
      WHERE t.createdon > 0`,   /* drop epoch-zero (1970) junk rows from the time axis */
  },
  {
    name: "tickets_by_day",
    sql: `CREATE OR REPLACE VIEW tickets_by_day AS
      SELECT CAST(created_at AS DATE) AS day, ticket_type, priority, status,
             count(*) AS tickets,
             count(*) FILTER (WHERE is_closed) AS closed_tickets
      FROM tickets
      GROUP BY 1, 2, 3, 4`,
  },
  {
    name: "posts",
    sql: `CREATE OR REPLACE VIEW posts AS
      SELECT
        p.ticketpostid, p.itilticketid,
        to_timestamp(p.dateline)        AS created_at,
        p.staffid,
        NULLIF(p.fullname, '')          AS author,
        NULLIF(p.email, '')             AS email,
        (p.hasattachments > 0)          AS has_attachments,
        NULLIF(p.firstresponsetime, 0)  AS first_response_time,
        NULLIF(p.responsetime, 0)       AS response_time,
        NULLIF(p.slaresponsetime, 0)    AS sla_response_time
      FROM swticketposts_sos p
      WHERE p.dateline > 0`,
  },
  {
    name: "logs",
    sql: `CREATE OR REPLACE VIEW logs AS
      SELECT l.id, l.ticketid AS itilticketid, to_timestamp(l.createdon) AS created_at,
             NULLIF(l.remarks, '') AS remarks, l.createdby
      FROM my_ticket_logs_sos l
      WHERE l.createdon > 0`,
  },
  {
    name: "notes",
    sql: `CREATE OR REPLACE VIEW notes AS
      SELECT n.noteid, n.itilticketid, to_timestamp(n.createdon) AS created_at,
             NULLIF(n.note, '') AS note, n.createdby
      FROM my_note_sos n
      WHERE n.createdon > 0`,
  },
  {
    name: "resolutions",
    sql: `CREATE OR REPLACE VIEW resolutions AS
      SELECT r.resolutionid, r.itilticketid, to_timestamp(r.createdon) AS created_at,
             NULLIF(r.summary, '') AS summary, NULLIF(r.resolution_steps, '') AS resolution_steps
      FROM my_resolution_sos r
      WHERE r.createdon > 0`,
  },
  {
    name: "sla",
    sql: `CREATE OR REPLACE VIEW sla AS
      SELECT s.itilticketid,
             COALESCE(tt.typetittle, 'Unknown') AS ticket_type,
             s.resolved_tat_hours, s.actual_tat_hours,
             s.sla_status, s.closed_sla,
             s.createdon AS sla_created_at, s.updatedon AS sla_updated_at
      FROM my_alltickets_sla s
      JOIN my_tickets_sos t ON t.itilticketid = s.itilticketid
      LEFT JOIN myshift__my_tickettypes tt ON tt.typeid = s.tickettypeid`,
  },
];

export interface ModelResult {
  dbPath: string;
  datasets: Dataset[];   // profiles of the curated views (dashboard-ready)
  created: string[];
  warnings: string[];
}

/** Build + profile the views on an EXISTING connection (no file open/close).
 *  Lets a long-lived caller (the BFF's colo source) reuse one cached instance. */
export async function applyModelOn(c: DuckDBConnection, opts: { onPhase?: (m: string) => void } = {}): Promise<Omit<ModelResult, "dbPath">> {
  const log = opts.onPhase ?? (() => {});
  const warnings: string[] = [];
  const created: string[] = [];
  const readAll = async (sql: string) => {
    const reader = await c.runAndReadUntil(sql, 100_000);
    return (reader.getRowObjectsJS() as Record<string, unknown>[]).map((row) => {
      for (const k in row) if (typeof row[k] === "bigint") row[k] = Number(row[k]);
      return row;
    });
  };

  for (const v of MODEL) {
    try { log(`building view ${v.name}…`); await c.run(v.sql); created.push(v.name); }
    catch (e) { warnings.push(`view ${v.name} could not be built: ${(e as Error).message}`); }
  }

  const datasets: Dataset[] = [];
  for (const name of created) {
    const colRows = await readAll(`DESCRIBE ${qid(name)}`);
    const cnt = await readAll(`SELECT count(*) AS n FROM ${qid(name)}`);
    // 200-row sample as the enrichment floor (5 rows made uniqueCount nonsense
    // and starved topValues); sampleRows stays small for prompt-context size.
    const sample = await readAll(`SELECT * FROM ${qid(name)} LIMIT 200`);
    let columns: ColumnProfile[] = colRows.map((r) => {
      const colName = String((r as any).column_name);
      const colType = String((r as any).column_type);
      const values = sample.map((s) => s[colName]).filter((x) => x !== null && x !== undefined);
      return {
        name: colName,
        type: duckTypeToColumnType(colType),
        nullable: sample.some((s) => s[colName] === null || s[colName] === undefined),
        uniqueCount: new Set(values.map((x) => String(x))).size,
        sampleValues: values.slice(0, 5),
      };
    });
    columns = enrichColumns(columns, sample);
    // We own this DuckDB: full-table GROUP BY / min-max are cheap and make the
    // observed-value + range guards TRUTHFUL (exact uniqueCounts, real bounds).
    columns = await exactColumnStats(readAll, qid(name), columns);
    datasets.push({
      tableName: name,
      profile: { source: { filename: `view:${name}`, format: "json" }, rowCount: Number((cnt[0] as any).n ?? 0), columns, sampleRows: sample.slice(0, 5) },
    });
  }

  try { await c.run("CHECKPOINT"); } catch { /* best-effort */ }
  return { datasets, created, warnings };
}

/** Open the snapshot file, build the model, and close it again (CLI / one-shot). */
export async function applyModel(dbPath: string, opts: { onPhase?: (m: string) => void } = {}): Promise<ModelResult> {
  const instance = await DuckDBInstance.create(dbPath);
  const c = await instance.connect();
  try {
    const r = await applyModelOn(c, opts);
    return { dbPath, ...r };
  } finally {
    c.disconnectSync();
    (instance as any).closeSync?.(); // release the file lock so other opens succeed
  }
}