// WorkbenchPage.tsx — the SQL Workbench: connect to a live MySQL database, chat
// with it (text2SQL), and extract tables into named sources that then appear on
// the build page exactly like "colo data".
//
// Layout mirrors ChatPage: a rail (here: connection + schema tree) on the left,
// the conversation as the dominant surface. The build handoff is CLIENT-driven:
// on intent=build the page extracts, then routes to the landing page with the
// new source preselected via the onUseWorkbenchSource callback from App.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  wbConnect, wbConnectParts, wbChat, wbExtract, wbExtractDb, wbStage, pgUriToParts,
  type WbConnection, type WbChatResponse, type WbExtracted, type WbConnParts, type WbStagedTable,
} from "../workbench-api";
import "./WorkbenchPage.css";

interface WbTurn {
  role: "user" | "assistant";
  text: string;
  sql?: string;
  rows?: Record<string, unknown>[];
  columns?: string[];
  truncated?: boolean;
  showSql?: boolean;
  extracted?: WbExtracted;
  meta?: { durationMs: number; rowsReturned: number };
}

interface WorkbenchPageProps {
  /** App-provided: registers the extracted source and preselects it for a build. */
  onUseWorkbenchSource?: (src: WbExtracted, buildPrompt?: string) => void;
  /** Dedicated-Postgres mode: structured connection form, PG-only copy. */
  pgOnly?: boolean;
}

type Viz =
  | { kind: "kpi"; label: string; value: string }
  | { kind: "bar" | "line"; cat: string; val: string; points: { c: string; v: number }[] }
  | { kind: "table" };

const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const looksTemporal = (v: unknown) =>
  v instanceof Date || (typeof v === "string" && /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?/.test(v));

/** Deterministic answer-shape detection: single value -> KPI card; small
 *  category/temporal aggregate -> inline chart; everything else -> grid.
 *  (Same philosophy as the pipelines: the model writes prose, shapes decide UI.) */
function classifyResult(rows: Record<string, unknown>[], columns: string[]): Viz {
  if (rows.length === 1 && columns.length === 1 && rows[0][columns[0]] != null) {
    return { kind: "kpi", label: columns[0], value: fmtCell(rows[0][columns[0]]) };
  }
  if (columns.length === 2 && rows.length >= 2 && rows.length <= 14) {
    const [cat, val] = columns;
    if (rows.every((r) => isNum(r[val]) && r[cat] != null)) {
      const points = rows.map((r) => ({ c: String(r[cat]), v: r[val] as number }));
      const kind = rows.every((r) => looksTemporal(r[cat])) ? "line" as const : "bar" as const;
      return { kind, cat, val, points };
    }
  }
  return { kind: "table" };
}

/** Self-contained SVG mini chart (no chart deps in the app shell). */
function MiniChart({ viz }: { viz: Extract<Viz, { kind: "bar" | "line" }> }) {
  const W = 460, PAD = 6, LABEL = 120;
  const max = Math.max(...viz.points.map((p) => p.v), 0) || 1;
  const min = Math.min(...viz.points.map((p) => p.v), 0);
  if (viz.kind === "bar") {
    const ROW = 24;
    return (
      <svg className="wb-viz" viewBox={`0 0 ${W} ${viz.points.length * ROW + PAD * 2}`} role="img" aria-label={`${viz.val} by ${viz.cat}`}>
        {viz.points.map((p, i) => {
          const w = Math.max(2, ((W - LABEL - 70) * p.v) / max);
          const y = PAD + i * ROW;
          return (
            <g key={i}>
              <text x={LABEL - 8} y={y + 15} textAnchor="end" className="wb-viz__label">{p.c.length > 16 ? p.c.slice(0, 15) + "…" : p.c}</text>
              <rect x={LABEL} y={y + 4} width={w} height={14} rx={3} className="wb-viz__bar" />
              <text x={LABEL + w + 6} y={y + 15} className="wb-viz__val">{p.v.toLocaleString()}</text>
            </g>
          );
        })}
      </svg>
    );
  }
  const H = 140, span = max - min || 1;
  const px = (i: number) => PAD + (i * (W - PAD * 2)) / Math.max(1, viz.points.length - 1);
  const py = (v: number) => 18 + (H - 40) * (1 - (v - min) / span);
  const path = viz.points.map((p, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(p.v).toFixed(1)}`).join(" ");
  return (
    <svg className="wb-viz" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${viz.val} over ${viz.cat}`}>
      <path d={path} className="wb-viz__line" fill="none" />
      {viz.points.map((p, i) => <circle key={i} cx={px(i)} cy={py(p.v)} r={2.5} className="wb-viz__dot" />)}
      <text x={PAD} y={H - 6} className="wb-viz__label">{viz.points[0].c}</text>
      <text x={W - PAD} y={H - 6} textAnchor="end" className="wb-viz__label">{viz.points[viz.points.length - 1].c}</text>
      <text x={PAD} y={12} className="wb-viz__val">{viz.val}: {min.toLocaleString()} – {max.toLocaleString()}</text>
    </svg>
  );
}

const fmtCell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 3 });
  return String(v);
};

export default function WorkbenchPage({ onUseWorkbenchSource, pgOnly = false }: WorkbenchPageProps) {
  const navigate = useNavigate();
  const [connStr, setConnStr] = useState("");
  // Dedicated-Postgres page (pgOnly): connection-string-first, with the literal
  // fields form behind a toggle (the escape hatch for un-encodable passwords).
  const [pgManual, setPgManual] = useState(false);
  const [pg, setPg] = useState<WbConnParts>({ dialect: "postgres", host: "", port: "5432", database: "", user: "postgres", password: "", ssl: false });
  const [connecting, setConnecting] = useState(false);
  const [liveMode, setLiveMode] = useState(false); // goal 3: per-source live data plane (opt-in)
  const [conn, setConn] = useState<WbConnection | null>(null);
  const [connError, setConnError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [extracting, setExtracting] = useState(false);

  const [turns, setTurns] = useState<WbTurn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Right panel: tables staged through this conversation, awaiting "Extract DB".
  const [stagedTables, setStagedTables] = useState<WbStagedTable[]>([]);
  const [dbName, setDbName] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  // Durable staging pairs with a remembered conversation: after a reload, restore
  // the staged panel so "Extract DB" still works (extracting MORE tables needs a
  // reconnect, which the empty connection bar makes obvious).
  const convKey = pgOnly ? "t2ui:wb:pg:conv" : "t2ui:wb:conv";
  const rememberConv = useCallback((id: string) => {
    setConversationId(id);
    try { sessionStorage.setItem(convKey, id); } catch { /* private mode */ }
  }, [convKey]);
  useEffect(() => {
    const saved = (() => { try { return sessionStorage.getItem(convKey); } catch { return null; } })();
    if (!saved) return;
    wbStage(saved).then((r) => {
      if (r.staged.tables.length) { setConversationId(saved); setStagedTables(r.staged.tables); }
    }).catch(() => { /* stage gone — fine */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** pgOnly string mode: normalize what people actually paste. Adds the scheme
   *  when missing (this page IS Postgres), tags key=value strings with
   *  dialect=postgres, and rejects mysql:// with a pointer to /workbench. */
  const normalizePgString = (raw: string): string => {
    const t = raw.trim();
    if (/^mysql/i.test(t)) throw new Error("this page is Postgres-only — use the SQL Workbench for MySQL");
    if (/:\/\//.test(t)) return t;                                   // postgres://… as-is
    if (/(^|\s)(host|hostname)=/i.test(t)) return /(^|\s)dialect=/i.test(t) ? t : `${t} dialect=postgres`; // key=value
    return `postgres://${t}`;                                        // user:pass@host:5432/db
  };

  const connect = useCallback(async () => {
    if (connecting) return;
    const manual = pgOnly && pgManual;
    if (!manual && !connStr.trim()) return;
    if (manual && (!pg.host.trim() || !pg.database.trim())) { setConnError("host and database are required"); return; }
    setConnecting(true); setConnError(null);
    try {
      // al3: MULTIPLE connection strings (one per line) become ONE connection
      // GROUP — merged schema, cross-DB joins. Sequential connects: the first
      // opens normally, each next line is added to the running group.
      // Separator: ';' or newline — never legal inside mysql://, postgres://,
      // or key=value connection forms, so splitting is unambiguous.
      const lines = connStr.split(/[;\n]+/).map((l) => l.trim()).filter(Boolean);
      // Send mode only when live is chosen — an unset mode keeps the server
      // default, so the env flag still governs connects made outside this UI.
      const mode = liveMode ? ("live" as const) : undefined;
      let c = manual
        ? await wbConnectParts({ ...pg, dialect: "postgres" }, mode)
        : await wbConnect(pgOnly ? normalizePgString(lines[0]) : lines[0], undefined, mode);
      if (!manual) {
        for (const line of lines.slice(1)) {
          c = await wbConnect(pgOnly ? normalizePgString(line) : line, c.connectionId);
        }
      }
      setConn(c); setSelected(new Set()); setTurns([]); setConversationId(null);
      // never keep credentials in component state longer than needed
      setConnStr("");
      setPg((prev) => ({ ...prev, password: "" }));
    } catch (e: any) {
      setConnError(e?.message ?? "connection failed");
    } finally {
      setConnecting(false);
    }
  }, [pgOnly, pgManual, pg, connStr, connecting, liveMode]);

  /** pgOnly: paste a postgres:// URI to pre-fill the form (decoded, reviewable). */
  const fillFromUri = useCallback((uri: string) => {
    const parts = pgUriToParts(uri);
    if (!parts) { setConnError("that doesn't look like a postgres:// URI"); return; }
    setConnError(null);
    setPg((prev) => ({ ...prev, ...parts, port: String(parts.port ?? "5432") }));
  }, []);

  const toggleTable = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const applyResponse = useCallback((r: WbChatResponse) => {
    rememberConv(r.conversationId);
    if (r.staged) setStagedTables(r.staged.tables);
    if (r.intent === "build") setStagedTables([]); // build publishes the stage
    setTurns((prev) => [...prev, {
      role: "assistant", text: r.answer, sql: r.sql, rows: r.rows, columns: r.columns,
      truncated: r.truncated, extracted: r.extracted ?? r.handoff,
      meta: r.executionMeta ? { durationMs: r.executionMeta.durationMs, rowsReturned: r.executionMeta.rowsReturned } : undefined,
    }]);
    if (r.intent === "build" && r.handoff && onUseWorkbenchSource) {
      // Hand off to the existing pipeline: preselect the source, carry the prompt.
      onUseWorkbenchSource(r.handoff, r.handoff.buildPrompt);
      // al4: go STRAIGHT to the build page. The old landing-page detour made the
      // user retype the prompt, which rebuilt without the buildPrompt AND wiped
      // the analyst evidence (fresh landing builds clear the directive by
      // design). ChatPage auto-starts from initialPrompt + consumes the directive.
      navigate("/build");
    }
  }, [onUseWorkbenchSource, navigate, rememberConv]);

  const send = useCallback(async () => {
    const p = prompt.trim();
    if (!p || !conn || busy) return;
    setPrompt("");
    setTurns((prev) => [...prev, { role: "user", text: p }]);
    setBusy(true);
    try {
      const r = await wbChat({ connectionId: conn.connectionId, prompt: p, ...(conversationId ? { conversationId } : {}) });
      applyResponse(r);
    } catch (e: any) {
      setTurns((prev) => [...prev, { role: "assistant", text: `Something went wrong: ${e?.message ?? e}` }]);
    } finally {
      setBusy(false);
    }
  }, [prompt, conn, busy, conversationId, applyResponse]);

  const extractSelected = useCallback(async () => {
    if (!conn || !selected.size || extracting) return;
    setExtracting(true);
    try {
      const r = await wbExtract({ connectionId: conn.connectionId, tables: [...selected], ...(conversationId ? { conversationId } : {}) });
      rememberConv(r.conversationId);
      setStagedTables(r.staged.tables);
      setTurns((prev) => [...prev, {
        role: "assistant",
        text: `Staged ${r.staged.count} table${r.staged.count === 1 ? "" : "s"} so far — see the panel on the right. Press “Extract DB” there to publish them as one data source.`,
      }]);
      setSelected(new Set());
    } catch (e: any) {
      setTurns((prev) => [...prev, { role: "assistant", text: `Extraction failed: ${e?.message ?? e}` }]);
    } finally {
      setExtracting(false);
    }
  }, [conn, selected, extracting, conversationId, rememberConv]);

  /** "Extract DB": publish everything staged as ONE source on the build page. */
  const publishDb = useCallback(async () => {
    if (!conversationId || !stagedTables.length || publishing) return;
    setPublishing(true);
    try {
      const r = await wbExtractDb({ conversationId, ...(dbName.trim() ? { label: dbName.trim() } : {}) });
      setStagedTables([]);
      setDbName("");
      setTurns((prev) => [...prev, {
        role: "assistant",
        text: `Published “${r.label}” (${r.tables.length} table${r.tables.length === 1 ? "" : "s"}) as a data source. It now shows on the text2UI start page — select it there, or jump straight in:`,
        extracted: r,
      }]);
      onUseWorkbenchSource?.(r); // register + preselect in the app; stay on the workbench
    } catch (e: any) {
      setTurns((prev) => [...prev, { role: "assistant", text: `Extract DB failed: ${e?.message ?? e}` }]);
    } finally {
      setPublishing(false);
    }
  }, [conversationId, stagedTables, publishing, dbName, onUseWorkbenchSource]);

  return (
    <div className="wb">
      {/* ---- connection bar ---- */}
      <div className="wb-connbar">
        {conn ? (
          <div className="wb-connbar__status">
            <span className="wb-dot wb-dot--ok" />
            <span className="wb-connbar__label">{conn.label}</span>
            <span className="wb-connbar__meta">{conn.allTables.length} tables</span>
            <button type="button" className="wb-btn wb-btn--ghost" onClick={() => { setConn(null); setTurns([]); setConversationId(null); }}>
              Disconnect
            </button>
          </div>
        ) : pgOnly && !pgManual ? (
          <div className="wb-pgform">
            <div className="wb-connbar__form">
              <input
                className="wb-conninput"
                type="password"
                autoComplete="off"
                placeholder="postgres://user:pass@host:5432/db — separate MULTIPLE databases with ';' to connect them as one group (cross-DB joins)"
                value={connStr}
                onChange={(e) => setConnStr(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && connect()}
                disabled={connecting}
              />
              <button type="button" className="wb-btn" onClick={connect} disabled={connecting || !connStr.trim()}>
                {connecting ? "Connecting…" : "Connect"}
              </button>
            </div>
            <button type="button" className="wb-pgform__toggle" onClick={() => { setPgManual(true); setConnError(null); }}>
              Enter fields manually instead (for passwords that must be taken literally)
            </button>
          </div>
        ) : pgOnly ? (
          <div className="wb-pgform">
            <div className="wb-pgform__title">Postgres connection <span className="wb-pgform__hint">fields are sent literally — passwords with @ % # need no escaping</span></div>
            <div className="wb-pgform__grid">
              <input className="wb-conninput" placeholder="host (e.g. 10.222.0.155)" value={pg.host} onChange={(e) => setPg({ ...pg, host: e.target.value })} disabled={connecting} />
              <input className="wb-conninput wb-conninput--sm" placeholder="port" value={String(pg.port ?? "")} onChange={(e) => setPg({ ...pg, port: e.target.value })} disabled={connecting} />
              <input className="wb-conninput" placeholder="database" value={pg.database} onChange={(e) => setPg({ ...pg, database: e.target.value })} disabled={connecting} />
              <input className="wb-conninput" placeholder="user (default: postgres)" value={pg.user ?? ""} onChange={(e) => setPg({ ...pg, user: e.target.value })} disabled={connecting} autoComplete="off" />
              <input className="wb-conninput" type="password" placeholder="password" value={pg.password ?? ""} onChange={(e) => setPg({ ...pg, password: e.target.value })} onKeyDown={(e) => e.key === "Enter" && connect()} disabled={connecting} autoComplete="new-password" />
              <label className="wb-pgform__ssl"><input type="checkbox" checked={!!pg.ssl} onChange={(e) => setPg({ ...pg, ssl: e.target.checked })} disabled={connecting} /> SSL</label>
              <button type="button" className="wb-btn" onClick={connect} disabled={connecting || !pg.host.trim() || !pg.database.trim()}>
                {connecting ? "Connecting…" : "Connect"}
              </button>
            </div>
            <input
              className="wb-conninput wb-pgform__paste"
              type="password"
              autoComplete="off"
              placeholder="…or paste a postgres://user:pass@host:5432/db URI to fill the form (percent-escapes like %40 are decoded)"
              onChange={(e) => { if (e.target.value.trim()) { fillFromUri(e.target.value); e.target.value = ""; } }}
              disabled={connecting}
            />
            <button type="button" className="wb-pgform__toggle" onClick={() => { setPgManual(false); setConnError(null); }}>
              ← Use a connection string instead
            </button>
          </div>
        ) : (
          <div className="wb-connbar__form">
            <input
              className="wb-conninput"
              type="password"
              autoComplete="off"
              placeholder="mysql://user:pass@host:3306/db  or  postgres://user:pass@host:5432/db"
              value={connStr}
              onChange={(e) => setConnStr(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && connect()}
              disabled={connecting}
            />
            <button type="button" className="wb-btn" onClick={connect} disabled={connecting || !connStr.trim()}>
              {connecting ? "Connecting…" : "Connect"}
            </button>
          </div>
        )}
        <label className="wb-connbar__mode">
          <input type="checkbox" checked={liveMode} onChange={(e) => setLiveMode(e.target.checked)} disabled={connecting} />
          <span><strong>Query live</strong> — dashboards read straight from this database on every view; nothing is copied or stored. Leave off to extract a snapshot first (safer for busy production databases).</span>
        </label>
        {connError && <div className="wb-connbar__error">{connError}</div>}
      </div>

      <div className="wb-body">
        {/* ---- schema rail ---- */}
        <aside className="wb-schema">
          <div className="wb-schema__head">
            <span>Tables</span>
            {conn && <span className="wb-schema__count">{conn.allTables.length}</span>}
          </div>
          {conn ? (
            <>
              <div className="wb-schema__list">
                {conn.allTables.map((t) => {
                  const profiled = conn.datasets.find((d) => d.tableName === t.name);
                  return (
                    <label key={t.name} className="wb-table">
                      <input type="checkbox" checked={selected.has(t.name)} onChange={() => toggleTable(t.name)} />
                      <span className="wb-table__name">{t.name}</span>
                      <span className="wb-table__meta">
                        ~{t.approxRows.toLocaleString()} rows{profiled ? ` · ${profiled.profile.columns.length} cols` : ""}
                      </span>
                    </label>
                  );
                })}
              </div>
              <button
                type="button"
                className="wb-btn wb-btn--wide"
                onClick={extractSelected}
                disabled={!selected.size || extracting}
              >
                {extracting ? "Staging…" : `Stage selected${selected.size ? ` (${selected.size})` : ""}`}
              </button>
              <div className="wb-schema__hint">Staged tables collect in the right panel; “Extract DB” publishes them all as one data source.</div>
            </>
          ) : (
            <div className="wb-schema__empty">Connect to a MySQL database to browse its tables here.</div>
          )}
        </aside>

        {/* ---- chat ---- */}
        <section className="wb-chat">
          <div className="wb-thread" ref={threadRef}>
            {!turns.length && (
              <div className="wb-thread__hint">
                {conn
                  ? "Ask anything about the data — “which region sold the most last quarter?”, “show me the orders table”, or “extract orders and customers, we'll build a dashboard from them”."
                  : (pgOnly ? "Connect a Postgres database above to start chatting with it." : "Connect a MySQL or Postgres database above to start chatting with it.")}
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className={`wb-msg wb-msg--${t.role}`}>
                <div className="wb-msg__body">{t.text}</div>

                {t.sql && (
                  <div className="wb-sqlchip">
                    <button
                      type="button"
                      className="wb-sqlchip__toggle"
                      onClick={() => setTurns((prev) => prev.map((x, j) => (j === i ? { ...x, showSql: !x.showSql } : x)))}
                    >
                      {t.showSql ? "Hide SQL" : "View SQL"}
                    </button>
                    {t.showSql && <pre className="wb-sqlchip__code">{t.sql}</pre>}
                  </div>
                )}

                {!!t.rows?.length && !!t.columns?.length && (() => {
                  const viz = classifyResult(t.rows!, t.columns!);
                  return (
                    <>
                      {viz.kind === "kpi" && (
                        <div className="wb-kpi">
                          <div className="wb-kpi__value">{viz.value}</div>
                          <div className="wb-kpi__label">{viz.label}</div>
                        </div>
                      )}
                      {(viz.kind === "bar" || viz.kind === "line") && <MiniChart viz={viz} />}
                      {viz.kind !== "kpi" && (
                        <details className="wb-grid__wrap" open={viz.kind === "table"}>
                          <summary className="wb-grid__summary">
                            {viz.kind === "table" ? `${t.rows!.length}${t.truncated ? "+" : ""} rows` : "show rows"}
                          </summary>
                          <div className="wb-grid">
                            <table>
                              <thead>
                                <tr>{t.columns!.map((c) => <th key={c}>{c}</th>)}</tr>
                              </thead>
                              <tbody>
                                {t.rows!.slice(0, 50).map((r, ri) => (
                                  <tr key={ri}>{t.columns!.map((c) => <td key={c}>{fmtCell(r[c])}</td>)}</tr>
                                ))}
                              </tbody>
                            </table>
                            {(t.truncated || t.rows!.length > 50) && (
                              <div className="wb-grid__more">showing first {Math.min(50, t.rows!.length)} rows</div>
                            )}
                          </div>
                        </details>
                      )}
                    </>
                  );
                })()}

                {t.meta && (
                  <div className="wb-meta">{t.meta.rowsReturned.toLocaleString()} row{t.meta.rowsReturned === 1 ? "" : "s"} · {t.meta.durationMs.toLocaleString()} ms · live</div>
                )}

                {t.extracted && (
                  <button
                    type="button"
                    className="wb-btn wb-btn--source"
                    onClick={() => { onUseWorkbenchSource?.(t.extracted!); navigate("/build"); }}
                  >
                    ◈ Build with “{t.extracted.label}” →
                  </button>
                )}
              </div>
            ))}
            {busy && <div className="wb-msg wb-msg--assistant"><div className="wb-msg__body wb-msg__body--busy">Working…</div></div>}
          </div>

          <div className="wb-composer">
            <input
              className="wb-prompt"
              placeholder={conn ? "Ask about the data, preview a table, or extract tables…" : "Connect a database first"}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
              disabled={!conn || busy}
            />
            <button type="button" className="wb-btn" onClick={send} disabled={!conn || busy || !prompt.trim()}>
              Send
            </button>
          </div>
        </section>

        {/* ---- staged extracts: the "Extract DB" panel ---- */}
        {stagedTables.length > 0 && (
          <aside className="wb-staged">
            <div className="wb-staged__head">
              <span>Extracted tables</span>
              <span className="wb-schema__count">{stagedTables.length}</span>
            </div>
            <div className="wb-staged__list">
              {stagedTables.map((t) => (
                <details key={t.tableName} className="wb-staged__table" open={stagedTables.length <= 3}>
                  <summary>
                    <span className="wb-table__name">{t.tableName}</span>
                    <span className="wb-table__meta">{t.rowCount.toLocaleString()} rows · {t.columns.length} cols</span>
                  </summary>
                  <ul className="wb-staged__cols">
                    {t.columns.map((c) => (
                      <li key={c.name}><span>{c.name}</span><span className="wb-staged__type">{c.type ?? ""}</span></li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
            <div className="wb-staged__foot">
              <input
                className="wb-conninput"
                placeholder="DB name (optional)"
                value={dbName}
                onChange={(e) => setDbName(e.target.value)}
                disabled={publishing}
              />
              <button type="button" className="wb-btn wb-btn--wide" style={{ margin: 0 }} onClick={publishDb} disabled={publishing}>
                {publishing ? "Publishing…" : `Extract DB (${stagedTables.length} table${stagedTables.length === 1 ? "" : "s"})`}
              </button>
              <div className="wb-schema__hint" style={{ padding: "6px 2px 0" }}>
                Publishes everything above as one data source on the text2UI start page.
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
