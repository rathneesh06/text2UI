// src/components/DeckPreview.tsx — renders a CompiledDeck as scrollable 16:9 slide cards
// in the app (no PPTX-in-browser, no sandbox). Because the deck is already compiled
// (chart/KPI/table data resolved server-side), this is pure rendering and matches the
// downloaded .pptx. Charts are drawn as lightweight inline SVG (no chart dependency).
import { useMemo, useEffect, useState } from "react";
import type { CompiledDeck, CompiledSlide, CompiledBlock, ResolvedChart } from "../../shared/deck-spec";
import { renderDeckPreview } from "../api";
import "./DeckPreview.css";

const COLORS = ["#4F46E5", "#06B6D4", "#818CF8", "#94A3B8", "#A5B4FC", "#C7D2FE"];
const fmtNum = (n: number) =>
  Math.abs(n) >= 1000 ? Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n) : String(Math.round(n * 10) / 10);

function BarSvg({ chart }: { chart: ResolvedChart }) {
  const labels = chart.labels.map(String);
  const values = chart.series[0]?.values ?? [];
  const max = Math.max(1, ...values);
  const W = 600, H = 220, pad = 28, bw = (W - pad * 2) / Math.max(1, values.length);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="dp-svg" preserveAspectRatio="xMidYMid meet">
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="#E2E8F0" />
      {values.map((v, i) => {
        const h = ((v / max) * (H - pad * 2));
        const x = pad + i * bw + bw * 0.15;
        return (
          <g key={i}>
            <rect x={x} y={H - pad - h} width={bw * 0.7} height={h} rx={3} fill={COLORS[0]} />
            <text x={x + bw * 0.35} y={H - pad + 12} textAnchor="middle" className="dp-axis">{labels[i]?.slice(0, 10)}</text>
          </g>
        );
      })}
    </svg>
  );
}

function LineSvg({ chart, area }: { chart: ResolvedChart; area?: boolean }) {
  const labels = chart.labels.map(String);
  const W = 600, H = 220, pad = 28;
  const all = chart.series.flatMap((s) => s.values);
  const max = Math.max(1, ...all), min = Math.min(0, ...all);
  const xat = (i: number) => pad + (i * (W - pad * 2)) / Math.max(1, labels.length - 1);
  const yat = (v: number) => H - pad - ((v - min) / (max - min || 1)) * (H - pad * 2);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="dp-svg" preserveAspectRatio="xMidYMid meet">
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="#E2E8F0" />
      {chart.series.map((s, si) => {
        const pts = s.values.map((v, i) => `${xat(i)},${yat(v)}`).join(" ");
        const color = COLORS[si % COLORS.length];
        return (
          <g key={si}>
            {area && <polygon points={`${pad},${H - pad} ${pts} ${W - pad},${H - pad}`} fill={color} opacity={0.12} />}
            <polyline points={pts} fill="none" stroke={color} strokeWidth={2.5} />
          </g>
        );
      })}
      {labels.map((l, i) => (i % Math.ceil(labels.length / 6 || 1) === 0 ? <text key={i} x={xat(i)} y={H - pad + 12} textAnchor="middle" className="dp-axis">{l.slice(0, 10)}</text> : null))}
    </svg>
  );
}

function PieSvg({ chart }: { chart: ResolvedChart }) {
  const labels = chart.labels.map(String);
  const values = chart.series[0]?.values ?? [];
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const cx = 110, cy = 110, r = 95;
  let acc = 0;
  const arc = (frac: number) => { const a = acc * 2 * Math.PI - Math.PI / 2; acc += frac; const b = acc * 2 * Math.PI - Math.PI / 2; return { x1: cx + r * Math.cos(a), y1: cy + r * Math.sin(a), x2: cx + r * Math.cos(b), y2: cy + r * Math.sin(b), large: frac > 0.5 ? 1 : 0 }; };
  return (
    <svg viewBox="0 0 420 220" className="dp-svg" preserveAspectRatio="xMidYMid meet">
      {values.map((v, i) => { const { x1, y1, x2, y2, large } = arc(v / total); return <path key={i} d={`M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} Z`} fill={COLORS[i % COLORS.length]} />; })}
      {labels.map((l, i) => (
        <g key={i} transform={`translate(230, ${30 + i * 26})`}>
          <rect width={12} height={12} rx={2} fill={COLORS[i % COLORS.length]} />
          <text x={18} y={10} className="dp-legend">{l.slice(0, 22)} · {fmtNum(values[i])}</text>
        </g>
      ))}
    </svg>
  );
}

function Chart({ chart }: { chart: ResolvedChart }) {
  if (chart.chartType === "pie") return <PieSvg chart={chart} />;
  if (chart.chartType === "bar") return <BarSvg chart={chart} />;
  return <LineSvg chart={chart} area={chart.chartType === "area"} />;
}

function VisualCell({ cb }: { cb: CompiledBlock }) {
  const cap = (cb.block as any).title as string | undefined;
  return (
    <div className="dp-cell">
      {cap && <div className="dp-cell-cap">{cap}</div>}
      {cb.chart ? <div className="dp-chart"><Chart chart={cb.chart} /></div>
        : cb.image ? <div className="dp-image"><img src={cb.image.dataUrl} alt={cb.image.caption ?? ""} /></div>
        : cb.table ? (
          <div className="dp-table-wrap">
            <table className="dp-table">
              <thead><tr>{cb.table.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{cb.table.rows.slice(0, 8).map((r, ri) => <tr key={ri}>{r.map((v, ci) => <td key={ci}>{typeof v === "number" ? fmtNum(v) : String(v)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        ) : null}
    </div>
  );
}

function SlideCard({ slide, index, total, dark }: { slide: CompiledSlide; index: number; total: number; dark: boolean }) {
  const hero = slide.role === "title" || slide.role === "section";
  const kpis = slide.blocks.filter((b) => b.kpis).flatMap((b) => b.kpis!).slice(0, 6);
  const visuals = slide.blocks.filter((b) => b.chart || b.table || b.image).slice(0, 4);
  const bullets = slide.blocks.find((b) => b.block.type === "bullets");
  const callout = slide.blocks.find((b) => b.block.type === "callout");
  const gridClass = `dp-grid dp-grid--${Math.min(visuals.length, 4)}`;

  return (
    <div className={`dp-slide ${dark ? "dp-slide--dark" : ""} ${hero ? "dp-slide--hero" : ""} ${slide.role === "section" ? "dp-slide--section" : ""}`}>
      <div className="dp-slide-num">{index + 1} / {total}</div>
      {hero ? (
        <div className="dp-hero">
          <div className="dp-hero-rule" />
          <h1 className="dp-hero-title">{slide.title}</h1>
          {slide.message && <p className="dp-hero-sub">{slide.message}</p>}
        </div>
      ) : (
        <>
          <h2 className="dp-title">{slide.title}</h2>
          {slide.message && <div className="dp-message">{slide.message}</div>}
          <div className="dp-divider" />
          <div className="dp-body">
            {kpis.length > 0 && (
              <div className="dp-kpis">
                {kpis.map((k, i) => <div key={i} className="dp-kpi"><div className="dp-kpi-label">{k.label}</div><div className="dp-kpi-value">{k.value}</div></div>)}
              </div>
            )}
            {visuals.length === 1 && bullets && bullets.block.type === "bullets" ? (
              <div className="dp-split">
                <VisualCell cb={visuals[0]} />
                <ul className="dp-bullets">{bullets.block.items.map((t, i) => <li key={i}>{t}</li>)}</ul>
              </div>
            ) : visuals.length > 0 ? (
              <div className={gridClass}>{visuals.map((cb, i) => <VisualCell key={i} cb={cb} />)}</div>
            ) : bullets && bullets.block.type === "bullets" ? (
              <ul className="dp-bullets">{bullets.block.items.map((t, i) => <li key={i}>{t}</li>)}</ul>
            ) : kpis.length === 0 && !callout ? (
              <div className="dp-empty">No visuals on this slide</div>
            ) : null}
            {callout && callout.block.type === "callout" && (
              <div className={`dp-callout dp-callout--${callout.block.emphasis ?? "info"}`}>{callout.block.text}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function DeckPreview({ compiled, pptxBase64 }: { compiled: CompiledDeck; pptxBase64?: string }) {
  const slides = useMemo(() => compiled.slides ?? [], [compiled]);
  const dark = compiled.meta.theme === "dark";
  const [images, setImages] = useState<string[] | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "exact" | "fallback">("idle");

  // Fetch the exact rendered slides (real .pptx → images). Fall back to the SVG cards while
  // loading or if the server can't render (LibreOffice missing). Re-runs whenever the deck
  // changes (new pptxBase64), so edits refresh the exact preview.
  useEffect(() => {
    if (!pptxBase64) { setStatus("fallback"); return; }
    let cancelled = false;
    setStatus("loading");
    renderDeckPreview(pptxBase64).then((r) => {
      if (cancelled) return;
      if (r.images.length) { setImages(r.images); setStatus("exact"); }
      else { setImages(null); setStatus("fallback"); }
    }).catch(() => { if (!cancelled) setStatus("fallback"); });
    return () => { cancelled = true; };
  }, [pptxBase64]);

  if (status === "exact" && images) {
    return (
      <div className={"dp-root" + (dark ? " dp-root--dark" : "")}>
        {images.map((src, i) => (
          <div key={i} className="dp-exact">
            <img src={src} alt={`Slide ${i + 1}`} loading="lazy" />
            <div className="dp-slide-num">{i + 1} / {images.length}</div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={"dp-root" + (dark ? " dp-root--dark" : "")}>
      {status === "loading" && <div className="dp-rendering">Rendering exact preview…</div>}
      {slides.map((s, i) => <SlideCard key={s.id} slide={s} index={i} total={slides.length} dark={dark} />)}
    </div>
  );
}