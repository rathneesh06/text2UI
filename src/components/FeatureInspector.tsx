// FeatureInspector.tsx — right-rail inspector (Flowstep design, image 4/7).
// Sections: header + Live badge → empty state OR selected card (title, type
// badge, source table, SQL with copy, table columns when relevant) → AI Summary
// (shimmer while generating, Regenerate when done) → "Edit with AI" (immediate
// regeneration of the selected feature) → "View Component Code".
import { useState } from "react";
import { HiOutlineClipboardCopy, HiOutlineCheck, HiOutlineRefresh, HiOutlineSparkles, HiOutlineCode, HiOutlineCursorClick } from "react-icons/hi";
import type { Table } from "../lib/datasets";
import "./FeatureInspector.css";

export interface SelectedItem {
  title: string;
  type: string;
  tableName?: string;
  description?: string;
  query?: string;
}

export interface FeatureInspectorProps {
  selected: SelectedItem | null;
  selectedTable: Table | null;     // resolved table for table-type selections
  summary: string | null;
  loadingSummary: boolean;
  onRegenerateSummary: () => void;
  onEditWithAI: () => void;        // immediate regeneration of the selected feature
  onViewCode: () => void;
  canEdit: boolean;                // an app exists and we're not mid-generation
  live: boolean;                   // an app is currently mounted
}

export default function FeatureInspector({
  selected,
  selectedTable,
  summary,
  loadingSummary,
  onRegenerateSummary,
  onEditWithAI,
  onViewCode,
  canEdit,
  live,
}: FeatureInspectorProps) {
  const [copied, setCopied] = useState(false);

  const copyQuery = async () => {
    if (!selected?.query) return;
    try {
      await navigator.clipboard.writeText(selected.query);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable — ignore */ }
  };

  return (
    <aside className="inspector">
      <div className="inspector__header">
        <span className="inspector__title">
          <HiOutlineSparkles className="inspector__title-icon" />
          Feature Inspector
        </span>
        {live && (
          <span className="inspector__live">
            <span className="inspector__live-dot" />
            Live
          </span>
        )}
      </div>

      {!selected ? (
        <div className="inspector__empty">
          <div className="inspector__empty-icon">
            <HiOutlineCursorClick />
          </div>
          <div className="inspector__empty-title">Nothing selected</div>
          <div className="inspector__empty-hint">
            Click any chart, KPI card, or table in your app to inspect it
          </div>
        </div>
      ) : (
        <div className="inspector__body">
          <div className="inspector__card">
            <div className="inspector__card-head">
              <span className="inspector__feature-title">{selected.title}</span>
              <span className={`inspector__badge inspector__badge--${selected.type.toLowerCase().replace(/[^a-z]/g, "") || "feature"}`}>
                {selected.type}
              </span>
            </div>
            {selected.description && (
              <div className="inspector__feature-desc">{selected.description}</div>
            )}

            {selected.tableName && (
              <div className="inspector__section">
                <div className="inspector__section-label">Source Table</div>
                <div className="inspector__table-pill">
                  <code>{selected.tableName}</code>
                  {selectedTable && (
                    <span className="inspector__table-meta">
                      {selectedTable.ingest.profile.rowCount.toLocaleString()} rows
                    </span>
                  )}
                </div>
              </div>
            )}

            {selected.query && (
              <div className="inspector__section">
                <div className="inspector__section-label">
                  SQL Query
                  <button className="inspector__copy" onClick={copyQuery}>
                    {copied ? <HiOutlineCheck /> : <HiOutlineClipboardCopy />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre className="inspector__sql"><code>{selected.query}</code></pre>
              </div>
            )}

            {/* For table selections (no SQL behind them) show the schema instead */}
            {!selected.query && selectedTable && (
              <div className="inspector__section">
                <div className="inspector__section-label">Columns</div>
                <div className="inspector__columns">
                  {selectedTable.ingest.profile.columns.map((col) => (
                    <div key={col.name} className="inspector__column">
                      <code className="inspector__column-name">{col.name}</code>
                      <span className="inspector__column-type">{col.type}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="inspector__card inspector__summary">
            <div className="inspector__card-head">
              <span className="inspector__summary-title">
                <HiOutlineSparkles /> AI Summary
              </span>
              <span className={`inspector__badge ${loadingSummary ? "inspector__badge--generating" : "inspector__badge--generated"}`}>
                {loadingSummary ? "Generating…" : summary ? "Generated" : "—"}
              </span>
            </div>
            {loadingSummary ? (
              <div className="inspector__shimmer">
                <div className="inspector__shimmer-line" />
                <div className="inspector__shimmer-line" />
                <div className="inspector__shimmer-line inspector__shimmer-line--short" />
                <div className="inspector__shimmer-label">Generating summary…</div>
              </div>
            ) : (
              <>
                <div className="inspector__summary-text">
                  {summary ?? "No summary yet for this selection."}
                </div>
                {summary && (
                  <button className="inspector__regenerate" onClick={onRegenerateSummary}>
                    <HiOutlineRefresh /> Regenerate
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <div className="inspector__actions">
        <button
          className="inspector__edit-btn"
          onClick={onEditWithAI}
          disabled={!selected || !canEdit}
          title={selected ? `Regenerate "${selected.title}" with AI` : "Select a feature first"}
        >
          <HiOutlineSparkles /> Edit with AI
        </button>
        <button className="inspector__code-btn" onClick={onViewCode} disabled={!canEdit && !live}>
          <HiOutlineCode /> View Component Code
        </button>
      </div>
    </aside>
  );
}