// LandingPage.tsx — the hero entry. The 3-way output picker is retired (Phase 2):
// the user attaches data and describes what they want, and the orchestrator
// chooses the format (dashboard / PDF / deck) downstream.
import { Link } from "react-router-dom";
import PromptInput, { DataChips } from "../components/PromptInput";
import type { Table } from "../lib/datasets";
import type { SourceInfo } from "../api";
import "./LandingPage.css";

export interface LandingPageProps {
  onStartBuild: (prompt: string) => void;
  onFiles: (files: FileList | File[]) => void;
  onRemoveSource: (id: string) => void;
  tables: Table[];
  fileError: string | null;
  coloAvailable?: boolean;
  coloSelected?: boolean;
  onUseColo?: () => void;
  onClearColo?: () => void;
  /** Workbench extracts (text2SQL) — offered exactly like colo. */
  wbSources?: SourceInfo[];
  wbSelected?: SourceInfo | null;
  onUseWbSource?: (src: SourceInfo) => void;
  onClearWbSource?: () => void;
  onDeleteWbSource?: (projectId: string) => void;
}

export default function LandingPage({ onStartBuild, onFiles, onRemoveSource, tables, fileError, coloAvailable, coloSelected, onUseColo, onClearColo, wbSources = [], wbSelected = null, onUseWbSource, onClearWbSource, onDeleteWbSource }: LandingPageProps) {
  const hasData = tables.length > 0;
  const canSubmit = hasData || !!coloSelected || !!coloAvailable || !!wbSelected || wbSources.length > 0;

  return (
    <div className="landing">
      {/* ---- Navbar ---- */}
      <header className="landing__header" id="landing-nav">
        <div className="landing__brand">
          <span className="landing__brand-icon">✦</span>
          <div className="landing__brand-text">
            <div className="landing__brand-row">
              <span className="landing__brand-name">text2UI</span>
              <span className="landing__brand-chip">Developer Tool</span>
            </div>
            <span className="landing__brand-tagline">
              Turn natural-language prompts and uploaded data files into live dashboards, reports, and decks.
            </span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link to="/select" className="landing__colo-btn" style={{ textDecoration: "none" }}>
            <span className="landing__colo-dot">◈</span>
            Connect a database
          </Link>
        </div>
      </header>

      {/* ---- Hero ---- */}
      <main className="landing__hero">
        <div className="landing__bg-glow landing__bg-glow--1" />
        <div className="landing__bg-glow landing__bg-glow--2" />
        <div className="landing__bg-grid" />

        <div className="landing__hero-content">
          <div className="landing__badge animate-fade-in">
            <span className="landing__badge-dot">✦</span>
            <span>Describe it — we choose the best format</span>
          </div>

          <h1 className="landing__heading animate-fade-in-up">
            Your data, <span className="landing__heading-gradient">your way</span>
          </h1>

          <p className="landing__subtitle animate-fade-in-up" style={{ animationDelay: "0.1s" }}>
            Attach your datasets and describe what you want. text2UI decides whether a live dashboard, a PDF report,
            or a slide deck fits best — then builds it, and you can keep refining it in conversation.
          </p>

          <div className="landing__prompt-wrapper animate-fade-in-up" style={{ animationDelay: "0.2s" }}>
            <PromptInput
              onSubmit={onStartBuild}
              onFiles={onFiles}
              variant="hero"
              placeholder={coloSelected
                ? "e.g. a helpdesk dashboard: ticket volume by day, by type / priority / status, and SLA attainment"
                : "e.g. a sales dashboard with revenue by region, or a quarterly PDF report"}
              canSubmit={canSubmit}
              error={fileError}
            >
              {coloSelected ? (
                <div className="landing__colo-chip">
                  <span className="landing__colo-dot">●</span>
                  <span>colo data — full history · {tables.length} view{tables.length === 1 ? "" : "s"}</span>
                  <button type="button" className="landing__colo-clear" onClick={onClearColo} aria-label="Use files instead">×</button>
                </div>
              ) : wbSelected ? (
                <div className="landing__colo-chip">
                  <span className="landing__colo-dot">◈</span>
                  <span>{wbSelected.label} · {tables.length} table{tables.length === 1 ? "" : "s"}</span>
                  <button type="button" className="landing__colo-clear" onClick={onClearWbSource} aria-label="Use files instead">×</button>
                </div>
              ) : (
                <DataChips tables={tables} onRemove={onRemoveSource} />
              )}
            </PromptInput>
            {!hasData && !coloSelected && !coloAvailable && !wbSelected && !wbSources.length && (
              <p className="landing__attach-hint">
                <span className="landing__attach-hint-icon">ⓘ</span>
                Attach at least one data file
              </p>
            )}
            {coloAvailable && !coloSelected && !wbSelected && (
              <div className="landing__colo">
                <button type="button" className="landing__colo-btn" onClick={onUseColo}>
                  <span className="landing__colo-dot">●</span>
                  Use colo data (full history, from the backend)
                </button>
                <span className="landing__colo-hint">
                  selects the backend snapshot — then type your prompt above
                </span>
              </div>
            )}
            {!coloSelected && !wbSelected && wbSources.map((src) => (
              <div className="landing__colo" key={src.projectId}>
                <button type="button" className="landing__colo-btn" onClick={() => onUseWbSource?.(src)}>
                  <span className="landing__colo-dot">◈</span>
                  Use {src.label} ({src.tables.length} table{src.tables.length === 1 ? "" : "s"}, extracted via SQL Workbench)
                </button>
                {onDeleteWbSource && (
                  <button
                    type="button"
                    className="landing__colo-clear"
                    aria-label={`Delete ${src.label}`}
                    title="Delete this extracted source"
                    onClick={() => { if (window.confirm(`Delete "${src.label}"? Its extracted data file will be removed.`)) onDeleteWbSource(src.projectId); }}
                  >×</button>
                )}
              </div>
            ))}
          </div>

          <div className="landing__tags animate-fade-in-up" style={{ animationDelay: "0.3s" }}>
            <span className="landing__tag">CSV</span>
            <span className="landing__tag">Excel</span>
            <span className="landing__tag">JSON</span>
            <span className="landing__tag">SQL</span>
            <span className="landing__tag">React</span>
          </div>
        </div>
      </main>
    </div>
  );
}