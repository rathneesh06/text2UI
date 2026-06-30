import { useEffect, useState } from "react";
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { DollarSign, TrendingUp, ShoppingCart, Percent } from "lucide-react";
import { query } from "./data";
import { selectFeature } from "./selection";

const ACCENT = "#4f46e5";
const SERIES = ["#4f46e5", "#818cf8", "#94a3b8", "#cbd5e1"];
const usd = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `$${(n / 1_000).toFixed(1)}K` : `$${Math.round(n)}`;

interface Kpis { revenue: number; orders: number; profit: number; margin: number; revDelta: number; }

export default function App() {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [trend, setTrend] = useState<any[]>([]);
  const [regions, setRegions] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [topProducts, setTopProducts] = useState<any[]>([]);
  const [activeRegion, setActiveRegion] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [k, t, r, c, p] = await Promise.all([
          query(`SELECT SUM(amount) AS revenue, COUNT(*) AS orders, SUM(profit) AS profit,
                  date_trunc('month', order_date) AS m FROM sales GROUP BY m ORDER BY m`),
          query(`SELECT date_trunc('month', order_date) AS month, SUM(amount) AS revenue
                  FROM sales GROUP BY month ORDER BY month`),
          query(`SELECT region, SUM(amount) AS revenue FROM sales GROUP BY region ORDER BY revenue DESC`),
          query(`SELECT category, SUM(amount) AS revenue FROM sales GROUP BY category ORDER BY revenue DESC`),
          query(`SELECT product, SUM(amount) AS revenue, SUM(profit) AS profit, COUNT(*) AS orders
                  FROM sales GROUP BY product ORDER BY revenue DESC LIMIT 8`),
        ]);
        const revenue = t.reduce((s: number, x: any) => s + Number(x.revenue || 0), 0);
        const orders = k.reduce((s: number, x: any) => s + Number(x.orders || 0), 0);
        const profit = k.reduce((s: number, x: any) => s + Number(x.profit || 0), 0);
        const last = Number(t[t.length - 1]?.revenue || 0);
        const prev = Number(t[t.length - 2]?.revenue || 0);
        setKpis({
          revenue, orders, profit,
          margin: revenue ? (profit / revenue) * 100 : 0,
          revDelta: prev ? ((last - prev) / prev) * 100 : 0,
        });
        setTrend(t.map((x: any) => ({ month: String(x.month).slice(0, 7), revenue: Number(x.revenue || 0) })));
        setRegions(r.map((x: any) => ({ region: x.region, revenue: Number(x.revenue || 0) })));
        setCategories(c.map((x: any) => ({ category: x.category, revenue: Number(x.revenue || 0) })));
        setTopProducts(p);
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
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 mb-6">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-28 bg-white rounded-xl border border-slate-200 animate-pulse" />)}
          </div>
          <div className="h-80 bg-white rounded-xl border border-slate-200 animate-pulse" />
        </div>
      </div>
    );
  }

  if (error || !kpis || trend.length === 0) {
    return (
      <div className="min-h-screen bg-slate-50 font-sans grid place-items-center">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 text-center max-w-md">
          <ShoppingCart className="h-8 w-8 text-slate-400 mx-auto mb-3" />
          <p className="text-sm text-slate-500">{error ?? "No sales data available."}</p>
        </div>
      </div>
    );
  }

  const kpiCards = [
    { label: "Total Revenue", value: usd(kpis.revenue), icon: DollarSign, delta: kpis.revDelta },
    { label: "Orders", value: kpis.orders.toLocaleString(), icon: ShoppingCart, delta: null },
    { label: "Gross Profit", value: usd(kpis.profit), icon: TrendingUp, delta: null },
    { label: "Margin", value: `${kpis.margin.toFixed(1)}%`, icon: Percent, delta: null },
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <div className="max-w-7xl mx-auto p-6 md:p-8">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">Sales Overview</h1>
          <p className="text-sm text-slate-500">Revenue, profitability, and product performance</p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 mb-6">
          {kpiCards.map((c) => (
            <div key={c.label} className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-indigo-50 text-indigo-600 grid place-items-center">
                  <c.icon size={20} />
                </div>
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{c.label}</span>
              </div>
              <div className="text-3xl font-semibold tabular-nums">{c.value}</div>
              {c.delta !== null && (
                <div className={`mt-1 text-sm ${c.delta >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                  {c.delta >= 0 ? "▲" : "▼"} {Math.abs(c.delta).toFixed(1)}% vs prior month
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mb-6">
          <div className="xl:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <h2 className="text-sm font-medium text-slate-700 mb-4">Revenue Trend</h2>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={trend}>
                <defs>
                  <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={ACCENT} stopOpacity={0.25} />
                    <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: "#64748b", fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#64748b", fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={usd} />
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} formatter={(v: any) => usd(Number(v))} />
                <Area type="monotone" dataKey="revenue" stroke={ACCENT} strokeWidth={2} fill="url(#rev)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <h2 className="text-sm font-medium text-slate-700 mb-4">Revenue by Category</h2>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={categories} dataKey="revenue" nameKey="category" innerRadius={55} outerRadius={90} paddingAngle={2}>
                  {categories.map((_, i) => <Cell key={i} fill={SERIES[i % SERIES.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} formatter={(v: any) => usd(Number(v))} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <h2 className="text-sm font-medium text-slate-700 mb-4">Revenue by Region</h2>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={regions}>
                <CartesianGrid stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="region" tick={{ fill: "#64748b", fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#64748b", fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={usd} />
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} formatter={(v: any) => usd(Number(v))} />
                <Bar
                  dataKey="revenue" radius={[4, 4, 0, 0]} cursor="pointer"
                  onClick={(d: any) => {
                    setActiveRegion(d.region);
                    selectFeature({ title: `Region: ${d.region}`, type: "bar", tableName: "sales", description: "Revenue for the selected region", query: `SELECT * FROM sales WHERE region = '${d.region}'` });
                  }}
                >
                  {regions.map((r, i) => (
                    <Cell key={i} fill={activeRegion && activeRegion !== r.region ? "#c7d2fe" : ACCENT} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="xl:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <h2 className="text-sm font-medium text-slate-700 mb-4">Top Products</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                  <th className="text-left font-medium py-2">Product</th>
                  <th className="text-right font-medium py-2">Orders</th>
                  <th className="text-right font-medium py-2">Profit</th>
                  <th className="text-right font-medium py-2">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {topProducts.map((p: any, i) => (
                  <tr
                    key={i}
                    className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                    onClick={() => selectFeature({ title: String(p.product), type: "row", tableName: "sales", description: "Selected product", query: `SELECT * FROM sales WHERE product = '${p.product}'` })}
                  >
                    <td className="py-2.5">{String(p.product)}</td>
                    <td className="py-2.5 text-right tabular-nums">{Number(p.orders).toLocaleString()}</td>
                    <td className="py-2.5 text-right tabular-nums">{usd(Number(p.profit))}</td>
                    <td className="py-2.5 text-right tabular-nums font-medium">{usd(Number(p.revenue))}</td>
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
