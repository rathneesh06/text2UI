import { useEffect, useState } from "react";
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from "recharts";
import { Ticket, Clock, CheckCircle2, AlertCircle } from "lucide-react";
import { query } from "./data";
import { selectFeature } from "./selection";

const ACCENT = "#4f46e5";

export default function App() {
  const [kpis, setKpis] = useState<any>(null);
  const [trend, setTrend] = useState<any[]>([]);
  const [byCategory, setByCategory] = useState<any[]>([]);
  const [byPriority, setByPriority] = useState<any[]>([]);
  const [recent, setRecent] = useState<any[]>([]);
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [k, t, c, p, r] = await Promise.all([
          query(`SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
                  AVG(resolution_hours) AS avg_res FROM tickets`),
          query(`SELECT date_trunc('day', created_at) AS day, COUNT(*) AS tickets
                  FROM tickets GROUP BY day ORDER BY day`),
          query(`SELECT category, COUNT(*) AS tickets FROM tickets GROUP BY category ORDER BY tickets DESC`),
          query(`SELECT priority, COUNT(*) AS tickets FROM tickets GROUP BY priority ORDER BY tickets DESC`),
          query(`SELECT category, priority, status, agent, resolution_hours
                  FROM tickets ORDER BY created_at DESC LIMIT 8`),
        ]);
        const total = Number(k[0]?.total || 0);
        const open = Number(k[0]?.open || 0);
        setKpis({
          total, open, resolved: total - open,
          resolveRate: total ? ((total - open) / total) * 100 : 0,
          avgRes: Number(k[0]?.avg_res || 0),
        });
        setTrend(t.map((x: any) => ({ day: String(x.day).slice(5, 10), tickets: Number(x.tickets || 0) })));
        setByCategory(c.map((x: any) => ({ category: x.category, tickets: Number(x.tickets || 0) })));
        setByPriority(p.map((x: any) => ({ priority: x.priority, tickets: Number(x.tickets || 0) })));
        setRecent(r);
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

  if (error || !kpis || kpis.total === 0 || trend.length === 0) {
    return (
      <div className="min-h-screen bg-slate-50 font-sans grid place-items-center">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 text-center max-w-md">
          <Ticket className="h-8 w-8 text-slate-400 mx-auto mb-3" />
          <p className="text-sm text-slate-500">{error ?? "No records available."}</p>
        </div>
      </div>
    );
  }

  const cards = [
    { label: "Total Tickets", value: kpis.total.toLocaleString(), icon: Ticket },
    { label: "Open", value: kpis.open.toLocaleString(), icon: AlertCircle },
    { label: "Resolve Rate", value: `${kpis.resolveRate.toFixed(0)}%`, icon: CheckCircle2 },
    { label: "Avg Resolution", value: `${kpis.avgRes.toFixed(1)}h`, icon: Clock },
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <div className="max-w-7xl mx-auto p-6 md:p-8">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">Support Overview</h1>
          <p className="text-sm text-slate-500">Ticket volume, resolution, and breakdowns</p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 mb-6">
          {cards.map((c) => (
            <div key={c.label} className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-indigo-50 text-indigo-600 grid place-items-center"><c.icon size={20} /></div>
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{c.label}</span>
              </div>
              <div className="text-3xl font-semibold tabular-nums">{c.value}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mb-6">
          <div className="xl:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <h2 className="text-sm font-medium text-slate-700 mb-4">Daily Volume</h2>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={trend}>
                <defs>
                  <linearGradient id="vol" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={ACCENT} stopOpacity={0.25} />
                    <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="day" tick={{ fill: "#64748b", fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#64748b", fontSize: 12 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} />
                <Area type="monotone" dataKey="tickets" stroke={ACCENT} strokeWidth={2} fill="url(#vol)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <h2 className="text-sm font-medium text-slate-700 mb-4">By Priority</h2>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={byPriority}>
                <CartesianGrid stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="priority" tick={{ fill: "#64748b", fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#64748b", fontSize: 12 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} cursor={{ fill: "#f1f5f9" }} />
                <Bar dataKey="tickets" fill={ACCENT} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <h2 className="text-sm font-medium text-slate-700 mb-4">By Category</h2>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={byCategory} layout="vertical">
                <CartesianGrid stroke="#e2e8f0" horizontal={false} />
                <XAxis type="number" tick={{ fill: "#64748b", fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="category" width={90} tick={{ fill: "#64748b", fontSize: 12 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} cursor={{ fill: "#f1f5f9" }} />
                <Bar
                  dataKey="tickets" radius={[0, 4, 4, 0]} cursor="pointer"
                  onClick={(d: any) => {
                    setActiveCat(d.category);
                    selectFeature({ title: `Category: ${d.category}`, type: "bar", tableName: "tickets", description: "Tickets in the selected category", query: `SELECT * FROM tickets WHERE category = '${d.category}'` });
                  }}
                >
                  {byCategory.map((c, i) => <Cell key={i} fill={activeCat && activeCat !== c.category ? "#c7d2fe" : ACCENT} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="xl:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <h2 className="text-sm font-medium text-slate-700 mb-4">Recent Tickets</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                  <th className="text-left font-medium py-2">Category</th>
                  <th className="text-left font-medium py-2">Priority</th>
                  <th className="text-left font-medium py-2">Agent</th>
                  <th className="text-left font-medium py-2">Status</th>
                  <th className="text-right font-medium py-2">Hours</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((t: any, i) => (
                  <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="py-2.5">{String(t.category)}</td>
                    <td className="py-2.5">{String(t.priority)}</td>
                    <td className="py-2.5 text-slate-500">{String(t.agent)}</td>
                    <td className="py-2.5">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${t.status === "open" ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-600"}`}>
                        {String(t.status)}
                      </span>
                    </td>
                    <td className="py-2.5 text-right tabular-nums">{t.resolution_hours == null ? "—" : Number(t.resolution_hours).toFixed(1)}</td>
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
