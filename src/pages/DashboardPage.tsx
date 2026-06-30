// DashboardPage.tsx — the design's workspace layout, running the REAL pipeline.
// All DEMO_* simulation from the design is gone. State here is the old App.tsx
// state machine, re-homed: versions, thread/statuses, build/edit/self-heal turns.
// We get one POST per turn (no streaming), so statuses are the honest events only.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HiOutlineCode, HiOutlineDownload, HiOutlineEye, HiOutlineDatabase } from "react-icons/hi";
import Sidebar from "../components/Sidebar";
import ProgressBar, { type PipelineStep } from "../components/ProgressBar";
import PromptInput, { DataChips } from "../components/PromptInput";
import LivePreview, { type StatusLine } from "../components/LivePreview";
import CodeViewer from "../components/CodeViewer";
import FeatureInspector, { type SelectedItem } from "../components/FeatureInspector";
import FinalDesign from "../components/FinalDesign";
import { generate, generateStream, summary, uploadDatasets, saveVersion, exportProject, REMOTE_DATA, BFF_URL, type StreamEvent } from "../api";
import { newId, type Table } from "../lib/datasets";
import type { GeneratedApp } from "../../shared/types";
import { classifyError, healPolicy } from "../../shared/errors";
import "./DashboardPage.css";

type Version = { id: string; app: GeneratedApp; label: string };

// Session-local build cache: lets /projects reopen a project with its versions
// intact within the same browser session. Backend phase: replace with storage.
type CachedBuild = { versions: Version[]; current: number; statuses: StatusLine[] };
const buildCache = new Map<string, CachedBuild>();

/** M3: seed the session cache from server-restored versions, so opening a
 *  persisted project mounts its history exactly like a same-session project. */
export function primeBuildCache(projectId: string, versions: Version[]): void {
  buildCache.set(projectId, {
    versions,
    current: Math.max(0, versions.length - 1),
    statuses: [{ message: `Restored ${versions.length} version${versions.length === 1 ? "" : "s"} from project storage.`, type: "success" }],
  });
}

function mainFileContent(app: GeneratedApp): string {
  const f = app.files.find((x) => /(^|\/)App\.(tsx?|jsx?)$/i.test(x.path)) ?? app.files[0];
  return f?.content ?? "";
}

export interface DashboardPageProps {
  projectId: string;
  tables: Table[];
  initialPrompt: string | null;
  onConsumeInitialPrompt: () => void;
  onFiles: (files: FileList | File[]) => void;
  onRemoveSource: (id: string) => void;
  fileError: string | null;
  onNewProject: () => void;
  resetKey: number; // bumped by New Project to clear build state
  onBuildMeta?: (meta: { versionCount: number }) => void; // session project registry
}

export default function DashboardPage({
  projectId,
  tables,
  initialPrompt,
  onConsumeInitialPrompt,
  onFiles,
  onRemoveSource,
  fileError,
  onNewProject,
  resetKey,
  onBuildMeta,
}: DashboardPageProps) {
  const [versions, setVersions] = useState<Version[]>(() => buildCache.get(projectId)?.versions ?? []);
  const [current, setCurrent] = useState(() => buildCache.get(projectId)?.current ?? 0);
  const [generating, setGenerating] = useState(false);
  const [statuses, setStatuses] = useState<StatusLine[]>(() => buildCache.get(projectId)?.statuses ?? []);
  const [streamTail, setStreamTail] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [showFinal, setShowFinal] = useState(false); // N5: final-design display
  const [exporting, setExporting] = useState(false); // N5: export-in-flight flag
  const [bundling, setBundling] = useState(false);    // N3: connected-bundle export flag
  const [selectedItem, setSelectedItem] = useState<SelectedItem | null>(null);
  const [selectionSummary, setSelectionSummary] = useState<string | null>(null);
  const [summaryCache, setSummaryCache] = useState<Record<string, string>>({});
  const [loadingSummary, setLoadingSummary] = useState(false);
  const tablesRef = useRef<Table[]>(tables);
  const autoStarted = useRef(false);
  // Phase 5: bounded auto-heal bookkeeping — per-class + total attempt counts for
  // this error episode. Reset on every user-initiated build/edit (see runGenerate).
  const healCountsRef = useRef<{ total: number; byClass: Record<string, number> }>({ total: 0, byClass: {} });

  // New Project resets the build state (data is cleared upstream in App).
  useEffect(() => {
    if (resetKey > 0) {
      setVersions([]); setCurrent(0); setGenerating(false);
      setStatuses([]); setRuntimeError(null); setShowCode(false);
      setShowFinal(false); setExporting(false);
      setBundling(false);
      setSelectedItem(null); setSelectionSummary(null); setSummaryCache({}); setLoadingSummary(false);
      autoStarted.current = false;
      buildCache.delete(projectId);
    }
  }, [resetKey]);

  // Project switched while mounted: swap to the new project's cached build.
  const cacheKeyRef = useRef(projectId);
  useEffect(() => {
    if (cacheKeyRef.current === projectId) return;
    const cached = buildCache.get(projectId);
    setVersions(cached?.versions ?? []);
    setCurrent(cached?.current ?? 0);
    setStatuses(cached?.statuses ?? []);
    setGenerating(false); setRuntimeError(null); setShowCode(false);
    setSelectedItem(null); setSelectionSummary(null); setLoadingSummary(false);
    cacheKeyRef.current = projectId;
  }, [projectId]);

  // Keep the session cache fresh (guard: only once state belongs to this project).
  useEffect(() => {
    if (cacheKeyRef.current !== projectId) return;
    buildCache.set(projectId, { versions, current, statuses });
  }, [projectId, versions, current, statuses]);

  // Report build progress upward for the session project registry.
  useEffect(() => {
    onBuildMeta?.({ versionCount: versions.length });
  }, [versions.length, onBuildMeta]);

  const sandboxTables = useMemo(
    () => tables.map((t) => ({ tableName: t.tableName, rows: t.ingest.rows })),
    [tables],
  );
  const currentApp = versions[current]?.app ?? null;

  useEffect(() => {
    tablesRef.current = tables;
  }, [tables]);

  const pushStatus = (message: string, type: StatusLine["type"] = "info", id?: string) =>
    setStatuses((s) => [...s, { message, type, id }]);

  // N5: download the current app as a complete, runnable Vite project (inline data).
  const downloadProject = useCallback(async () => {
    if (!currentApp) return;
    setExporting(true);
    try {
      await exportProject({
        app: currentApp,
        tables: sandboxTables,
        appName: currentApp.summary ?? "text2UI app",
        dataMode: "inline",
      });
      pushStatus("Project downloaded as a runnable Vite app.", "success");
    } catch (e: any) {
      pushStatus(`Download failed: ${e?.message ?? "unknown error"}`, "error");
    } finally {
      setExporting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentApp, sandboxTables]);

  // N3: download the app + a portable Postgres dump + a read-only query server.
  const downloadBundle = useCallback(async () => {
    if (!currentApp) return;
    setBundling(true);
    try {
      await exportProject({
        app: currentApp,
        tables: sandboxTables,
        appName: currentApp.summary ?? "text2UI app",
        bundle: "connected",
      });
      pushStatus("Downloaded app + database bundle (remote app, Postgres dump, query server).", "success");
    } catch (e: any) {
      pushStatus(`Bundle download failed: ${e?.message ?? "unknown error"}`, "error");
    } finally {
      setBundling(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentApp, sandboxTables]);
  /** Update the line with this id in place (live counters), or append it. */
  const setStatusById = (id: string, message: string, type: StatusLine["type"] = "info") =>
    setStatuses((s) => {
      const i = s.findIndex((x) => x.id === id);
      if (i === -1) return [...s, { id, message, type }];
      const next = [...s];
      next[i] = { id, message, type };
      return next;
    });

  const getSummaryKey = useCallback((item: SelectedItem) => {
    return `${item.tableName ?? "unknown"}|${item.type}|${item.title}`;
  }, []);

  const fetchSummary = useCallback(
    async (item: SelectedItem, opts?: { force?: boolean }) => {
      const key = getSummaryKey(item);
      if (!opts?.force && summaryCache[key]) {
        setSelectionSummary(summaryCache[key]);
        return;
      }

      const table = item.tableName ? tablesRef.current.find((t) => t.tableName === item.tableName) : null;
      if (!table) {
        setSelectionSummary("No dataset available to summarize this feature.");
        return;
      }

      setLoadingSummary(true);
      setSelectionSummary(null);
      try {
        pushStatus(`Generating summary for "${item.title}"...`);
        const { summary: generated } = await summary({
          projectId,
          tableName: table.tableName,
          profile: table.ingest.profile,
          featureTitle: item.title,
          featureType: item.type,
          featureDetails: item.description,
          query: item.query,
        });
        setSummaryCache((prev) => ({ ...prev, [key]: generated }));
        setSelectionSummary(generated);
        pushStatus(`Summary ready for "${item.title}"`, "success");
      } catch (e) {
        const msg = (e as Error).message;
        setSelectionSummary("Summary generation failed.");
        pushStatus(`Summary failed: ${msg}`, "error");
      } finally {
        setLoadingSummary(false);
      }
    },
    [getSummaryKey, projectId, summaryCache],
  );

  const handleSelectTable = useCallback(
    async (table: Table) => {
      const item: SelectedItem = {
        title: table.tableName,
        type: "table",
        tableName: table.tableName,
        description: `Dataset imported from ${table.filename}`,
      };
      setSelectedItem(item);
      await fetchSummary(item);
    },
    [fetchSummary],
  );

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const data = event.data as any;
      if (!data || data.type !== "t2ui.featureSelected") return;
      const payload = data.payload as any;
      if (!payload || typeof payload !== "object") return;

      const item: SelectedItem = {
        title: String(payload.title ?? "Selected feature"),
        type: String(payload.type ?? "feature"),
        tableName: typeof payload.tableName === "string" ? payload.tableName : undefined,
        description:
          typeof payload.description === "string"
            ? payload.description
            : typeof payload.details === "string"
            ? payload.details
            : undefined,
        query: typeof payload.query === "string" ? payload.query : undefined,
      };

      setSelectedItem(item);
      void fetchSummary(item);
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [fetchSummary]);

  const runGenerate = useCallback(
    async (opts: { userPrompt: string; lastError?: string; currentCode?: string }, label: string) => {
      if (!tables.length || generating) return;
      // Phase 5: a fresh build/edit starts a new error episode — reset auto-heal
      // counters so a later, unrelated error gets its full retry budget.
      if (!opts.lastError) healCountsRef.current = { total: 0, byClass: {} };
      const nextNum = versions.length + 1;
      setGenerating(true);
      setRuntimeError(null);

      setStatuses([]);
      for (const t of tables) {
        pushStatus(`Profiled ${t.filename} → table "${t.tableName}" (${t.ingest.profile.rowCount.toLocaleString()} rows)`, "success");
      }

      try {
        if (REMOTE_DATA) {
          pushStatus(`Syncing ${tables.length} table${tables.length > 1 ? "s" : ""} to the server (DuckDB)...`);
          await uploadDatasets(projectId, tables);
          pushStatus("Server storage up to date.", "success");
        }
        pushStatus(opts.lastError ? "Sending runtime error back to the model for a fix..." : "Sending prompt + schema to the model...");
        const datasets = tables.map((t) => ({ tableName: t.tableName, profile: t.ingest.profile }));
        const reqBody = { datasets, ...opts, ...(REMOTE_DATA ? { dataAccess: "remote" as const } : {}) };

        // Stream-first: live journey events from the BFF. Falls back to the
        // plain request if the stream can't start (proxy buffering, old BFF).
        let tail = "";
        const onEvent = (ev: StreamEvent) => {
          if (ev.type === "stage") {
            if (ev.stage === "planning") pushStatus("Planning layout…", "info", "plan");
            if (ev.stage === "model_call") setStatusById("gen", "Model connected — writing App.tsx…");
            if (ev.stage === "continuation") pushStatus(`Output is long — continuing (${ev.detail})…`);
            if (ev.stage === "validating") {
              setStreamTail(null);
              pushStatus("Validating and assembling the app…");
            }
            if (ev.stage === "styling") pushStatus("Compiling styles…", "info", "style");
          } else if (ev.type === "plan") {
            setStatusById("plan", "Layout planned.");
            pushStatus(ev.text, "info");
          } else if (ev.type === "progress") {
            setStatusById("gen", `Writing App.tsx — ${ev.chars.toLocaleString()} characters…`);
          } else if (ev.type === "chunk") {
            tail = (tail + ev.text).slice(-400);
            setStreamTail(tail);
          }
        };
        let app: GeneratedApp;
        try {
          app = await generateStream(reqBody, onEvent);
        } catch (streamErr) {
          const msg = (streamErr as Error).message;
          // Real generation failures surface as-is; only transport problems fall back.
          if (!/stream unavailable|stream ended without/i.test(msg)) throw streamErr;
          setStreamTail(null);
          pushStatus("Live stream unavailable — using standard generation…");
          app = await generate(reqBody);
        }
        setStreamTail(null);
        pushStatus(app.summary ?? `Received v${nextNum}.`, "success");
        pushStatus("Mounting sandbox (DuckDB-WASM + Sandpack)...");
        setVersions((v) => {
          const next = [...v, { id: newId(), app, label }];
          setCurrent(next.length - 1);
          return next;
        });
        if (REMOTE_DATA) {
          // persist the version; non-fatal if it fails (the app is already live)
          saveVersion(projectId, { num: nextNum, label, app })
            .then(() => pushStatus(`Saved v${nextNum} to project storage.`, "success"))
            .catch((e) => pushStatus(`Could not persist v${nextNum}: ${(e as Error).message}`, "error"));
        }
        setGenerating(false);
      } catch (e) {
        setStreamTail(null);
        pushStatus((e as Error).message, "error");
        setGenerating(false);
      }
    },
    [tables, versions.length, generating, projectId],
  );

  // Auto-start when arriving from the landing page with a prompt.
  useEffect(() => {
    if (initialPrompt && tables.length && !autoStarted.current) {
      autoStarted.current = true;
      runGenerate({ userPrompt: initialPrompt }, initialPrompt);
      onConsumeInitialPrompt();
    }
  }, [initialPrompt, tables.length, runGenerate, onConsumeInitialPrompt]);

  const handleSubmit = useCallback(
    (prompt: string) => {
      const editing = !!currentApp;
      runGenerate(
        { userPrompt: prompt, ...(editing ? { currentCode: mainFileContent(currentApp!) } : {}) },
        prompt,
      );
    },
    [currentApp, runGenerate],
  );

  const autoFix = useCallback(() => {
    if (!currentApp || !runtimeError) return;
    runGenerate(
      { userPrompt: "", lastError: runtimeError, currentCode: mainFileContent(currentApp) },
      "Auto-fix the runtime error",
    );
  }, [currentApp, runtimeError, runGenerate]);

  // Phase 5: bounded auto-heal. When the preview reports an error, classify it
  // and consult the shared retry policy (per-class caps + a hard global ceiling,
  // so a shifting error class can never loop forever). If allowed, wait the
  // backoff delay and run a heal turn; otherwise stop and surface the error so
  // the user can take over with the manual Auto-fix button.
  useEffect(() => {
    if (!runtimeError || generating || !currentApp) return;
    const cls = classifyError(runtimeError);
    const counts = healCountsRef.current;
    const classAttempt = counts.byClass[cls] ?? 0;
    const decision = healPolicy(cls, classAttempt, counts.total);
    if (!decision.shouldRetry) {
      pushStatus(`Auto-heal stopped (${cls}): ${decision.reason}. Use Auto-fix to retry manually.`, "error");
      return;
    }
    const timer = setTimeout(() => {
      counts.total += 1;
      counts.byClass[cls] = classAttempt + 1;
      pushStatus(`Auto-healing (${cls}) — ${decision.reason}…`, "info");
      runGenerate(
        { userPrompt: "", lastError: runtimeError, currentCode: mainFileContent(currentApp) },
        `Auto-heal (${cls})`,
      );
    }, decision.delayMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeError, generating, currentApp, runGenerate]);

  // Inspector: Regenerate ignores the cache for the current selection.
  const regenerateSummary = useCallback(() => {
    if (selectedItem) void fetchSummary(selectedItem, { force: true });
  }, [selectedItem, fetchSummary]);

  // Inspector: "Edit with AI" — immediate regeneration of the selected feature.
  // No typing: the edit prompt is synthesized from the selection itself.
  const editWithAI = useCallback(() => {
    if (!selectedItem || !currentApp || generating) return;
    const parts = [
      `Regenerate and improve the "${selectedItem.title}" ${selectedItem.type}.`,
      selectedItem.query ? `It is currently backed by this SQL: ${selectedItem.query}` : "",
      selectedItem.tableName ? `It uses the "${selectedItem.tableName}" table.` : "",
      "Improve its clarity, labels, and visual design. Keep every other part of the app exactly as it is.",
    ].filter(Boolean);
    runGenerate(
      { userPrompt: parts.join(" "), currentCode: mainFileContent(currentApp) },
      `Edit with AI: ${selectedItem.title}`,
    );
  }, [selectedItem, currentApp, generating, runGenerate]);

  const exportCode = useCallback(() => {
    if (!currentApp) return;
    const blob = new Blob([mainFileContent(currentApp)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "App.tsx"; a.click();
    URL.revokeObjectURL(url);
  }, [currentApp]);

  const step: PipelineStep = generating
    ? "generate"
    : currentApp
      ? "live"
      : tables.length
        ? "data"
        : "idle";

  const selectedTableProfile = selectedItem?.tableName
    ? tables.find((t) => t.tableName === selectedItem.tableName) ?? null
    : null;

  return (
    <div className="dashboard">
      <Sidebar
        onNewProject={onNewProject}
        tables={tables}
        selectedTableName={selectedItem?.tableName ?? null}
        onSelectTable={handleSelectTable}
      />

      <div className="dashboard__main">
        <ProgressBar currentStep={step} canExport={!!currentApp} onExport={exportCode} statuses={statuses} isGenerating={generating} />

        <div className="dashboard__content">
          <div className="dashboard__center">
            {/* Prompt Area */}
            <div className="dashboard__prompt-area">
              <div className="dashboard__prompt-icon">✦</div>
              <PromptInput
                onSubmit={handleSubmit}
                onFiles={onFiles}
                variant="dashboard"
                placeholder={
                  currentApp
                    ? "Describe a change — e.g. make it a pie chart, add a region filter"
                    : "Describe the app to build on top of your data..."
                }
                disabled={generating}
                canSubmit={tables.length > 0}
                error={fileError}
                submitLabel={currentApp ? "Update App" : "Build App"}
              >
                <DataChips tables={tables} onRemove={onRemoveSource} />
              </PromptInput>
            </div>

            {/* App actions */}
            {currentApp && (
              <div className="dashboard__actions">
                <button
                  className="dashboard__toggle-code"
                  onClick={() => setShowFinal(true)}
                  id="open-preview-btn"
                >
                  <HiOutlineEye />
                  <span>Preview</span>
                </button>
                <button
                  className="dashboard__toggle-code"
                  onClick={downloadProject}
                  disabled={exporting}
                  id="download-project-btn"
                >
                  <HiOutlineDownload />
                  <span>{exporting ? "Preparing\u2026" : "Download project"}</span>
                </button>
                <button
                  className="dashboard__toggle-code"
                  onClick={downloadBundle}
                  disabled={bundling}
                  id="download-bundle-btn"
                  title="App in remote mode + Postgres dump + read-only query server"
                >
                  <HiOutlineDatabase />
                  <span>{bundling ? "Preparing\u2026" : "App + DB"}</span>
                </button>
                <button
                  className="dashboard__toggle-code"
                  onClick={() => setShowCode(!showCode)}
                  id="toggle-code-btn"
                >
                  <HiOutlineCode />
                  <span>{showCode ? "Hide Code" : "View Code"}</span>
                </button>
              </div>
            )}

            {currentApp?.metrics && (
              <div
                className="dashboard__metrics"
                title={Object.entries(currentApp.metrics.byPhase)
                  .map(([p, a]) => `${p}: ${a.calls} call(s), ${a.ms}ms, ${(a.inputTokens + a.outputTokens).toLocaleString()} tok`)
                  .join("\n")}
              >
                <span>{currentApp.metrics.totalTokens.toLocaleString()} tokens</span>
                <span aria-hidden>·</span>
                <span>~${currentApp.metrics.costUsd.toFixed(4)}</span>
                <span aria-hidden>·</span>
                <span>{(currentApp.metrics.ms / 1000).toFixed(1)}s</span>
                <span aria-hidden>·</span>
                <span>{currentApp.metrics.calls} call{currentApp.metrics.calls === 1 ? "" : "s"}</span>
              </div>
            )}

            <CodeViewer
              files={currentApp ? [{ name: "App.tsx", content: mainFileContent(currentApp) }] : []}
              visible={showCode}
              onToggle={() => setShowCode(false)}
            />

            <LivePreview
              app={currentApp}
              tables={sandboxTables}
              remote={REMOTE_DATA ? { bffUrl: BFF_URL, projectId } : undefined}
              statuses={statuses}
              streamTail={streamTail}
              isGenerating={generating}
              versions={versions}
              activeVersion={current}
              onPickVersion={(i) => { setCurrent(i); setRuntimeError(null); }}
              runtimeError={runtimeError}
              onAutoFix={autoFix}
              onRuntimeError={setRuntimeError}
            />
          </div>
        </div>
      </div>

      <FeatureInspector
        selected={selectedItem}
        selectedTable={selectedTableProfile}
        summary={selectionSummary}
        loadingSummary={loadingSummary}
        onRegenerateSummary={regenerateSummary}
        onEditWithAI={editWithAI}
        onViewCode={() => setShowCode(true)}
        canEdit={!!currentApp && !generating}
        live={!!currentApp}
      />

      {showFinal && currentApp && (
        <FinalDesign
          app={currentApp}
          tables={sandboxTables}
          remote={REMOTE_DATA ? { bffUrl: BFF_URL, projectId } : undefined}
          title={currentApp.summary ?? undefined}
          onClose={() => setShowFinal(false)}
          onDownload={downloadProject}
          downloading={exporting}
        />
      )}
    </div>
  );
}