// ProjectsPage.tsx — My Projects gallery (Figma image 8) + empty state (image 9).
// Session-local: the registry lives in App state, nothing is persisted yet.
// When the backend phase adds project storage, only the props' data source changes.
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { HiOutlineSearch, HiOutlineUpload, HiOutlineFolderOpen, HiOutlineTrash } from "react-icons/hi";
import type { ProjectMeta } from "../App";
import "./ProjectsPage.css";

const GLOWS = ["green", "cyan", "amber", "teal", "pink"] as const;
const BLOCK_SETS = [
  ["purple", "cyan", "orange"],
  ["cyan", "purple"],
  ["orange", "purple", "cyan"],
  ["purple", "cyan"],
  ["cyan", "orange", "purple"],
  ["orange", "cyan"],
];

function relativeTime(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

export interface ProjectsPageProps {
  projects: ProjectMeta[];
  activeProjectId: string;
  onOpenProject: (id: string) => void;
  onDeleteProject?: (id: string) => void;
  /** project currently being restored from storage (disables its card) */
  restoringId?: string | null;
  onNewProject: () => void;
}

export default function ProjectsPage({
  projects,
  activeProjectId,
  onOpenProject,
  onDeleteProject,
  restoringId = null,
  onNewProject,
}: ProjectsPageProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.tableNames.some((t) => t.includes(q)),
    );
  }, [projects, query]);

  const header = (
    <header className="projects__header">
      <div className="projects__brand">
        <span className="projects__brand-icon">✦</span>
        <div>
          <div className="projects__brand-row">
            <span className="projects__brand-name">text2UI</span>
            <span className="projects__brand-chip">Developer Tool</span>
          </div>
          {projects.length > 0 && (
            <span className="projects__brand-tagline">
              Turn natural-language prompts and uploaded data files into live, running dashboard apps.
            </span>
          )}
        </div>
      </div>
      <div className="projects__header-actions">
        {projects.length > 0 && (
          <>
            <button className="projects__cta" onClick={() => navigate("/dashboard")}>
              <span className="projects__cta-icon">✦</span>
              Generate App
            </button>
            <button className="projects__ghost" onClick={() => navigate("/")}>
              <HiOutlineUpload />
              Upload Data
            </button>
          </>
        )}
        {projects.length === 0 && (
          <button className="projects__cta" onClick={onNewProject}>
            + New Project
          </button>
        )}
      </div>
    </header>
  );

  /* ---- Empty state (Figma image 9) ---- */
  if (projects.length === 0) {
    return (
      <div className="projects projects--empty-bg">
        {header}
        <div className="projects__empty-stage">
          <div className="projects__empty-card">
            <span className="projects__empty-folder">
              <HiOutlineFolderOpen />
            </span>
            <h2 className="projects__empty-title">No projects yet</h2>
            <p className="projects__empty-sub">Build your first app from a prompt and a data file</p>
            <button className="projects__cta" onClick={onNewProject}>
              + New Project
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ---- Gallery (Figma image 8) ---- */
  return (
    <div className="projects">
      {header}

      <div className="projects__wrap">
        <div className="projects__toolbar">
          <div className="projects__toolbar-left">
            <span className="projects__brand-icon projects__brand-icon--sm">✦</span>
            <div>
              <h1 className="projects__title">My Projects</h1>
              <p className="projects__sub">Browse and reopen your generated dashboards</p>
            </div>
          </div>
          <label className="projects__search">
            <HiOutlineSearch />
            <input
              type="text"
              placeholder="Search projects..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <button className="projects__cta" onClick={onNewProject}>
            + New Project
          </button>
        </div>

        {filtered.length === 0 ? (
          <p className="projects__no-results">No projects match "{query}".</p>
        ) : (
          <div className="projects__grid">
            {filtered.map((p, i) => {
              const glow = GLOWS[i % GLOWS.length];
              const blocks = BLOCK_SETS[i % BLOCK_SETS.length];
              const running = p.versionCount > 0;
              return (
                <button
                  key={p.id}
                  className={`project-card ${restoringId === p.id ? "project-card--restoring" : ""}`}
                  data-glow={glow}
                  onClick={() => restoringId == null && onOpenProject(p.id)}
                  title={p.id === activeProjectId ? "Open (current project)" : "Open project"}
                >
                  {onDeleteProject && p.id !== activeProjectId && (
                    <span
                      className="project-card__delete"
                      role="button"
                      title="Delete project"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`Delete "${p.name}"? This removes its data and versions.`)) {
                          onDeleteProject(p.id);
                        }
                      }}
                    >
                      <HiOutlineTrash />
                    </span>
                  )}
                  <div className="project-card__thumb">
                    <div className="project-card__thumb-inner">
                      {i === 0 && (
                        <div className="project-card__dots">
                          <i /><i /><i />
                        </div>
                      )}
                      <div className="project-card__thumb-head">
                        <span>
                          <span className="project-card__thumb-title">{p.name}</span>
                          <span className="project-card__thumb-sub">Live preview</span>
                        </span>
                        <span className={`project-card__run project-card__run--${running ? (i % 2 ? "p" : "g") : "n"}`}>
                          {running ? "Running" : "Draft"}
                        </span>
                      </div>
                      <div className="project-card__blocks">
                        {blocks.map((b, j) => (
                          <i key={j} className={`project-card__blk--${b}`} style={{ flex: 1 + (j === 0 ? 0.15 : 0) }} />
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="project-card__body">
                    <div className="project-card__name-row">
                      <span className="project-card__name">{p.name}</span>
                      <span className="project-card__ver">v{Math.max(1, p.versionCount)}</span>
                    </div>
                    {p.tableNames.length > 0 && (
                      <div className="project-card__tables">
                        {p.tableNames.slice(0, 3).map((t) => (
                          <span key={t} className="project-card__chip">{t}</span>
                        ))}
                      </div>
                    )}
                    <div className="project-card__foot">
                      <span>{restoringId === p.id ? "Opening…" : `Edited ${relativeTime(p.editedAt)}`}</span>
                      <b>{p.id === activeProjectId ? "Current" : running ? "Running" : "Draft"}</b>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}