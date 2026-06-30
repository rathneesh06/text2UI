// App.tsx — routed shell (design: aibuilder). Owns the state that must survive
// navigation: uploaded sources (-> tables), the prompt handed from Landing to
// Dashboard, and the SESSION-LOCAL project registry (nothing persisted yet —
// the backend phase swaps this registry for real storage).
//   /            Landing — hero + attach data + first prompt
//   /dashboard   Workspace — generate / iterate / self-heal
//   /projects    My Projects — session-local gallery + empty state
//   /styleguide  Dev-only design-system reference (not linked in nav)
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserRouter, Routes, Route, useNavigate, Navigate } from "react-router-dom";
import LandingPage from "./pages/LandingPage";
import DashboardPage from "./pages/DashboardPage";
import ChatPage from "./pages/ChatPage";
import ProjectsPage from "./pages/ProjectsPage";
import StyleGuidePage from "./pages/StyleGuidePage";
import { assignTableNames, ingestFile, newId, type Source, type Table } from "./lib/datasets";
import { COLO_PROJECT_ID, listSources, sourceTablesToTables } from "./api";
import "./index.css";

export type ProjectMeta = {
  id: string;
  name: string;
  createdAt: number;
  editedAt: number;
  versionCount: number;
  tableNames: string[];
};

/** "build a revenue dashboard with churn" -> "Revenue Dashboard With Churn" */
function deriveProjectName(prompt: string): string {
  const words = prompt
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w, i) => !(i === 0 && /^(build|make|create|generate|a|an)$/i.test(w)))
    .slice(0, 4);
  if (!words.length) return "Untitled project";
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function AppRoutes() {
  const navigate = useNavigate();
  const [sources, setSources] = useState<Source[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [initialPrompt, setInitialPrompt] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [projectId, setProjectId] = useState(() => "s" + newId()); // per-session scope for server-side storage

  // ---- session-local project registry (backend phase: replace with storage) ----
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const sourcesByProject = useRef<Record<string, Source[]>>({});
  const [coloTables, setColoTables] = useState<Table[]>([]);
  const [coloAvailable, setColoAvailable] = useState(false);
  const coloActive = projectId === COLO_PROJECT_ID;
  const pendingName = useRef<string | null>(null);

  const tables = useMemo(
    () => (coloActive ? coloTables : assignTableNames(sources)),
    [coloActive, coloTables, sources],
  );

  // Keep the per-project source snapshot + registered table names in sync.
  useEffect(() => {
    if (projectId === COLO_PROJECT_ID) return; // colo's tables are backend views, not uploaded sources
    sourcesByProject.current[projectId] = sources;
    const names = assignTableNames(sources).map((t) => t.tableName);
    setProjects((prev) => {
      const i = prev.findIndex((p) => p.id === projectId);
      if (i === -1) return prev;
      if (
        prev[i].tableNames.length === names.length &&
        prev[i].tableNames.every((n, j) => n === names[j])
      ) {
        return prev;
      }
      const next = [...prev];
      next[i] = { ...next[i], tableNames: names };
      return next;
    });
  }, [projectId, sources]);

  // Discover named backend sources (the "colo data" snapshot). If present, we
  // pre-load its curated view profiles so a build can start instantly and the
  // planner sees the ticket views.
  useEffect(() => {
    let cancelled = false;
    listSources()
      .then(({ sources }) => {
        if (cancelled) return;
        const colo = sources.find((s) => s.projectId === COLO_PROJECT_ID);
        if (colo) {
          setColoAvailable(true);
          setColoTables(sourceTablesToTables(colo.tables));
        }
      })
      .catch(() => { /* sources are optional; ignore if the BFF has none */ });
    return () => { cancelled = true; };
  }, []);

  // Select "colo data" as the active source but STAY on the landing page — the
  // user types their prompt there, exactly like the uploaded-file flow. (Jumping
  // straight to /build with no prompt left the workspace in a half-built state.)
  const selectColo = useCallback(() => {
    setSources([]);
    setFileError(null);
    setProjectId(COLO_PROJECT_ID);
    pendingName.current = "Colo data dashboard";
    setProjects((prev) =>
      prev.some((p) => p.id === COLO_PROJECT_ID)
        ? prev
        : [{ id: COLO_PROJECT_ID, name: "Colo data dashboard", createdAt: Date.now(), editedAt: Date.now(), versionCount: 0, tableNames: coloTables.map((t) => t.tableName) }, ...prev],
    );
  }, [coloTables]);

  // Deselect colo and return to a fresh upload session.
  const clearColo = useCallback(() => {
    setProjectId("s" + newId());
    setSources([]);
    pendingName.current = null;
  }, []);

  const loadFiles = useCallback(async (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      try {
        const source = await ingestFile(file);
        setSources((s) => [...s, source]);
        setFileError(null);
      } catch (e) {
        setFileError(`Couldn't read ${file.name}: ${(e as Error).message}`);
      }
    }
  }, []);

  const removeSource = useCallback((id: string) => {
    setSources((s) => s.filter((x) => x.id !== id));
  }, []);

  const registerProject = useCallback(
    (name: string) => {
      setProjects((prev) => {
        if (prev.some((p) => p.id === projectId)) return prev;
        const now = Date.now();
        return [
          { id: projectId, name, createdAt: now, editedAt: now, versionCount: 0, tableNames: [] },
          ...prev,
        ];
      });
    },
    [projectId],
  );

  const handleStartBuild = useCallback(
    (prompt: string) => {
      // Use colo if it's already selected, or it's available and the user has no
      // uploaded files / explicitly mentions it.
      const useColo = coloActive || (coloAvailable && (sources.length === 0 || /\bcolo\b/i.test(prompt)));
      pendingName.current = deriveProjectName(prompt);
      if (useColo) {
        if (!coloActive) selectColo();
        setProjects((prev) =>
          prev.some((p) => p.id === COLO_PROJECT_ID)
            ? prev
            : [{ id: COLO_PROJECT_ID, name: pendingName.current!, createdAt: Date.now(), editedAt: Date.now(), versionCount: 0, tableNames: coloTables.map((t) => t.tableName) }, ...prev],
        );
      } else {
        registerProject(pendingName.current);
      }
      setInitialPrompt(prompt);
      navigate("/build");
    },
    [navigate, registerProject, coloActive, coloAvailable, sources.length, selectColo, coloTables],
  );

  // Dashboard reports build progress -> registry stays fresh (and projects
  // started directly from /dashboard get registered on their first version).
  const handleBuildMeta = useCallback(
    ({ versionCount }: { versionCount: number }) => {
      setProjects((prev) => {
        const i = prev.findIndex((p) => p.id === projectId);
        if (i === -1) {
          if (versionCount === 0) return prev;
          const now = Date.now();
          return [
            {
              id: projectId,
              name: pendingName.current ?? "Untitled project",
              createdAt: now,
              editedAt: now,
              versionCount,
              tableNames: assignTableNames(sourcesByProject.current[projectId] ?? []).map((t) => t.tableName),
            },
            ...prev,
          ];
        }
        if (prev[i].versionCount === versionCount) return prev;
        const next = [...prev];
        next[i] = { ...next[i], versionCount, editedAt: Date.now() };
        return next;
      });
    },
    [projectId],
  );

  const handleNewProject = useCallback(() => {
    setSources([]);
    setProjectId("s" + newId());
    setFileError(null);
    setInitialPrompt(null);
    pendingName.current = null;
    setResetKey((k) => k + 1);
    navigate("/");
  }, [navigate]);

  // Reopen a session project: restore its sources; DashboardPage restores its
  // build state (versions/statuses) from its session cache by projectId.
  const openProject = useCallback(
    (id: string) => {
      if (id !== projectId) {
        setSources(sourcesByProject.current[id] ?? []);
        setProjectId(id);
        setInitialPrompt(null);
        setFileError(null);
        pendingName.current = null;
      }
      navigate("/dashboard");
    },
    [navigate, projectId],
  );

  return (
    <Routes>
      <Route
        path="/"
        element={
          <LandingPage
            onStartBuild={handleStartBuild}
            onFiles={loadFiles}
            onRemoveSource={removeSource}
            tables={tables}
            fileError={fileError}
            coloAvailable={coloAvailable}
            coloSelected={coloActive}
            onUseColo={selectColo}
            onClearColo={clearColo}
          />
        }
      />
      <Route
        path="/dashboard"
        element={
          <DashboardPage
            projectId={projectId}
            tables={tables}
            initialPrompt={initialPrompt}
            onConsumeInitialPrompt={() => setInitialPrompt(null)}
            onFiles={loadFiles}
            onRemoveSource={removeSource}
            fileError={fileError}
            onNewProject={handleNewProject}
            resetKey={resetKey}
            onBuildMeta={handleBuildMeta}
          />
        }
      />
      <Route
        path="/build"
        element={
          <ChatPage
            projectId={projectId}
            tables={tables}
            initialPrompt={initialPrompt}
            onConsumeInitialPrompt={() => setInitialPrompt(null)}
            onFiles={loadFiles}
            onRemoveSource={removeSource}
            fileError={fileError}
            onNewProject={handleNewProject}
            onBuildMeta={handleBuildMeta}
          />
        }
      />
      <Route
        path="/projects"
        element={
          <ProjectsPage
            projects={projects}
            activeProjectId={projectId}
            onOpenProject={openProject}
            onNewProject={handleNewProject}
          />
        }
      />
      <Route path="/styleguide" element={<StyleGuidePage />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
