// ChatPage.tsx — the conversational workspace (Phase 4), with per-turn streaming.
// Layout (see KT §3 + the flowith reference):
//   ┌──────────┬───────────────────────────────────────┬──────┐
//   │  CHAT    │            DASHBOARD CANVAS            │ RAIL │
//   │ (slim)   │  toolbar: title · Preview · Download   │ (52px│
//   │ thread   │           project · App+DB            │  ＋  │
//   │ composer │  stage: <Sandbox> live preview         │  ▦  │  ← Tables flyout
//   └──────────┴───────────────────────────────────────┴──────┘
// Each turn runs two steps: (1) POST /api/orchestrate decides the format and
// returns an enhanced prompt, then (2) the EXISTING streaming build endpoint
// runs, so the live process streams right under that turn. Memory flows via
// conversationId; dashboards refine in place.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  HiOutlineEye, HiOutlineDownload, HiOutlineDatabase,
  HiOutlinePlus, HiOutlineTable, HiOutlineX,
} from "react-icons/hi";
import PromptInput from "../components/PromptInput";
import Sandbox from "../components/Sandbox";
import {
  orchestratePlan, generate, generateStream, generateReport, generatePpt, downloadBase64,
  exportProject, buildDashboard, COLO_PROJECT_ID, REMOTE_DATA, BFF_URL,
  type StreamEvent, type ReportResult, type PptResult,
} from "../api";
import type { Table } from "../lib/datasets";
import type { DashboardSpec } from "../../shared/dashboard-spec";
import type { GeneratedApp, OrchestratorBrief } from "../../shared/types";
import "./ChatPage.css";

interface Props {
  projectId: string;
  tables: Table[];
  initialPrompt: string | null;
  onConsumeInitialPrompt: () => void;
  onFiles: (files: FileList | File[]) => void;
  onRemoveSource: (id: string) => void;
  fileError: string | null;
  onNewProject: () => void;
  onBuildMeta?: (meta: { versionCount: number }) => void;
}

type Phase = "planning" | "building" | "done" | "clarify" | "error";
type Turn = { id: number; prompt: string; phase: Phase; stages: string[]; tail?: string | null; brief?: OrchestratorBrief; assistantText?: string };
type Result =
  | { kind: "dashboard"; app: GeneratedApp; brief?: OrchestratorBrief }
  | { kind: "doc"; mode: "pdf" | "ppt"; filename: string; base64: string; brief?: OrchestratorBrief };

function mainCode(app: GeneratedApp): string {
  const f = app.files.find((x) => /App\.(t|j)sx?$/.test(x.path)) ?? app.files[0];
  return f?.content ?? "";
}
function briefLine(b?: OrchestratorBrief): string {
  if (!b) return "";
  const charts = b.charts?.length ? ` · ${b.charts.length} charts` : "";
  return `${b.title}${b.narrative ? ` — ${b.narrative}` : ""}${charts}`;
}

export default function ChatPage({
  projectId, tables, initialPrompt, onConsumeInitialPrompt,
  onFiles, onRemoveSource, fileError, onNewProject, onBuildMeta,
}: Props) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverUp, setServerUp] = useState<boolean | null>(null);

  // canvas chrome state
  const [fullscreen, setFullscreen] = useState(false);
  const [dashVersion, setDashVersion] = useState(0);  // bumps each build → remounts the Sandbox
  const [spec, setSpec] = useState<DashboardSpec | null>(null);  // persistent spec; edits mutate it
  const [tablesOpen, setTablesOpen] = useState(false);
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [bundling, setBundling] = useState(false);

  const turnSeq = useRef(0);
  const tailBuf = useRef("");
  const builds = useRef(0);
  const startedRef = useRef(false);
  const threadRef = useRef<HTMLDivElement>(null);

  // Surface an unreachable/unhealthy BFF immediately, instead of failing silently.
  useEffect(() => {
    let alive = true;
    fetch(`${BFF_URL}/health`).then((r) => alive && setServerUp(r.ok)).catch(() => alive && setServerUp(false));
    return () => { alive = false; };
  }, []);

  const hasData = tables.length > 0;
  const sandboxTables = useMemo(
    () => tables.map((t) => ({ tableName: t.tableName, rows: t.ingest.rows })),
    [tables],
  );
  const dashApp = result?.kind === "dashboard" ? result.app : null;
  const title = result?.brief?.title ?? (dashApp?.summary || "Untitled project");

  // keep the thread pinned to the latest turn
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const runTurn = useCallback(async (prompt: string) => {
    const id = ++turnSeq.current;
    setError(null);
    setBusy(true);
    setTurns((ts) => [...ts, { id, prompt, phase: "planning", stages: ["Reading your data…"], tail: null }]);
    const append = (line: string) => setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, stages: [...t.stages, line] } : t)));
    const patch = (p: Partial<Turn>) => setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));

    const onStream = (ev: StreamEvent) => {
      switch (ev.type) {
        case "stage":
          if (ev.stage === "planning") append("Planning the layout…");
          else if (ev.stage === "model_call") append("Writing the code…");
          else if (ev.stage === "continuation") append(`Output is long — continuing (${ev.detail ?? ""})…`);
          else if (ev.stage === "validating") { tailBuf.current = ""; patch({ tail: null }); append("Validating & assembling…"); }
          else if (ev.stage === "styling") append("Compiling styles…");
          break;
        case "plan": if (ev.text) append(ev.text); break;
        case "chunk": tailBuf.current = (tailBuf.current + ev.text).slice(-2000); patch({ tail: tailBuf.current.slice(-180) }); break;
        case "error": append(`Error: ${ev.error}`); break;
        default: break; // progress / done
      }
    };

    try {
      const datasets = tables.map((t) => ({ tableName: t.tableName, profile: t.ingest.profile }));
      const editing = result?.kind === "dashboard" ? mainCode(result.app) : undefined;
      const access = REMOTE_DATA ? { dataAccess: "remote" as const } : {};

      // ---- Spec-driven path (pilot: colo data) ----------------------------------
      // The planner emits a typed DashboardSpec; the server compiles it to SQL + a
      // deterministic renderer. We persist the spec and pass it back next turn, so the
      // conversation EDITS one dashboard instead of regenerating JSX each time.
      if (projectId === COLO_PROJECT_ID) {
        append(spec ? "Updating the dashboard spec…" : "Planning the dashboard spec…");
        patch({ phase: "building" });
        const { app, spec: nextSpec, warnings } = await buildDashboard({
          datasets, userPrompt: prompt, ...(spec ? { currentSpec: spec } : {}),
        });
        setSpec(nextSpec);
        setResult({ kind: "dashboard", app });
        setDashVersion((v) => v + 1);
        const note = warnings.length ? ` · ${warnings.length} note${warnings.length === 1 ? "" : "s"}` : "";
        patch({ phase: "done", tail: null, assistantText: (nextSpec.meta.title || "Dashboard ready") + note });
        builds.current += 1;
        onBuildMeta?.({ versionCount: builds.current });
        return;
      }

      // Step 1 — plan. If the orchestrator is down, default to a dashboard build
      // with the raw prompt so we always produce output.
      let plan: Awaited<ReturnType<typeof orchestratePlan>>;
      try {
        plan = await orchestratePlan({ datasets, userPrompt: prompt, ...(conversationId ? { conversationId } : {}), ...access });
        if ((plan as any).conversationId) setConversationId((plan as any).conversationId);
      } catch {
        append("Planner unavailable — building a dashboard directly…");
        plan = { conversationId: conversationId ?? "", outputMode: "dashboard", enhancedPrompt: prompt } as any;
      }

      if ("needsClarification" in plan) { patch({ phase: "clarify", assistantText: plan.question }); return; }

      const mode = plan.outputMode;
      append(`Planned a ${mode}${plan.brief ? ` — ${plan.brief.title}` : ""}.`);
      patch({ phase: "building", brief: plan.brief });

      // Step 2 — build (streamed).
      if (mode === "dashboard") {
        tailBuf.current = "";
        // On EDIT turns, send the user's RAW instruction (not the full planner brief)
        // together with the current code, so the model edits in place surgically
        // instead of regenerating the whole app from a fresh brief.
        const buildPrompt = editing ? prompt : plan.enhancedPrompt;
        const reqBody = { datasets, userPrompt: buildPrompt, ...access, ...(editing ? { currentCode: editing } : {}) };
        let app: GeneratedApp;
        try {
          app = await generateStream(reqBody, onStream);
        } catch (streamErr) {
          const m = (streamErr as Error).message;
          if (!/stream unavailable|stream ended without/i.test(m)) throw streamErr; // real failures surface
          patch({ tail: null });
          append("Live stream unavailable — using standard generation…");
          app = await generate(reqBody);
        }
        setResult({ kind: "dashboard", app, brief: plan.brief });
        setDashVersion((v) => v + 1);   // force the preview to remount with the new app
        patch({ phase: "done", tail: null, assistantText: briefLine(plan.brief) || "Dashboard ready." });
      } else {
        append(`Generating the ${mode.toUpperCase()}…`);
        const docReq = { datasets, userPrompt: plan.enhancedPrompt };
        const r = mode === "pdf" ? await generateReport(docReq) : await generatePpt(docReq);
        const base64 = mode === "pdf" ? (r as ReportResult).pdfBase64 : (r as PptResult).pptxBase64;
        setResult({ kind: "doc", mode, filename: r.filename, base64, brief: plan.brief });
        patch({ phase: "done", assistantText: `Your ${mode.toUpperCase()} is ready.` });
      }
      builds.current += 1;
      onBuildMeta?.({ versionCount: builds.current });
    } catch (e) {
      const raw = (e as Error)?.message || String(e);
      const offline = /failed to fetch|networkerror|load failed|fetch failed|ecconnrefused|connection refused/i.test(raw);
      const friendly = offline
        ? "Can't reach the server at http://localhost:8787. Start the BFF in a separate terminal (npm run dev:bff) and make sure Docker/Postgres is running."
        : raw;
      setError(friendly);
      setServerUp((prev) => (offline ? false : prev));
      patch({ phase: "error", tail: null, assistantText: `⚠ ${friendly}` });
    } finally {
      setBusy(false);
    }
  }, [tables, conversationId, result, onBuildMeta, spec, projectId]);

  // Kick off the first turn from the Landing prompt — in an effect (after
  // render), guarded on data being present.
  useEffect(() => {
    if (initialPrompt && tables.length && !startedRef.current) {
      startedRef.current = true;
      onConsumeInitialPrompt();
      void runTurn(initialPrompt);
    }
  }, [initialPrompt, tables.length, runTurn, onConsumeInitialPrompt]);

  // ---- toolbar actions (only meaningful when a dashboard exists) ----
  const downloadProject = useCallback(async () => {
    if (!dashApp) return;
    setExporting(true);
    try {
      await exportProject({
        app: dashApp,
        tables: sandboxTables,
        appName: dashApp.summary ?? "text2UI app",
        dataMode: "inline",
      });
    } catch (e: any) {
      setError(`Download failed: ${e?.message ?? "unknown error"}`);
    } finally {
      setExporting(false);
    }
  }, [dashApp, sandboxTables]);

  const downloadBundle = useCallback(async () => {
    if (!dashApp) return;
    setBundling(true);
    try {
      await exportProject({
        app: dashApp,
        tables: sandboxTables,
        appName: dashApp.summary ?? "text2UI app",
        bundle: "connected",
        ...(REMOTE_DATA ? { dataMode: "remote" as const, remote: { bffUrl: BFF_URL, projectId } } : {}),
      });
    } catch (e: any) {
      setError(`Bundle download failed: ${e?.message ?? "unknown error"}`);
    } finally {
      setBundling(false);
    }
  }, [dashApp, sandboxTables, projectId]);

  const stage = (
    <>
      {result?.kind === "dashboard" ? (
        <Sandbox
          key={dashVersion}
          app={result.app}
          tables={sandboxTables}
          remote={REMOTE_DATA ? { bffUrl: BFF_URL, projectId } : undefined}
          onRuntimeError={(msg: string) => setError(msg)}
        />
      ) : result?.kind === "doc" ? (
        <div className="cp-doc">
          <div className="cp-doc-icon">{result.mode === "pdf" ? "📄" : "📽️"}</div>
          <div className="cp-doc-title">{result.brief?.title ?? result.filename}</div>
          {result.brief?.narrative && <p className="cp-doc-sub">{result.brief.narrative}</p>}
          <button
            className="cp-doc-download"
            onClick={() => downloadBase64(result.base64, result.filename, result.mode === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation")}
          >
            Download {result.filename}
          </button>
        </div>
      ) : (
        <div className="cp-empty">{busy ? "Working on it…" : "Your dashboard will appear here."}</div>
      )}
    </>
  );

  return (
    <div className="chatpage">
      {/* ============ LEFT: slim chat column ============ */}
      <aside className="cp-chat">
        <div className="cp-chat-head">Chat</div>

        <div className="cp-thread" ref={threadRef}>
          {turns.length === 0 && (
            <div className="cp-thread-hint">Describe what you want to build, then refine it here.</div>
          )}
          {turns.map((t) => {
            const streaming = t.phase === "planning" || t.phase === "building";
            return (
              <div key={t.id} className="cp-turn">
                <div className="cp-msg cp-msg--user">
                  <span className="cp-msg-role">You</span>
                  <div className="cp-msg-body">{t.prompt}</div>
                </div>
                <div className="cp-msg cp-msg--assistant">
                  <span className="cp-msg-role">text2UI</span>
                  <div className="cp-msg-body">
                    {streaming && (
                      <div className="cp-process">
                        {t.stages.map((s, i) => {
                          const active = i === t.stages.length - 1;
                          return (
                            <div key={i} className={`cp-stage ${active ? "cp-stage--active" : "cp-stage--done"}`}>
                              <span className="cp-stage-mark">{active ? "▸" : "✓"}</span> {s}
                            </div>
                          );
                        })}
                        {t.tail && <pre className="cp-tail">{t.tail}</pre>}
                      </div>
                    )}
                    {t.phase === "clarify" && <div className="cp-clarify">{t.assistantText}</div>}
                    {t.phase === "done" && <div>{t.assistantText}</div>}
                    {t.phase === "error" && <div className="cp-err">{t.assistantText}</div>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="cp-composer">
          {(fileError ?? error) && serverUp !== false && (
            <div className="cp-composer-err">{fileError ?? error}</div>
          )}
          <PromptInput
            onSubmit={runTurn}
            onFiles={onFiles}
            variant="dashboard"
            placeholder={result ? "Type to edit or refine — e.g. add a funnel, make it darker, switch to PDF" : "Describe what you want to build"}
            canSubmit={hasData}
            disabled={busy}
            submitLabel={busy ? "Working…" : result ? "Send" : "Build"}
          />
        </div>
      </aside>

      {/* ============ CENTER: dashboard canvas ============ */}
      <main className="cp-canvas">
        {serverUp === false && (
          <div className="cp-banner">
            ⚠ Can't reach the backend at {BFF_URL}. Start it in a separate terminal:
            <code> npm run dev:bff </code> (and make sure Docker/Postgres is running).
          </div>
        )}

        <div className="cp-toolbar">
          <div className="cp-toolbar-title" title={title}>{title}</div>
          <div className="cp-toolbar-actions">
            <button className="cp-tool-btn" onClick={() => setFullscreen(true)} disabled={!dashApp} title="Open a full-screen preview">
              <HiOutlineEye /> <span>Preview</span>
            </button>
            <button className="cp-tool-btn" onClick={downloadProject} disabled={!dashApp || exporting} title="Download a runnable Vite project (data inlined)">
              <HiOutlineDownload /> <span>{exporting ? "Preparing…" : "Download project"}</span>
            </button>
            <button className="cp-tool-btn" onClick={downloadBundle} disabled={!dashApp || bundling} title="App + portable database dump + read-only query server">
              <HiOutlineDatabase /> <span>{bundling ? "Preparing…" : "App + DB"}</span>
            </button>
          </div>
        </div>

        <div className="cp-stage">{stage}</div>
      </main>

      {/* ============ RIGHT: very slim rail ============ */}
      <nav className="cp-rail">
        <button className="cp-rail-btn" onClick={onNewProject} title="New project" aria-label="New project">
          <HiOutlinePlus />
        </button>
        <button
          className={`cp-rail-btn ${tablesOpen ? "cp-rail-btn--on" : ""}`}
          onClick={() => setTablesOpen((v) => !v)}
          title="Tables"
          aria-label="Tables"
          aria-expanded={tablesOpen}
        >
          <HiOutlineTable />
        </button>

        {tablesOpen && (
          <div className="cp-flyout" role="dialog" aria-label="Tables">
            <div className="cp-flyout-head">
              <span>Tables</span>
              <button className="cp-flyout-x" onClick={() => setTablesOpen(false)} aria-label="Close"><HiOutlineX /></button>
            </div>
            {tables.length === 0 ? (
              <div className="cp-flyout-empty">No tables loaded.</div>
            ) : (
              <ul className="cp-flyout-list">
                {tables.map((t) => {
                  const open = expandedTable === t.tableName;
                  const cols = t.ingest.profile.columns;
                  const sample = t.ingest.profile.sampleRows?.slice(0, 3) ?? [];
                  return (
                    <li key={t.tableName} className="cp-flyout-item">
                      <button
                        className="cp-flyout-row"
                        onClick={() => setExpandedTable(open ? null : t.tableName)}
                        aria-expanded={open}
                      >
                        <span className="cp-flyout-name">{t.tableName}</span>
                        <span className="cp-flyout-count">{t.ingest.profile.rowCount.toLocaleString()} rows</span>
                      </button>
                      {open && (
                        <div className="cp-flyout-detail">
                          <div className="cp-flyout-cols">
                            {cols.map((c) => (
                              <span key={c.name} className="cp-flyout-col" title={c.type}>
                                {c.name}<em>{c.type}</em>
                              </span>
                            ))}
                          </div>
                          {sample.length > 0 && (
                            <div className="cp-flyout-sample">
                              <table>
                                <thead>
                                  <tr>{cols.slice(0, 4).map((c) => <th key={c.name}>{c.name}</th>)}</tr>
                                </thead>
                                <tbody>
                                  {sample.map((r, i) => (
                                    <tr key={i}>
                                      {cols.slice(0, 4).map((c) => <td key={c.name}>{String((r as any)[c.name] ?? "")}</td>)}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </nav>

      {/* ============ full-screen preview overlay ============ */}
      {fullscreen && dashApp && (
        <div className="cp-overlay">
          <div className="cp-overlay-bar">
            <span className="cp-overlay-title">{title}</span>
            <button className="cp-tool-btn" onClick={() => setFullscreen(false)}><HiOutlineX /> <span>Close</span></button>
          </div>
          <div className="cp-overlay-stage">
            <Sandbox
              key={`fs-${dashVersion}`}
              app={dashApp}
              tables={sandboxTables}
              remote={REMOTE_DATA ? { bffUrl: BFF_URL, projectId } : undefined}
              onRuntimeError={(msg: string) => setError(msg)}
            />
          </div>
        </div>
      )}
    </div>
  );
}