import { useEffect, useState } from "react";
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { Users, Eye, MousePointerClick, TrendingDown } from "lucide-react";
import { query } from "./data";
import { selectFeature } from "./selection";

const ACCENT = "#4f46e5";
const SERIES = ["#4f46e5", "#818cf8", "#94a3b8", "#cbd5e1"];
const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : `${Math.round(n)}`;

export default function App() {
  const [kpis, setKpis] = useState<any>(null);
  const [trend, setTrend] = useState<any[]>([]);
  const [sources, setSources] = useState<any[]>([]);
  const [devices, setDevices] = useState<any[]>([]);
  const [pages, setPages] = useState<any[]>([]);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [t, s, d, p] = await Promise.all([
          query(`SELECT date_trunc('month', date) AS month, SUM(sessions) AS sessions,
                  AVG(bounce_rate) AS bounce FROM traffic GROUP BY month ORDER BY month`),
          query(`SELECT source, SUM(sessions) AS sessions FROM traffic GROUP BY source ORDER BY sessions DESC`),
          query(`SELECT device, SUM(sessions) AS sessions FROM traffic GROUP BY device ORDER BY sessions DESC`),
          query(`SELECT landing_page AS page, SUM(sessions) AS sessions, AVG(conversion_rate) AS cvr
                  FROM traffic GROUP BY landing_page ORDER BY sessions DESC LIMIT 8`),
        ]);
        const sessions = s.reduce((a: number, x: any) => a + Number(x.sessions || 0), 0);
        const pv = await query(`SELECT SUM(pageviews) AS pv, AVG(bounce_rate) AS bounce, AVG(conversion_rate) AS cvr FROM traffic`);
        const last = Number(t[t.length - 1]?.sessions || 0);
        const prev = Number(t[t.length - 2]?.sessions || 0);
        setKpis({
          sessions, pageviews: Number(pv[0]?.pv || 0),
          bounce: Number(pv[0]?.bounce || 0) * 100,
          cvr: Number(pv[0]?.cvr || 0) * 100,
          sessDelta: prev ? ((last - prev) / prev) * 100 : 0,
        });
        setTrend(t.map((x: any) => ({ month: String(x.month).slice(0, 7), sessions: Number(x.sessions || 0) })));
        setSources(s.map((x: any) => ({ source: x.source, sessions: Number(x.sessions || 0) })));
        setDevices(d.map((x: any) => ({ device: x.device, sessions: Number(x.sessions || 0) })));
        setPages(p);
      } catch (e: any) {
        setError(e?.message ?? "Failed to load data");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 font-sans">
        <div className="max-w-7xl mx-auto p-6 md:p-8">
          <div className="h-8 w-64 bg-slate-200 rounded animate-pulse mb-8" />
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-28 bg-white rounded-xl border border-slate-200 animate-pulse" />)}
          </div>
        </div>
      </div>
    );
  }

  if (error || !kpis || trend.length === 0) {
    return (
      <div className="min-h-screen bg-slate-50 font-sans grid place-items-center">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 text-center max-w-md">
          <Users className="h-8 w-8 text-slate-400 mx-auto mb-3" />
          <p className="text-sm text-slate-500">{error ?? "No traffic data available."}</p>
        </div>
      </div>
    );
  }

  const cards = [
    { label: "Sessions", value: compact(kpis.sessions), icon: Users, delta: kpis.sessDelta, goodUp: true },
    { label: "Pageviews", value: compact(kpis.pageviews), icon: Eye, delta: null, goodUp: true },
    { label: "Bounce Rate", value: `${kpis.bounce.toFixed(1)}%`, icon: TrendingDown, delta: null, goodUp: false },
    { label: "Conversion Rate", value: `${kpis.cvr.toFixed(1)}%`, icon: MousePointerClick, delta: null, goodUp: true },
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <div className="max-w-7xl mx-auto p-6 md:p-8">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">Traffic Overview</h1>
          <p className="text-sm text-slate-500">Sessions, engagement, and acquisition channels</p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 mb-6">
          {cards.map((c) => (
            <div key={c.label} className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-indigo-50 text-indigo-600 grid place-items-center"><c.icon size={20} /></div>
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{c.label}</span>
              </div>
              <div className="text-3xl font-semibold tabular-nums">{c.value}</div>
              {c.delta !== null && (
                <div className={`mt-1 text-sm ${(c.delta >= 0) === c.goodUp ? "text-emerald-600" : "text-rose-600"}`}>
                  {c.delta >= 0 ? "▲" : "▼"} {Math.abs(c.delta).toFixed(1)}% vs prior month
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mb-6">
          <div className="xl:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <h2 className="text-sm font-medium text-slate-700 mb-4">Sessions Over Time</h2>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={trend}>
                <defs>
                  <linearGradient id="sess" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={ACCENT} stopOpacity={0.25} />
                    <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: "#64748b", fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#64748b", fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={compact} />
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} />
                <Area type="monotone" dataKey="sessions" stroke={ACCENT} strokeWidth={2} fill="url(#sess)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <h2 className="text-sm font-medium text-slate-700 mb-4">Sessions by Device</h2>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={devices} dataKey="sessions" nameKey="device" innerRadius={55} outerRadius={90} paddingAngle={2}>
                  {devices.map((_, i) => <Cell key={i} fill={SERIES[i % SERIES.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <h2 className="text-sm font-medium text-slate-700 mb-4">Sessions by Source</h2>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={sources} layout="vertical">
                <CartesianGrid stroke="#e2e8f0" horizontal={false} />
                <XAxis type="number" tick={{ fill: "#64748b", fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={compact} />
                <YAxis type="category" dataKey="source" width={80} tick={{ fill: "#64748b", fontSize: 12 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} cursor={{ fill: "#f1f5f9" }} />
                <Bar
                  dataKey="sessions" radius={[0, 4, 4, 0]} cursor="pointer"
                  onClick={(d: any) => {
                    setActiveSource(d.source);
                    selectFeature({ title: `Source: ${d.source}`, type: "bar", tableName: "traffic", description: "Traffic from the selected source", query: `SELECT * FROM traffic WHERE source = '${d.source}'` });
                  }}
                >
                  {sources.map((s, i) => <Cell key={i} fill={activeSource && activeSource !== s.source ? "#c7d2fe" : ACCENT} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="xl:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <h2 className="text-sm font-medium text-slate-700 mb-4">Top Landing Pages</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                  <th className="text-left font-medium py-2">Page</th>
                  <th className="text-right font-medium py-2">Sessions</th>
                  <th className="text-right font-medium py-2">Conv. Rate</th>
                </tr>
              </thead>
              <tbody>
                {pages.map((p: any, i) => (
                  <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="py-2.5 font-mono text-xs">{String(p.page)}</td>
                    <td className="py-2.5 text-right tabular-nums">{compact(Number(p.sessions))}</td>
                    <td className="py-2.5 text-right tabular-nums">{(Number(p.cvr) * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
