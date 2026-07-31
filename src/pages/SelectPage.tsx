// SelectPage.tsx — "pick the tables that matter", the step between pasting a
// connection string and building a UI.
//
// The problem it solves: point text2SQL at a 400-table production database and
// the planner has to guess which six tables the question is about. Here the
// user narrows the catalog first — by clicking, or by talking to an assistant
// ("select 1, 2 and 7", "add everything starting with sales_", "drop the audit
// tables", "only orders and customers"). The chat and the checkboxes edit ONE
// server-side selection, so they can never drift apart.
//
// Layout (as specified):
//   left    every table in the database, numbered and searchable
//   middle  the clicked table's columns (profiled on demand for big schemas)
//   right   the conversation + prompt box
//   header  "Continue to text2UI →", visible at ALL times
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import ChatMarkdown from "../components/ChatMarkdown";
import {
  wbConnect, wbCatalog, wbProfile, wbSelect, wbSelectStream, wbSetSelection, wbGetSelection,
  wbCommitSelection, wbSchema,
  type WbCatalogTable, type WbTableDetail, type WbExtracted,
} from "../workbench-api";
import "./SelectPage.css";

const CONV_KEY = "t2ui:sel:conv";
const CONN_KEY = "t2ui:sel:conn";

interface Turn { role: "user" | "assistant"; text: string }

interface SelectPageProps {
  /** Same callback the workbench uses: register the source + preselect it. */
  onUseWorkbenchSource?: (src: WbExtracted, buildPrompt?: string) => void;
}

const fmtCell = (v: unknown): string => {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 3 });
  const s = String(v);
  return s.length > 28 ? s.slice(0, 27) + "…" : s;
};

export default function SelectPage({ onUseWorkbenchSource }: SelectPageProps) {
  const navigate = useNavigate();

  const [connStr, setConnStr] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [connLabel, setConnLabel] = useState("");
  const [connError, setConnError] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<WbCatalogTable[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  // Per-table column narrowing. A table absent here stores EVERY column, which
  // is the default and the common case — only narrowed tables are tracked.
  const [colSel, setColSel] = useState<Record<string, string[]>>({});
  const [active, setActive] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, WbTableDetail>>({});
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [committing, setCommitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const threadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  const remember = useCallback((cid: string) => {
    setConversationId(cid);
    try { sessionStorage.setItem(CONV_KEY, cid); } catch { /* private mode */ }
  }, []);

  const selectedSet = useMemo(() => new Set(selection), [selection]);

  // ---- rehydrate: a reload keeps the connection, the selection AND the chat ----
  useEffect(() => {
    const savedConn = (() => { try { return sessionStorage.getItem(CONN_KEY); } catch { return null; } })();
    const savedConv = (() => { try { return sessionStorage.getItem(CONV_KEY); } catch { return null; } })();
    if (savedConn) {
      wbSchema(savedConn)
        .then(async (c) => {
          setConnectionId(c.connectionId);
          setConnLabel(c.label);
          const cat = await wbCatalog(c.connectionId);
          setCatalog(cat.tables);
        })
        .catch(() => { try { sessionStorage.removeItem(CONN_KEY); } catch { /* ignore */ } });
    }
    if (savedConv) {
      wbGetSelection(savedConv)
        .then((r) => {
          setConversationId(savedConv);
          setSelection(r.selection);
          setColSel(r.columns ?? {});
          setTurns(
            r.turns
              .filter((t) => t.role === "user" || t.role === "assistant")
              .map((t) => ({ role: t.role as "user" | "assistant", text: t.content })),
          );
        })
        .catch(() => { /* stale conversation — a fresh one starts on the first turn */ });
    }
  }, []);

  // ---- connect ----------------------------------------------------------------
  const connect = useCallback(async () => {
    const raw = connStr.trim();
    if (!raw || connecting) return;
    setConnecting(true);
    setConnError(null);
    try {
      // Several strings (one per line, or ';'-separated) connect as ONE group,
      // exactly like the workbench — the catalog then spans every database.
      const lines = raw.split(/[;\n]+/).map((l) => l.trim()).filter(Boolean);
      // fast: names only. Columns arrive when a table is clicked, so a 12k-table
      // server doesn't pay for sampling and catalog metadata it may never use.
      let c = await wbConnect(lines[0], undefined, "snapshot", { fast: true });
      for (const line of lines.slice(1)) c = await wbConnect(line, c.connectionId, undefined, { fast: true });
      setConnectionId(c.connectionId);
      setConnLabel(c.label);
      setConnStr(""); // credentials never linger in component state
      try { sessionStorage.setItem(CONN_KEY, c.connectionId); } catch { /* private mode */ }
      const cat = await wbCatalog(c.connectionId);
      setCatalog(cat.tables);
      setSelection([]);
      setColSel({});
      setActive(null);
      setDetails({});
      setTurns([{
        role: "assistant",
        text: `Connected to ${c.label} — ${cat.tables.length} table${cat.tables.length === 1 ? "" : "s"}. Tick them on the left, or just tell me what you're building and I'll pick.`,
      }]);
    } catch (e: any) {
      setConnError(e?.message ?? "connection failed");
    } finally {
      setConnecting(false);
    }
  }, [connStr, connecting]);

  const disconnect = useCallback(() => {
    setConnectionId(null);
    setCatalog([]);
    setSelection([]);
    setActive(null);
    setDetails({});
    setConnLabel("");
    try { sessionStorage.removeItem(CONN_KEY); } catch { /* ignore */ }
  }, []);

  // ---- columns for the middle panel (lazy for unprofiled tables) --------------
  const openTable = useCallback(async (name: string) => {
    setActive(name);
    setDetailError(null);
    if (details[name] || !connectionId) return;
    setDetailBusy(true);
    try {
      const r = await wbProfile(connectionId, [name]);
      setDetails((prev) => {
        const next = { ...prev };
        for (const t of r.tables) next[t.tableName] = t;
        return next;
      });
      setCatalog((prev) => prev.map((t) => (t.name === name ? { ...t, profiled: true, columnCount: r.tables[0]?.columns.length ?? t.columnCount } : t)));
    } catch (e: any) {
      setDetailError(e?.message ?? "couldn't read that table's schema");
    } finally {
      setDetailBusy(false);
    }
  }, [connectionId, details]);

  // ---- checkbox <-> server selection ------------------------------------------
  const pushSelection = useCallback(async (tables: string[], columns?: Record<string, string[]>) => {
    if (!connectionId) return;
    setSelection(tables); // optimistic: the rail must feel instant
    if (columns) setColSel(columns);
    try {
      const r = await wbSetSelection({
        connectionId, tables,
        ...(columns ? { columns } : {}),
        ...(conversationId ? { conversationId } : {}),
      });
      remember(r.conversationId);
      setSelection(r.selection);
      setColSel(r.columns ?? {});
    } catch (e: any) {
      setNotice(e?.message ?? "couldn't save that selection");
    }
  }, [connectionId, conversationId, remember]);

  const toggle = useCallback((name: string) => {
    const next = selectedSet.has(name) ? selection.filter((t) => t !== name) : [...selection, name];
    // Keep catalog order so the chat's summaries and the rail always agree.
    const order = new Map(catalog.map((t, i) => [t.name, i] as const));
    void pushSelection(next.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)));
  }, [selection, selectedSet, catalog, pushSelection]);

  // ---- the selection conversation ---------------------------------------------
  const send = useCallback(async () => {
    const p = prompt.trim();
    if (!p || !connectionId || busy) return;
    setPrompt("");
    setTurns((prev) => [...prev, { role: "user", text: p }]);
    setBusy(true);
    try {
      const req = { connectionId, prompt: p, ...(conversationId ? { conversationId } : {}) };
      try {
        // Stream first. Tokens append to a single assistant turn, which renders
        // through ChatMarkdown as it grows — partial markdown is expected and
        // handled by the renderer.
        let acc = "";
        let opened = false;
        const r = await wbSelectStream(req, (ev: any) => {
          if (ev.type === "token") {
            acc += ev.text;
            setTurns((prev) => {
              if (!opened) { opened = true; return [...prev, { role: "assistant", text: acc }]; }
              const copy = prev.slice();
              copy[copy.length - 1] = { role: "assistant", text: acc };
              return copy;
            });
          } else if (ev.type === "selection") {
            // The rail must not wait for the prose to finish.
            if (Array.isArray(ev.selection)) setSelection(ev.selection);
            if (ev.columns) setColSel(ev.columns);
            if (ev.focus) void openTable(ev.focus);
          }
        });
        remember(r.conversationId);
        // `done` is authoritative: a withheld need_more round means `acc` can be
        // shorter than the real reply.
        const finalText = r.reply || acc;
        setTurns((prev) => {
          if (!opened) return [...prev, { role: "assistant", text: finalText }];
          const copy = prev.slice();
          copy[copy.length - 1] = { role: "assistant", text: finalText };
          return copy;
        });
      } catch {
        // A dead stream must not cost the user their turn — replay as one shot.
        const r = await wbSelect(req);
        remember(r.conversationId);
        setSelection(r.selection);
        if (r.columns) setColSel(r.columns);
        setTurns((prev) => [...prev, { role: "assistant", text: r.reply }]);
        if (r.focus) void openTable(r.focus);
      }
    } catch (e: any) {
      setTurns((prev) => [...prev, { role: "assistant", text: `Something went wrong: ${e?.message ?? e}` }]);
    } finally {
      setBusy(false);
    }
  }, [prompt, connectionId, busy, conversationId, remember, openTable]);

  // ---- the always-visible handoff ---------------------------------------------
  const continueToBuilder = useCallback(async () => {
    if (committing) return;
    if (!connectionId) { setNotice("Connect a database first — paste a connection string above."); return; }
    if (!selection.length) { setNotice("Pick at least one table first — click it in the list, or say “select 1, 2, 3”."); return; }
    setCommitting(true);
    setNotice(null);
    try {
      const src = await wbCommitSelection({
        connectionId,
        tables: selection,
        ...(conversationId ? { conversationId } : {}),
      });
      onUseWorkbenchSource?.(src);
      try { sessionStorage.removeItem(CONV_KEY); } catch { /* ignore */ }
      navigate("/");
    } catch (e: any) {
      setNotice(e?.message ?? "couldn't prepare those tables");
    } finally {
      setCommitting(false);
    }
  }, [committing, connectionId, selection, conversationId, onUseWorkbenchSource, navigate]);

  /** Columns stored for a table. Absent from colSel = all of them. */
  const colsFor = useCallback((table: string): string[] | null => colSel[table]?.length ? colSel[table] : null, [colSel]);

  const toggleColumn = useCallback((table: string, column: string) => {
    const all = details[table]?.columns.map((c) => c.name) ?? [];
    const cur = colSel[table]?.length ? colSel[table] : all;
    const next = cur.includes(column) ? cur.filter((c) => c !== column) : [...cur, column];
    if (!next.length) { setNotice("Keep at least one column — deselect the whole table instead."); return; }
    // Back to everything? Drop the entry rather than storing a full list, so a
    // later schema change doesn't silently pin an old column set.
    const narrowed = next.length === all.length ? {} : { [table]: all.filter((c) => next.includes(c)) };
    const rest = { ...colSel };
    delete rest[table];
    const merged = { ...rest, ...narrowed };
    // Narrowing a table implies wanting it.
    const tables = selection.includes(table) ? selection : [...selection, table];
    const order = new Map(catalog.map((t, i) => [t.name, i] as const));
    void pushSelection(tables.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)), merged);
  }, [colSel, details, selection, catalog, pushSelection]);

  const setAllColumns = useCallback((table: string, on: boolean) => {
    const all = details[table]?.columns.map((c) => c.name) ?? [];
    const rest = { ...colSel };
    delete rest[table];
    // "none" would store an empty table; the honest reading is "all".
    void pushSelection(selection, on || !all.length ? rest : { ...rest, [table]: [all[0]] });
  }, [colSel, details, selection, pushSelection]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((t) => t.name.toLowerCase().includes(q) || String(t.index) === q);
  }, [catalog, filter]);

  const detail = active ? details[active] : undefined;

  return (
    <div className="sel">
      {/* ---- header: connection + the always-present handoff ---- */}
      <header className="sel-top">
        <div className="sel-top__left">
          {connectionId ? (
            <div className="sel-conn">
              <span className="sel-dot" />
              <span className="sel-conn__label">{connLabel}</span>
              <span className="sel-conn__meta">{catalog.length} tables · {selection.length} selected</span>
              <button type="button" className="sel-btn sel-btn--ghost" onClick={disconnect}>Disconnect</button>
            </div>
          ) : (
            <div className="sel-connform">
              <input
                className="sel-input sel-input--mono"
                type="password"
                autoComplete="off"
                placeholder="postgres://user:pass@host:5432/db   or   mysql://user:pass@host:3306/db"
                value={connStr}
                onChange={(e) => setConnStr(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && connect()}
                disabled={connecting}
              />
              <button type="button" className="sel-btn" onClick={connect} disabled={connecting || !connStr.trim()}>
                {connecting ? "Connecting…" : "Connect"}
              </button>
            </div>
          )}
        </div>

        {/* Rendered at all times, connected or not — the user can leave whenever. */}
        <button
          type="button"
          className="sel-btn sel-btn--go"
          onClick={continueToBuilder}
          disabled={committing}
          title="Carry the selected tables into the text2UI builder"
        >
          {committing ? "Preparing…" : `Continue to text2UI${selection.length ? ` (${selection.length})` : ""} →`}
        </button>
      </header>

      {connError && <div className="sel-error">{connError}</div>}
      {notice && (
        <div className="sel-notice" onClick={() => setNotice(null)} role="status">
          {notice}<span className="sel-notice__x">dismiss</span>
        </div>
      )}

      <div className="sel-body">
        {/* ---- left: every table, numbered ---- */}
        <aside className="sel-rail">
          <div className="sel-rail__head">
            <span>Tables</span>
            <span className="sel-count">{catalog.length}</span>
          </div>
          {connectionId ? (
            <>
              <input
                className="sel-input sel-input--search"
                placeholder="Filter tables…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <div className="sel-rail__list">
                {shown.map((t) => (
                  <div
                    key={t.name}
                    className={`sel-row${active === t.name ? " sel-row--active" : ""}${selectedSet.has(t.name) ? " sel-row--picked" : ""}`}
                    onClick={() => openTable(t.name)}
                  >
                    <input
                      type="checkbox"
                      checked={selectedSet.has(t.name)}
                      onChange={() => toggle(t.name)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`select ${t.name}`}
                    />
                    <span className="sel-row__n">{t.index}</span>
                    <span className="sel-row__name">{t.name}</span>
                  </div>
                ))}
                {!shown.length && <div className="sel-empty">No table matches “{filter}”.</div>}
              </div>
            </>
          ) : (
            <div className="sel-empty">Connect a database to browse its tables.</div>
          )}
        </aside>

        {/* ---- middle: the clicked table's columns ---- */}
        <section className="sel-detail">
          {!active && (
            <div className="sel-empty sel-empty--center">
              {connectionId ? "Click a table on the left to see its columns." : "No database connected yet."}
            </div>
          )}
          {active && (
            <>
              <div className="sel-detail__head">
                <div>
                  <h2 className="sel-detail__title">{active}</h2>
                  {detail && (
                    <div className="sel-detail__meta">
                      {colsFor(active)
                        ? `${colsFor(active)!.length} of ${detail.columns.length} columns stored`
                        : `${detail.columns.length} columns`}
                      {detail.rowCount > 0 ? ` · ~${detail.rowCount.toLocaleString()} rows` : ""}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className={`sel-btn ${selectedSet.has(active) ? "sel-btn--ghost" : ""}`}
                  onClick={() => toggle(active)}
                >
                  {selectedSet.has(active) ? "Deselect" : "Select this table"}
                </button>
              </div>

              {detailBusy && !detail && <div className="sel-empty">Reading the schema…</div>}
              {detailError && <div className="sel-error">{detailError}</div>}

              {detail && (
                <div className="sel-cols">
                  <div className="sel-cols__bar">
                    <span>Columns to store</span>
                    <button type="button" className="sel-linkbtn" onClick={() => setAllColumns(active, true)}>select all</button>
                  </div>
                  <table>
                    <thead>
                      <tr>
                        <th className="sel-cols__pick"> </th>
                        <th>Column</th><th>Type</th><th>Null</th><th>Sample values</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.columns.map((c) => {
                        const on = !colsFor(active) || colsFor(active)!.includes(c.name);
                        return (
                        <tr key={c.name} className={on ? "" : "sel-cols__off"}>
                          <td className="sel-cols__pick">
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => toggleColumn(active, c.name)}
                              aria-label={`store column ${c.name}`}
                            />
                          </td>
                          <td className="sel-cols__name">{c.name}</td>
                          <td className="sel-cols__type">{c.type ?? "—"}</td>
                          <td>{c.nullable === null ? "—" : c.nullable ? "yes" : "no"}</td>
                          <td className="sel-cols__sample">{c.sampleValues.map(fmtCell).join(", ") || "—"}</td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
        {/* ---- right: the conversation ---- */}
        <section className="sel-chat">
        {!!selection.length && (
          <div className="sel-chips">
            <span className="sel-chips__label">Selected</span>
            {selection.map((t) => (
              <button key={t} type="button" className="sel-chip" onClick={() => toggle(t)} title="Remove from selection">
                {t}
                {colSel[t]?.length ? <span className="sel-chip__cols">{colSel[t].length} cols</span> : null}
                <span className="sel-chip__x">×</span>
              </button>
            ))}
            <button type="button" className="sel-chip sel-chip--clear" onClick={() => pushSelection([])}>clear all</button>
          </div>
        )}

        <div className="sel-thread" ref={threadRef}>
          {!turns.length && (
            <div className="sel-hint">
              Ask for what you need and I'll pick the tables: <em>“select 1, 2 and 7”</em> ·
              <em>“everything I'd need for a churn dashboard”</em> · <em>“drop the audit stuff”</em> ·
              <em>“which of these has customer emails?”</em>
            </div>
          )}
          {turns.map((t, i) => (
            // Assistant replies are interpretive markdown; user prompts stay plain
            // text. sel-msg--md resets the base .sel-msg `white-space: pre-wrap`,
            // which would otherwise double-space every rendered block.
            t.role === "assistant"
              ? (
                <div key={i} className="sel-msg sel-msg--assistant sel-msg--md">
                  <ChatMarkdown text={t.text ?? ""} />
                </div>
              )
              : <div key={i} className={`sel-msg sel-msg--${t.role}`}>{t.text}</div>
          ))}
          {busy && <div className="sel-msg sel-msg--assistant sel-msg--busy">Working…</div>}
        </div>

        <div className="sel-composer">
          <input
            className="sel-input"
            placeholder={connectionId ? "Select tables in your own words…" : "Connect a database first"}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
            disabled={!connectionId || busy}
          />
          <button type="button" className="sel-btn" onClick={send} disabled={!connectionId || busy || !prompt.trim()}>
            Send
          </button>
        </div>
        </section>
      </div>
    </div>
  );
}
