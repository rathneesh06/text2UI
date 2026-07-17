// bff/dashboard/renderer.ts — the deterministic renderer. Turns a compiled RenderPlan
// into a GeneratedApp whose single App.tsx is a FIXED, hand-written React component
// (never model-authored). It reads the inlined plan, runs each widget's pre-built SQL
// through ./data's query(), and draws KPIs/charts/tables with recharts. Because the
// component is fixed and the SQL is pre-validated, the output can't fail to compile and
// can't contain a bad dialect call — the two failure modes that plagued free codegen.
import type { GeneratedApp } from "../../shared/types";
import type { RenderPlan } from "../../shared/dashboard-spec";

// NOTE: the App body below deliberately avoids template literals and backticks so it
// can live inside this template string; the only injection point is ${planJson}.
export function renderPlanToApp(plan: RenderPlan): GeneratedApp {
  const planJson = JSON.stringify(plan);
  const content = `import React, { useState, useEffect } from "react";
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";
import { query } from "./data";
import { selectFeature } from "./selection";

const PLAN = ${planJson};
const HEX = /^#[0-9a-fA-F]{3,8}$/;
const DARK = !!(PLAN.meta && PLAN.meta.theme === "dark");
const ACCENT = PLAN.meta && HEX.test(String(PLAN.meta.accent || "")) ? PLAN.meta.accent : "#4f46e5";
const PAL = PLAN.meta && Array.isArray(PLAN.meta.chartPalette) ? PLAN.meta.chartPalette.filter(function (c) { return HEX.test(String(c)); }) : [];
const COLORS = PAL.length ? PAL : [ACCENT, "#818cf8", "#a5b4fc", "#64748b", "#94a3b8", "#c7d2fe"];
// COMPACT MODE: small dashboards should fit with little to no scrolling. When the
// board is small (few widgets / few charts), shrink chart heights, paddings, gaps,
// and type so the whole thing reads at a glance instead of stretching a sparse
// layout across three screens.
const N_WIDGETS = PLAN.sections.reduce(function (n, s) { return n + s.widgets.length; }, 0);
const N_CHARTS = PLAN.sections.reduce(function (n, s) { return n + s.widgets.filter(function (cw) { return cw.widget.kind !== "kpi" && cw.widget.kind !== "table"; }).length; }, 0);
const COMPACT = N_WIDGETS <= 7 || N_CHARTS <= 3;
const CHART_H = COMPACT ? 165 : 210;
const PIE_R = COMPACT ? { inner: 42, outer: 70 } : { inner: 55, outer: 90 };
const PAD = COMPACT ? " p-2.5" : " p-3";
const GAP = COMPACT ? "grid grid-cols-12 gap-2" : "grid grid-cols-12 gap-2.5";
const SECTION_MT = COMPACT ? "mt-2.5" : "mt-4";
const KPI_TXT = COMPACT ? " text-xl" : " text-2xl";
const CARD_CLS = (DARK ? " bg-slate-900 rounded-xl border border-slate-800 shadow-sm" : " bg-white rounded-xl border border-slate-200 shadow-sm") + PAD;
const TICK = DARK ? "#94a3b8" : "#64748b";
const GRID = DARK ? "#334155" : "#e2e8f0";

function fmt(v, format) {
  if (v === null || v === undefined) return "\u2014";
  const n = typeof v === "number" ? v : Number(v);
  if (!isFinite(n)) return String(v);
  if (format === "percent") return n.toFixed(1) + "%";
  if (format === "currency") return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (format === "hours") return n.toLocaleString(undefined, { maximumFractionDigits: 1 }) + "h";
  if (format === "days") return n.toLocaleString(undefined, { maximumFractionDigits: 1 }) + "d";
  if (format === "compact") return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
  return n.toLocaleString();
}
function prettyHeader(h) {
  let t = String(h);
  let i = t.length;
  while (i > 0 && t.charCodeAt(i - 1) >= 48 && t.charCodeAt(i - 1) <= 57) i--;
  if (i < t.length && i > 0 && t.charAt(i - 1) === "_") t = t.slice(0, i - 1);
  t = t.split("_").filter(function (p) { return p.length; }).join(" ").trim();
  return t || String(h);
}
function fmtX(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.length >= 19 && s.charAt(4) === "-" && s.charAt(7) === "-" && (s.charAt(10) === "T" || s.charAt(10) === " ")) return s.slice(0, 10);
  return s;
}
function widthClass(w) {
  const map = { quarter: "md:col-span-3", third: "md:col-span-4", half: "md:col-span-6", full: "md:col-span-12" };
  return "col-span-12 " + (map[w] || "md:col-span-6");
}
function useRows(sql) {
  const [state, setState] = useState({ rows: null, loading: true, error: null });
  useEffect(function () {
    let alive = true;
    setState({ rows: null, loading: true, error: null });
    query(sql).then(function (rows) { if (alive) setState({ rows: rows, loading: false, error: null }); })
      .catch(function (e) { if (alive) setState({ rows: null, loading: false, error: (e && e.message) || "query failed" }); });
    return function () { alive = false; };
  }, [sql]);
  return state;
}
function Loading() { return <div className={(COMPACT ? "h-28" : "h-40") + " animate-pulse rounded-lg bg-slate-100"} />; }
function ErrorBox(props) { return <div className="text-sm text-rose-600">Could not load: {props.msg}</div>; }
function Empty() { return <div className="text-sm text-slate-400">No data</div>; }
function Card(props) {
  return (
    <div className={widthClass(props.width) + CARD_CLS}>
      {props.title ? <div className={"text-sm font-medium " + (DARK ? "text-slate-200" : "text-slate-700")}>{props.title}</div> : null}
      {props.subtitle ? <div className="text-xs text-slate-400 mb-1.5">{props.subtitle}</div> : <div className="mb-1" />}
      {props.children}
    </div>
  );
}
function kpiGlyph(w) {
  const f = (w.metric && w.metric.format) || w.format || "";
  const a = (w.metric && w.metric.agg) || "";
  if (f === "currency") return "$";
  if (f === "percent") return "%";
  if (f === "hours" || f === "days") return "\u23F1";
  if (a === "avg" || a === "median") return "\u00D8";
  if (a === "count_distinct") return "\u2211";
  return "#";
}
function Kpi(props) {
  const w = props.w;
  const s = useRows(props.sql);
  const value = s.rows && s.rows[0] ? s.rows[0].value : null;
  const chip = COLORS[(props.idx || 0) % COLORS.length];
  return (
    <div className={widthClass(w.width || "quarter") + CARD_CLS + " cursor-pointer"}
         onClick={function () { if (selectFeature) selectFeature({ id: w.id, title: w.title, type: "kpi", kind: "kpi", query: props.sql }); }}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 pt-1">{w.title}</div>
        <div className="flex-none flex items-center justify-center rounded-lg font-semibold"
             style={{ width: 30, height: 30, fontSize: 14, color: chip, background: chip + (DARK ? "2e" : "1a") }}>{kpiGlyph(w)}</div>
      </div>
      {s.loading ? <div className="mt-2 h-8 w-24 animate-pulse rounded bg-slate-100" />
        : s.error ? <ErrorBox msg={s.error} />
        : <div className={"mt-0.5 font-bold tabular-nums tracking-tight" + KPI_TXT} style={{ color: ACCENT }}>{fmt(value, (w.metric && w.metric.format) || w.format)}</div>}
      {w.subtitle ? <div className="mt-0.5 text-xs text-slate-400">{w.subtitle}</div> : null}
    </div>
  );
}
function Chart(props) {
  const w = props.w;
  const keys = props.seriesKeys || [];
  const s = useRows(props.sql);
  const data = (s.rows || []).map(function (r) {
    const o = { x: fmtX(r.x) };
    keys.forEach(function (k) { o[k.key] = (r[k.key] === null || r[k.key] === undefined) ? 0 : Number(r[k.key]); });
    return o;
  });
  function body() {
    if (s.loading) return <Loading />;
    if (s.error) return <ErrorBox msg={s.error} />;
    if (!data.length) return <Empty />;
    if (w.kind === "pie" || w.kind === "donut") {
      const k = keys[0] ? keys[0].key : "value";
      const pdata = data.map(function (d) { return { name: d.x, value: d[k] }; });
      return (
        <ResponsiveContainer width="100%" height={CHART_H}>
          <PieChart>
            <Pie data={pdata} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={w.kind === "donut" ? PIE_R.inner : 0} outerRadius={PIE_R.outer}>
              {pdata.map(function (e, i) { return <Cell key={i} fill={COLORS[i % COLORS.length]} />; })}
            </Pie>
            <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      );
    }
    const Cmp = w.kind === "bar" ? BarChart : w.kind === "area" ? AreaChart : LineChart;
    return (
      <ResponsiveContainer width="100%" height={CHART_H}>
        <Cmp data={data}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="x" tick={{ fill: TICK, fontSize: 12 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: TICK, fontSize: 12 }} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} />
          {keys.length > 1 ? <Legend /> : null}
          {keys.map(function (k, i) {
            if (w.kind === "bar") {
              if (keys.length === 1) {
                return (
                  <Bar key={k.key} dataKey={k.key} name={k.label} radius={[5, 5, 0, 0]}>
                    {data.map(function (_e, ci) { return <Cell key={ci} fill={COLORS[ci % COLORS.length]} />; })}
                  </Bar>
                );
              }
              return <Bar key={k.key} dataKey={k.key} name={k.label} fill={COLORS[i % COLORS.length]} radius={[5, 5, 0, 0]} />;
            }
            if (w.kind === "area") {
              const gid = "g_" + w.id + "_" + i;
              return (
                <React.Fragment key={k.key}>
                  <defs>
                    <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={COLORS[i % COLORS.length]} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={COLORS[i % COLORS.length]} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <Area dataKey={k.key} name={k.label} stroke={COLORS[i % COLORS.length]} fill={"url(#" + gid + ")"} strokeWidth={2.5} />
                </React.Fragment>
              );
            }
            return <Line key={k.key} dataKey={k.key} name={k.label} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} />;
          })}
        </Cmp>
      </ResponsiveContainer>
    );
  }
  return (
    <Card width={w.width || "half"} title={w.title} subtitle={w.subtitle}>
      <div onClick={function () { if (selectFeature) selectFeature({ id: w.id, title: w.title, type: "chart", kind: w.kind, query: props.sql }); }}>{body()}</div>
    </Card>
  );
}
function DataTable(props) {
  const w = props.w;
  const s = useRows(props.sql);
  const rows = s.rows || [];
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return (
    <Card width={w.width || "full"} title={w.title} subtitle={w.subtitle}>
      <div onClick={function () { if (selectFeature) selectFeature({ id: w.id, title: w.title, type: "table", kind: "table", query: props.sql }); }}>
      {s.loading ? <Loading /> : s.error ? <ErrorBox msg={s.error} /> : !rows.length ? <Empty /> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className={"text-xs uppercase tracking-wide text-slate-500 border-b " + (DARK ? "border-slate-700" : "border-slate-200")}>
                {headers.map(function (h) { return <th key={h} className="text-left py-1.5 pr-3">{prettyHeader(h)}</th>; })}
              </tr>
            </thead>
            <tbody>
              {rows.map(function (r, ri) {
                return (
                  <tr key={ri} className={DARK ? "border-b border-slate-800 hover:bg-slate-800/50" : "border-b border-slate-100 hover:bg-slate-50"}>
                    {headers.map(function (h) {
                      const v = r[h];
                      const num = typeof v === "number";
                      return <td key={h} className={"py-1.5 pr-3 " + (num ? "text-right tabular-nums" : "")}>{num ? Number(v).toLocaleString() : fmtX(v)}</td>;
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      </div>
    </Card>
  );
}
function Widget(props) {
  const w = props.cw.widget;
  if (w.kind === "kpi") return <Kpi w={w} sql={props.cw.sql} idx={props.idx} />;
  if (w.kind === "table") return <DataTable w={w} sql={props.cw.sql} />;
  return <Chart w={w} sql={props.cw.sql} seriesKeys={props.cw.seriesKeys} />;
}
export default function App() {
  return (
    <div className={"min-h-screen font-sans " + (DARK ? "bg-slate-950 text-slate-100" : "bg-slate-50 text-slate-900")}>
      <div className="mx-auto p-3 md:p-4" style={{ maxWidth: "1600px" }}>
        <h1 className="text-2xl font-bold tracking-tight">{PLAN.meta.title}</h1>
        {PLAN.meta.subtitle ? <p className={"text-sm mt-1 " + (DARK ? "text-slate-400" : "text-slate-500")}>{PLAN.meta.subtitle}</p> : null}
        {PLAN.meta.insight ? (
          <div className="mt-3 rounded-xl px-4 py-3 text-sm font-medium text-white flex items-center gap-3"
               style={{ background: "linear-gradient(90deg, " + ACCENT + ", " + (COLORS[1] || ACCENT) + ")" }}>
            <span className="flex-none inline-flex items-center justify-center rounded-lg bg-white/20" style={{ width: 26, height: 26 }}>{"\u2726"}</span>
            <span>{PLAN.meta.insight}</span>
          </div>
        ) : null}
        {PLAN.sections.map(function (sec) {
          return (
            <div key={sec.id} className={SECTION_MT}>
              {sec.title ? <div className={"text-sm font-semibold mb-1.5 " + (DARK ? "text-slate-300" : "text-slate-700")}>{sec.title}</div> : null}
              <div className={GAP}>
                {sec.widgets.map(function (cw, wi) { return <Widget key={cw.widget.id} cw={cw} idx={wi} />; })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
//__END__
`;
  return { files: [{ path: "App.tsx", content }], summary: plan.meta.title };
}