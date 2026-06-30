// DocumentPage.tsx — Wave 4 / N2b: the PDF report & PPT deck surface.
// A peer to DashboardPage for the two document modes. Same prompt bar + data
// upload UX, but instead of mounting a Sandpack app it calls the PDF/PPT
// pipeline, downloads the rendered file, and shows a light preview.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import PromptInput, { DataChips } from "../components/PromptInput";
import type { Table } from "../lib/datasets";
import type { ReportDoc, DeckDoc } from "../../shared/types";
import { generateReport, generatePpt, downloadBase64, type ReportResult, type PptResult } from "../api";
import "./DocumentPage.css";

export interface DocumentPageProps {
  mode: "pdf" | "ppt";
  tables: Table[];
  initialPrompt: string | null;
  onConsumeInitialPrompt: () => void;
  onFiles: (files: FileList | File[]) => void;
  onRemoveSource: (id: string) => void;
  fileError: string | null;
  onNewProject: () => void;
}

const META = {
  pdf: {
    label: "PDF report",
    icon: "📄",
    mime: "application/pdf",
    placeholder: "e.g. a quarterly sales report with revenue, churn, and top regions",
  },
  ppt: {
    label: "Slide deck",
    icon: "📊",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    placeholder: "e.g. an executive deck reviewing Q1 sales performance",
  },
} as const;

type Result = ReportResult | PptResult;
function payloadOf(mode: "pdf" | "ppt", r: Result): string {
  return mode === "pdf" ? (r as ReportResult).pdfBase64 : (r as PptResult).pptxBase64;
}

export default function DocumentPage({
  mode,
  tables,
  initialPrompt,
  onConsumeInitialPrompt,
  onFiles,
  onRemoveSource,
  fileError,
  onNewProject,
}: DocumentPageProps) {
  const navigate = useNavigate();
  const meta = META[mode];
  const hasData = tables.length > 0;

  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const ranInitial = useRef(false);

  const run = useCallback(
    async (prompt: string) => {
      if (!tables.length || generating || !prompt.trim()) return;
      setGenerating(true);
      setError(null);
      setResult(null);
      try {
        const datasets = tables.map((t) => ({ tableName: t.tableName, profile: t.ingest.profile }));
        const res: Result =
          mode === "pdf"
            ? await generateReport({ datasets, userPrompt: prompt })
            : await generatePpt({ datasets, userPrompt: prompt });
        setResult(res);
        downloadBase64(payloadOf(mode, res), res.filename, meta.mime); // auto-download on success
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setGenerating(false);
      }
    },
    [tables, generating, mode, meta.mime],
  );

  // Auto-run the prompt handed over from the landing selector, once.
  useEffect(() => {
    if (initialPrompt && !ranInitial.current && tables.length) {
      ranInitial.current = true;
      const p = initialPrompt;
      onConsumeInitialPrompt();
      run(p);
    }
  }, [initialPrompt, tables.length, run, onConsumeInitialPrompt]);

  return (
    <div className="docpage">
      <header className="docpage__header">
        <button className="docpage__btn" onClick={onNewProject}>← New</button>
        <div className="docpage__title">
          <span className="docpage__title-icon">{meta.icon}</span>
          {meta.label}
        </div>
        <button className="docpage__btn" onClick={() => navigate("/")}>Change type</button>
      </header>

      <main className="docpage__main">
        <div className="docpage__prompt">
          <PromptInput
            onSubmit={run}
            onFiles={onFiles}
            variant="hero"
            placeholder={meta.placeholder}
            canSubmit={hasData && !generating}
            error={fileError}
            initialValue={initialPrompt ?? ""}
          >
            <DataChips tables={tables} onRemove={onRemoveSource} />
          </PromptInput>
          {!hasData && <p className="docpage__hint">Attach at least one data file to begin</p>}
        </div>

        {generating && <div className="docpage__status">Generating your {meta.label.toLowerCase()}…</div>}
        {error && <div className="docpage__error">{error}</div>}

        {result && (
          <div className="docpage__result">
            <div className="docpage__result-head">
              <div>
                <div className="docpage__result-title">{result.doc.title}</div>
                {result.doc.subtitle && <div className="docpage__result-sub">{result.doc.subtitle}</div>}
              </div>
              <button
                className="docpage__download"
                onClick={() => downloadBase64(payloadOf(mode, result), result.filename, meta.mime)}
              >
                ↓ Download {result.filename}
              </button>
            </div>

            {mode === "pdf" ? (
              <ReportPreview doc={result.doc as ReportDoc} />
            ) : (
              <DeckPreview doc={result.doc as DeckDoc} />
            )}

            {result.metrics && (
              <div className="docpage__metrics">
                {result.metrics.totalTokens.toLocaleString()} tokens · ~${result.metrics.costUsd.toFixed(4)} ·{" "}
                {(result.metrics.ms / 1000).toFixed(1)}s · {result.metrics.calls} call
                {result.metrics.calls === 1 ? "" : "s"}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function ReportPreview({ doc }: { doc: ReportDoc }) {
  return (
    <div className="docpage__preview">
      {doc.kpis?.length ? (
        <div className="docpage__kpis">
          {doc.kpis.map((k, i) => (
            <div className="docpage__kpi" key={i}>
              <div className="docpage__kpi-value">{k.value}</div>
              <div className="docpage__kpi-label">{k.label}</div>
            </div>
          ))}
        </div>
      ) : null}
      {doc.sections.map((s, i) => (
        <section className="docpage__section" key={i}>
          <h3>{s.heading}</h3>
          {s.body && <p>{s.body}</p>}
          {s.bullets?.length ? (
            <ul>{s.bullets.map((b, j) => <li key={j}>{b}</li>)}</ul>
          ) : null}
          {s.table && <MiniTable columns={s.table.columns} rows={s.table.rows} />}
        </section>
      ))}
    </div>
  );
}

function DeckPreview({ doc }: { doc: DeckDoc }) {
  return (
    <div className="docpage__slides">
      {doc.slides.map((s, i) => (
        <div className="docpage__slide" key={i}>
          <div className="docpage__slide-num">{i + 1}</div>
          <div className="docpage__slide-body">
            <h3>{s.title}</h3>
            {s.bullets?.length ? <ul>{s.bullets.map((b, j) => <li key={j}>{b}</li>)}</ul> : null}
            {s.table && <MiniTable columns={s.table.columns} rows={s.table.rows} />}
          </div>
        </div>
      ))}
    </div>
  );
}

function MiniTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  return (
    <table className="docpage__table">
      <thead>
        <tr>{columns.map((c, i) => <th key={i}>{c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.slice(0, 8).map((r, i) => (
          <tr key={i}>{columns.map((_, j) => <td key={j}>{r[j] ?? ""}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}
