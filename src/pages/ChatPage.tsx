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
import ChatMarkdown from "../components/ChatMarkdown";
import {
  orchestratePlan, generate, generateStream, generateReport, generatePpt, downloadBase64,
  exportProject, buildDashboard, buildDeck, gateTurn, uploadDatasets, COLO_PROJECT_ID, REMOTE_DATA, BFF_URL,
  type StreamEvent, type ReportResult, type PptResult,
} from "../api";
import { sourceChat } from "../workbench-api";
import DeckPreview from "../components/DeckPreview";
import type { Table } from "../lib/datasets";
import type { DashboardSpec } from "../../shared/dashboard-spec";
import type { DeckSpec, CompiledDeck } from "../../shared/deck-spec";
import type { GeneratedApp, OrchestratorBrief } from "../../shared/types";
import "./ChatPage.css";

interface Props {
  projectId: string;
  tables: Table[];
  initialPrompt: string | null;
  /** al1: analyst-loop evidence riding a workbench handoff (first build only). */
  initialDirective?: string | null;
  /** Join semantics for the current source. Conversation-scoped and included on
   *  EVERY turn — unlike initialDirective, which is spent on the first build. */
  combinedSchema?: string | null;
  onConsumeInitialPrompt: () => void;
  onFiles: (files: FileList | File[]) => void;
  onRemoveSource: (id: string) => void;
  fileError: string | null;
  onNewProject: () => void;
  onBuildMeta?: (meta: { versionCount: number }) => void;
}

type Phase = "planning" | "building" | "done" | "clarify" | "error";
type Turn = { id: number; prompt: string; phase: Phase; stages: string[]; tail?: string | null; brief?: OrchestratorBrief; assistantText?: string; hydrated?: boolean };
type Result =
  | { kind: "dashboard"; app: GeneratedApp; brief?: OrchestratorBrief }
  | { kind: "deck"; compiled: CompiledDeck; pptxBase64: string; filename: string }
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

/** Detect an EXPLICIT request to switch artifact type (not a normal refinement). Requires a
 *  switch verb + a target noun, so "make the bars bigger" never trips it. */
function detectArtifactSwitch(prompt: string): "ppt" | "pdf" | "dashboard" | null {
  const s = prompt.toLowerCase();
  if (!/\b(turn|make|convert|switch|change|export|rebuild|recreate|render)\b/.test(s)) return null;
  if (/\b(pdf|report)\b/.test(s)) return "pdf";
  if (/\b(deck|slides?|powerpoint|presentation|ppt)\b/.test(s)) return "ppt";
  if (/\b(dashboard|interactive app|web app)\b/.test(s)) return "dashboard";
  return null;
}

export default function ChatPage({
  projectId, tables, initialPrompt, initialDirective = null, combinedSchema = null, onConsumeInitialPrompt,
  onFiles, onRemoveSource, fileError, onNewProject, onBuildMeta,
}: Props) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Stale-closure guard: the FIRST turn receives a fresh conversationId from
  // orchestrate/gate and must use it for the build call IN THE SAME closure —
  // React state won't have committed yet. Reading only the state variable meant
  // the first build posted without a conversationId, so version 1 was never
  // recorded and the first "undo" found nothing beneath it.
  const convIdRef = useRef<string | null>(null);
  const adoptConvId = (id?: string | null) => { if (id) { convIdRef.current = id; setConversationId(id); } };
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverUp, setServerUp] = useState<boolean | null>(null);

  // canvas chrome state
  const [fullscreen, setFullscreen] = useState(false);
  const [dashVersion, setDashVersion] = useState(0);  // bumps each build → remounts the Sandbox
  const [spec, setSpec] = useState<DashboardSpec | null>(null);  // persistent spec; edits mutate it
  const [deckSpec, setDeckSpec] = useState<DeckSpec | null>(null);  // persistent deck spec for ppt edits
  const [deckId, setDeckId] = useState<string | null>(null);        // server-side Spec Store id
  // Uploaded reports/logos for the deck. Kept for the life of the deck and re-sent each turn
  // (the server rebuilds datasets per request; asset ids are content-hashed so they resolve).
  const [deckDocs, setDeckDocs] = useState<{ name: string; base64: string }[]>([]);
  const [deckImages, setDeckImages] = useState<{ name: string; base64: string }[]>([]);
  const [tablesOpen, setTablesOpen] = useState(false);
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [bundling, setBundling] = useState(false);

  // Widget selection from the live preview — the "this" of the next edit prompt.
  // The generated app posts t2ui.featureSelected on any widget click (id + title);
  // holding it here is what turns the chat into a direct-manipulation editor:
  // click a chart, type "make this a pie", done.
  const [selectedWidget, setSelectedWidget] = useState<{ id?: string; title?: string; kind?: string } | null>(null);
  // GHOST-SELECTION GUARD: after every build/edit, re-validate the selection
  // against the new spec — clear it if the widget is gone (an edit removed it),
  // refresh the chip's title/kind if the widget changed. The chip can never
  // point at a widget that no longer exists.
  useEffect(() => {
    if (!selectedWidget?.id || !spec) return;
    const live = (spec.sections ?? []).flatMap((s: any) => s.widgets ?? []).find((w: any) => w.id === selectedWidget.id);
    if (!live) { setSelectedWidget(null); return; }
    if (live.title !== selectedWidget.title || live.kind !== selectedWidget.kind) {
      setSelectedWidget({ id: live.id, title: live.title, kind: live.kind });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const data = e.data as any;
      if (!data || data.type !== "t2ui.featureSelected" || !data.payload) return;
      const p = data.payload;
      // Toggle-off / Escape in the preview clears the chip too — one state,
      // never two truths.
      if (p.cleared) { setSelectedWidget(null); return; }
      if (p.id || p.title) setSelectedWidget({ id: p.id, title: p.title, kind: p.kind ?? p.type });
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const turnSeq = useRef(0);
  const tailBuf = useRef("");
  // The first-turn orchestrator brief, carried into the spec-dashboard build so
  // its palette/design direction reach the spec planner (the missing junction).
  const lastBrief = useRef<unknown | null>(null);
  // al1: evidence captured before the initial prompt is consumed; spent on the
  // FIRST successful dashboard build, then cleared (edits use currentSpec).
  const pendingDirective = useRef<string | null>(null);
  /**
   * Two directives, spent DIFFERENTLY on purpose.
   *
   * pendingDirective (analyst findings) is a one-off observation about the data
   * as it looked at build time — right to spend on the first build and then drop.
   *
   * combinedSchema (how the tables relate) is structural. A user editing the
   * dashboard three turns later still needs to know that orders joins customers
   * on customer_ref, so it rides EVERY build and edit turn and is never cleared.
   */
  const combinedRef = useRef<string | null>(null);
  useEffect(() => { combinedRef.current = combinedSchema ?? null; }, [combinedSchema]);
  const directiveFor = (isFirstBuild: boolean): string | null => {
    const parts: string[] = [];
    if (isFirstBuild && pendingDirective.current) parts.push(pendingDirective.current);
    if (combinedRef.current) parts.push(combinedRef.current);
    return parts.length ? parts.join("\n\n") : null;
  };
  const builds = useRef(0);
  const startedRef = useRef(false);
  const threadRef = useRef<HTMLDivElement>(null);

  // Surface an unreachable/unhealthy BFF immediately, instead of failing silently.
  useEffect(() => {
    let alive = true;
    fetch(`${BFF_URL}/health`).then((r) => alive && setServerUp(r.ok)).catch(() => alive && setServerUp(false));
    return () => { alive = false; };
  }, []);

  // ---- Session persistence: survive a page reload, but NOT a fresh entry -------
  // Snapshot the working state per project. The subtlety: colo's projectId is constant, so
  // we must not blindly restore on every mount — a reload of a live chat should restore, but
  // coming back to the project fresh should start clean. We distinguish them with a
  // beforeunload marker: it's only set if the chat was on screen when the page unloaded (a
  // reload). Navigating back to the first screen (no page unload) never sets it.
  const SESSION_KEY = `t2ui:session:${projectId}`;
  const RELOAD_FLAG = "t2ui:reload-in-chat";
  const restoredRef = useRef(false);

  useEffect(() => {
    const mark = () => { try { sessionStorage.setItem(RELOAD_FLAG, "1"); } catch {} };
    window.addEventListener("beforeunload", mark);
    return () => window.removeEventListener("beforeunload", mark);
  }, []);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    let wasReload = false;
    try { wasReload = sessionStorage.getItem(RELOAD_FLAG) === "1"; sessionStorage.removeItem(RELOAD_FLAG); } catch {}
    if (!wasReload) {
      // Fresh entry into the project: DURABLE PROJECTS — restore the saved
      // dashboard + chat link from the SERVER (the local snapshot is only for
      // reloads). The board renders deterministically from the stored spec;
      // live numbers refresh once the data source is reconnected.
      try { localStorage.removeItem(SESSION_KEY); } catch {}
      (async () => {
        try {
          const r = await fetch(`${BFF_URL}/api/project/${encodeURIComponent(projectId)}/state`);
          if (!r.ok) return;
          const st = await r.json();
          if (!st?.spec) return;
          if (st.conversationId) adoptConvId(st.conversationId);
          setSpec(st.spec);
          if (st.app) { setResult({ kind: "dashboard", app: st.app }); setDashVersion((v) => v + 1); }
          const n = Array.isArray(st.chat) ? st.chat.length : 0;
          setTurns([{ id: Date.now(), prompt: "(project reopened)", phase: "done", stages: [], hydrated: true,
            assistantText: `Restored your saved dashboard${n ? ` — ${n} earlier chat messages are remembered for edits` : ""}. If this project uses a live database, reconnect it to refresh the numbers; everything else works right away.` } as any]);
        } catch { /* no saved state / server unreachable — start clean */ }
      })();
      return;
    }
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.conversationId) adoptConvId(s.conversationId);
      if (s.deckId) setDeckId(s.deckId);
      if (s.deckSpec) setDeckSpec(s.deckSpec);
      if (s.spec) setSpec(s.spec);
      if (Array.isArray(s.turns) && s.turns.length) {
        // Restored turns are history: render them instantly (no streaming), and settle any
        // turn that was mid-build when the snapshot was taken.
        setTurns(s.turns.map((t: Turn) => ({
          ...t,
          hydrated: true,
          phase: (t.phase === "planning" || t.phase === "building") ? "done" : t.phase,
        })));
      }
      if (s.result) { setResult(s.result); setDashVersion((v) => v + 1); }
    } catch { /* ignore corrupt/oversized snapshot */ }
  }, [SESSION_KEY]);

  useEffect(() => {
    // Only persist once there's something worth restoring — avoids clobbering a saved
    // session with the empty initial state on first render.
    if (!result && turns.length === 0 && !deckId) return;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ conversationId, deckId, deckSpec, spec, turns, result }));
    } catch { /* quota exceeded — skip persisting this turn */ }
  }, [SESSION_KEY, conversationId, deckId, deckSpec, spec, turns, result]);

  const hasData = tables.length > 0;
  const sandboxTables = useMemo(
    () => tables.map((t) => ({ tableName: t.tableName, rows: t.ingest.rows })),
    [tables],
  );
  const dashApp = result?.kind === "dashboard" ? result.app : null;
  const brief = result && (result.kind === "dashboard" || result.kind === "doc") ? result.brief : undefined;
  const title =
    brief?.title ??
    (result?.kind === "deck" ? result.compiled.meta.title : dashApp?.summary) ??
    "Untitled project";

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
      // Server-side sources (colo + workbench extracts) keep their data on the BFF —
      // the client never ships rows; runtime queries route by projectId.
      const isColo = projectId === COLO_PROJECT_ID || projectId.startsWith("wb_") || projectId.startsWith("live_");
      // For uploaded data, send the rows so the deck pipeline can resolve charts server-side.
      const rows = isColo ? undefined : tables.map((t) => ({ tableName: t.tableName, rows: t.ingest.rows }));

      // Remote-data mode: the sandbox queries /api/query, so the rows must live
      // on the server BEFORE the app mounts. Colo/wb/live sources are already there.
      if (REMOTE_DATA && !isColo && tables.length) {
        append("Syncing your data to the server…");
        await uploadDatasets(projectId, tables);
      }

      // Step 1 — decide the turn's mode.
      // CRITICAL: if an artifact already exists, this turn is an EDIT of it. We keep the
      // same pipeline and pass the persisted spec, instead of re-classifying the mode from
      // a refinement prompt (which rarely restates "deck"/"dashboard" and was silently
      // misrouting edits to the wrong pipeline). The orchestrator only chooses the artifact
      // type on the FIRST turn. To switch artifact types, start a new project (＋).
      const existingKind = result?.kind;
      let mode: "dashboard" | "pdf" | "ppt";
      let brief: OrchestratorBrief | undefined;
      let enhancedPrompt = prompt;
      // Server-side sources (colo + published extracts) can ANSWER data questions
      // by querying their snapshot — the conversational join of the two pipelines.
      const serverSource = projectId === COLO_PROJECT_ID || projectId.startsWith("wb_") || projectId.startsWith("live_");
      const answerInstead = async (reply: string, dataQuestion?: boolean) => {
        if (dataQuestion && serverSource) {
          append("Looking that up in the data…");
          const req = { projectId, prompt, ...(conversationId ? { conversationId } : {}) };
          // One-shot. Token streaming was built for this path but never actually
          // exercised — no token ever streamed, so the sniff buffer, need_more
          // suppression and caret were all unverified code sitting in the request
          // path. Removed rather than shipped untested. The reply still renders as
          // markdown; that was never part of streaming.
          try {
            const r = await sourceChat(req);
            if (r.conversationId) adoptConvId(r.conversationId);
            patch({ phase: "done", tail: null, assistantText: r.answer });
            return;
          } catch { /* fall back to the model's grounded reply */ }
        }
        patch({ phase: "done", tail: null, assistantText: reply });
      };

      // Safe artifact-switching: a refinement stays locked to the current artifact, but an
      // EXPLICIT request ("turn this into a PDF", "make a dashboard") switches pipelines and
      // builds fresh in the new mode. Ordinary edits never switch.
      const currentMode: typeof mode | null = existingKind === "deck" ? "ppt" : existingKind === "dashboard" ? "dashboard" : existingKind === "doc" ? result!.mode : null;
      const requested = existingKind ? detectArtifactSwitch(prompt) : null;
      const doSwitch = !!requested && requested !== currentMode;

      if (doSwitch) {
        setDeckId(null); setDeckSpec(null); setSpec(null);   // leave the old artifact behind
        mode = requested!;
        append(`Switching to ${requested === "pdf" ? "a PDF report" : requested === "ppt" ? "slides" : "a dashboard"}…`);
      } else if (existingKind) {
        // The missing orchestration layer for turns 2..n: previously every
        // follow-up went straight to a rebuild — questions felt ignored and the
        // chat felt robotic. Classify first; only real edits proceed to build.
        mode = existingKind === "deck" ? "ppt" : existingKind === "dashboard" ? "dashboard" : result!.mode;
        try {
          const g = await gateTurn({
            userPrompt: prompt,
            ...(conversationId ? { conversationId } : {}),
            artifactKind: mode === "ppt" ? "slide deck" : mode === "pdf" ? "PDF report" : "dashboard",
            artifactSummary: spec?.meta?.title ?? deckSpec?.meta?.title ?? undefined,
            datasets,
          });
          if (g.conversationId) adoptConvId(g.conversationId);
          if (g.action !== "edit" && g.reply) { await answerInstead(g.reply, g.dataQuestion); return; }
        } catch { /* gate unavailable — behave exactly as before (edit) */ }
      } else {
        let plan: Awaited<ReturnType<typeof orchestratePlan>>;
        try {
          plan = await orchestratePlan({ datasets, userPrompt: prompt, ...(conversationId ? { conversationId } : {}), ...access });
          if ((plan as any).conversationId) adoptConvId((plan as any).conversationId);
        } catch {
          append("Planner unavailable — building a dashboard directly…");
          plan = { conversationId: conversationId ?? "", outputMode: "dashboard", enhancedPrompt: prompt } as any;
        }
        if ("needsClarification" in plan) { patch({ phase: "clarify", assistantText: plan.question }); return; }
        if ((plan as any).respond && (plan as any).reply) { await answerInstead((plan as any).reply, (plan as any).dataQuestion); return; }
        // Skew armor: if a newer/older BFF returns a shape without outputMode,
        // build a dashboard instead of crashing on an undefined mode downstream.
        mode = (["dashboard", "pdf", "ppt"].includes((plan as any).outputMode) ? plan.outputMode : "dashboard");
        brief = plan.brief;
        lastBrief.current = (plan as any).brief ?? null;
        enhancedPrompt = plan.enhancedPrompt ?? prompt;
      }

      // ---- PPT → spec-driven deck pipeline (scrollable preview + editable spec) ----
      if (mode === "ppt") {
        append(deckId ? "Applying your edit…" : "Planning the deck…");
        patch({ phase: "building" });
        const res = await buildDeck({
          datasets, userPrompt: prompt, ...(rows ? { rows } : {}),
          ...(deckId ? { deckId } : {}), ...(deckSpec ? { currentSpec: deckSpec } : {}),
          ...(conversationId ? { conversationId } : {}), projectId,
          // To feed uploaded reports/logos into the deck, also pass:
          //   documents: docFiles, images: imageFiles   (see readUpload() below)
          ...(deckDocs.length ? { documents: deckDocs } : {}),
          ...(deckImages.length ? { images: deckImages } : {}),
        });
        setDeckId(res.deckId);
        setDeckSpec(res.spec);
        setResult({ kind: "deck", compiled: res.compiled, pptxBase64: res.pptxBase64, filename: res.filename });
        setDashVersion((v) => v + 1);
        const changed = res.summary?.length ? res.summary.join("; ") : (res.spec.meta.title || "Deck ready");
        const note = res.warnings.length ? ` · ${res.warnings.length} note${res.warnings.length === 1 ? "" : "s"}` : "";
        patch({ phase: "done", tail: null, assistantText: changed + note });
        builds.current += 1;
        onBuildMeta?.({ versionCount: builds.current });
        return;
      }

      // ---- Dashboard → spec-driven pipeline (ALL sources) ----
      // RESTORED: this used to be gated to colo/workbench/live sources only — a
      // leftover of the text2SQL integration pilot — which silently pushed every
      // uploaded-data build onto the fragile legacy codegen path. The spec pipeline
      // (enhancement layer → widget agents → validate → deterministic render) is
      // now the ONE dashboard pipeline for every source; legacy codegen survives
      // strictly as the in-flight fallback below if this call fails.
      if (mode === "dashboard") {
        try {
          append(spec ? "Updating the dashboard spec…" : "Planning the dashboard spec…");
          patch({ phase: "building" });
          const { app, spec: nextSpec, warnings, summary, noChange } = await buildDashboard({
            datasets, userPrompt: prompt, ...(spec ? { currentSpec: spec } : {}),
            ...(lastBrief.current && !spec ? { brief: lastBrief.current } : {}),
            ...((d) => (d ? { analystDirective: d } : {}))(directiveFor(!spec)),
            ...((convIdRef.current ?? conversationId) ? { conversationId: (convIdRef.current ?? conversationId)! } : {}),
            ...(selectedWidget && spec ? { selectedWidget: { id: selectedWidget.id, title: selectedWidget.title } } : {}),
          });
          pendingDirective.current = null;
          setSelectedWidget(null);   // a selection targets ONE edit, like any editor
          if (noChange || !app) {    // e.g. "undo" at the first version — reply, keep the canvas
            patch({ phase: "done", tail: null, assistantText: summary?.length ? summary.join(" ") : "No change." });
            return;
          }
          setSpec(nextSpec);
          setResult({ kind: "dashboard", app });
          setDashVersion((v) => v + 1);
          // al5: SHOW the notes. "· 3 notes" hid the reason a widget vanished
          // (dropped column, coerced agg, empty section) — the one thing the user
          // needs to fix their prompt or spot a pipeline defect.
          const note = warnings.length
            ? `\n\nNotes:\n${warnings.slice(0, 5).map((w) => `• ${w}`).join("\n")}${warnings.length > 5 ? `\n• …and ${warnings.length - 5} more` : ""}`
            : "";
          patch({ phase: "done", tail: null, assistantText: (summary?.length ? summary.join(" ") : nextSpec.meta.title || "Dashboard ready") + note });
          builds.current += 1;
          onBuildMeta?.({ versionCount: builds.current });
          return;
        } catch (specErr) {
          // Network-level failures should surface normally; only fall back when the
          // spec pipeline itself declined (planner/agents 5xx or empty validation).
          const msg = (specErr as Error)?.message ?? String(specErr);
          if (/failed to fetch|networkerror|load failed|fetch failed|connection refused/i.test(msg)) throw specErr;
          append(`Spec pipeline unavailable (${msg}) — falling back to code generation…`);
        }
      }

      // ---- Legacy path: non-colo dashboards (codegen) + PDF reports ----
      append(`Planned a ${mode}${brief ? ` — ${brief.title}` : ""}.`);
      patch({ phase: "building", brief });

      // Step 2 — build (streamed).
      if (mode === "dashboard") {
        tailBuf.current = "";
        // On EDIT turns, send the user's RAW instruction (not the full planner brief)
        // together with the current code, so the model edits in place surgically
        // instead of regenerating the whole app from a fresh brief.
        const buildPrompt = editing ? prompt : enhancedPrompt;
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
        setResult({ kind: "dashboard", app, brief });
        setDashVersion((v) => v + 1);   // force the preview to remount with the new app
        patch({ phase: "done", tail: null, assistantText: briefLine(brief) || "Dashboard ready." });
      } else {
        append(`Generating the ${mode.toUpperCase()}…`);
        const docReq = { datasets, userPrompt: enhancedPrompt };
        const r = mode === "pdf" ? await generateReport(docReq) : await generatePpt(docReq);
        const base64 = mode === "pdf" ? (r as ReportResult).pdfBase64 : (r as PptResult).pptxBase64;
        setResult({ kind: "doc", mode, filename: r.filename, base64, brief });
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
  }, [tables, conversationId, result, onBuildMeta, spec, deckSpec, deckId, deckDocs, deckImages, projectId]);

  // Capture uploaded reports/logos for the deck (base64), then defer to the parent's
  // data-file handling. Docx/html/md/txt become grounding + tables; images become assets.
  const handleFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files);
    const isImg = (n: string) => /\.(png|jpe?g|gif|webp)$/i.test(n);
    const isDoc = (n: string) => /\.(docx|html?|md|markdown|txt)$/i.test(n);
    void (async () => {
      for (const f of arr) {
        if (!isImg(f.name) && !isDoc(f.name)) continue;
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = ""; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        const base64 = btoa(bin);
        if (isImg(f.name)) setDeckImages((p) => [...p.filter((x) => x.name !== f.name), { name: f.name, base64 }]);
        else setDeckDocs((p) => [...p.filter((x) => x.name !== f.name), { name: f.name, base64 }]);
      }
    })();
    onFiles(files);
  }, [onFiles]);

  // Kick off the first turn from the Landing prompt — in an effect (after
  // render), guarded on data being present.
  useEffect(() => {
    if (initialPrompt && tables.length && !startedRef.current) {
      startedRef.current = true;
      pendingDirective.current = initialDirective ?? null;
      onConsumeInitialPrompt();
      void runTurn(initialPrompt);
    }
  }, [initialPrompt, initialDirective, tables.length, runTurn, onConsumeInitialPrompt]);

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
      ) : result?.kind === "deck" ? (
        <div className="cp-deck">
          <div className="cp-deck-bar">
            <span className="cp-deck-title">{result.compiled.meta.title}</span>
            <button
              className="cp-tool-btn"
              onClick={() => downloadBase64(result.pptxBase64, result.filename, "application/vnd.openxmlformats-officedocument.presentationml.presentation")}
            >
              <HiOutlineDownload /> <span>Download .pptx</span>
            </button>
          </div>
          <div className="cp-deck-scroll">
            <DeckPreview key={dashVersion} compiled={result.compiled} pptxBase64={result.pptxBase64} />
          </div>
        </div>
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
            const streaming = !t.hydrated && (t.phase === "planning" || t.phase === "building");
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
                    {/* Assistant prose is markdown now. The `cp-md` modifier resets the
                        inherited `white-space: pre-wrap` from .cp-msg-body — without it
                        every rendered block double-spaces. The error branch stays plain
                        text (and keeps pre-wrap), because a stack trace needs its newlines. */}
                    {t.phase === "clarify" && <div className="cp-clarify cp-md"><ChatMarkdown text={t.assistantText ?? ""} /></div>}
                    {t.phase === "done" && (
                      <div className="cp-md">
                        <ChatMarkdown text={t.assistantText ?? ""} />
                      </div>
                    )}
                    {t.phase === "error" && <div className="cp-err">{t.assistantText}</div>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="cp-composer">
          {selectedWidget && (
            <div className="cp-selchip" title="Your next edit targets this widget. Click × to clear.">
              <span className="cp-selchip-dot" />
              <span className="cp-selchip-text">Selected: {selectedWidget.title ?? selectedWidget.id}{selectedWidget.kind ? ` (${selectedWidget.kind})` : ""}</span>
              <button className="cp-selchip-x" onClick={() => setSelectedWidget(null)} aria-label="Clear selection">×</button>
            </div>
          )}
          {(fileError ?? error) && serverUp !== false && (
            <div className="cp-composer-err">{fileError ?? error}</div>
          )}
          <PromptInput
            onSubmit={runTurn}
            onFiles={handleFiles}
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
        <button className="cp-rail-btn" onClick={() => { try { localStorage.removeItem(SESSION_KEY); } catch {} onNewProject(); }} title="New project" aria-label="New project">
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