import { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import {
  TrendingUp,
  Users,
  DollarSign,
  Percent,
  Filter,
  Sparkles,
  Layers,
  Globe,
  Briefcase,
} from "lucide-react";
import { query } from "./data";
import { selectFeature } from "./selection";

// Sunset Palette Colors
const COLORS = [
  "#ea580c", // Orange
  "#e11d48", // Rose
  "#d946ef", // Fuchsia
  "#f59e0b", // Amber
  "#14b8a6", // Teal
  "#8b5cf6", // Violet
  "#0ea5e9", // Sky
  "#84cc16", // Lime
];

export default function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [countries, setCountries] = useState<string[]>([]);
  const [industries, setIndustries] = useState<string[]>([]);
  const [selectedCountry, setSelectedCountry] = useState<string>("All");
  const [selectedIndustry, setSelectedIndustry] = useState<string>("All");

  // Data
  const [kpis, setKpis] = useState<any>(null);
  const [monthlyTrend, setMonthlyTrend] = useState<any[]>([]);
  const [statusDist, setStatusDist] = useState<any[]>([]);
  const [mrrByPlan, setMrrByPlan] = useState<any[]>([]);
  const [planTable, setPlanTable] = useState<any[]>([]);

  // Fetch filter options once
  useEffect(() => {
    async function fetchFilters() {
      try {
        const [cRes, iRes] = await Promise.all([
          query("SELECT DISTINCT country FROM data WHERE country IS NOT NULL ORDER BY country"),
          query("SELECT DISTINCT industry FROM data WHERE industry IS NOT NULL ORDER BY industry"),
        ]);
        setCountries(cRes.map((r) => String(r.country)));
        setIndustries(iRes.map((r) => String(r.industry)));
      } catch (e: any) {
        console.error("Failed to load filters", e);
      }
    }
    fetchFilters();
  }, []);

  // Fetch main dashboard data based on filters
  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      try {
        let whereClause = "WHERE 1=1";
        if (selectedCountry !== "All") {
          whereClause += ` AND country = '${selectedCountry}'`;
        }
        if (selectedIndustry !== "All") {
          whereClause += ` AND industry = '${selectedIndustry}'`;
        }

        // 1. KPIs
        // Active MRR, Churn Rate, ARPU, Total Seats
        // Plus MoM calculations
        const kpiQuery = `
          SELECT 
            SUM(CASE WHEN status = 'active' THEN mrr ELSE 0 END) as active_mrr,
            COUNT(CASE WHEN status = 'churned' THEN 1 END) as churned_count,
            COUNT(*) as total_count,
            AVG(CASE WHEN status = 'active' THEN mrr ELSE NULL END) as arpu,
            SUM(CASE WHEN status = 'active' THEN seats ELSE 0 END) as active_seats
          FROM data
          ${whereClause}
        `;

        // MoM comparison helper queries (using signup_date < '2024-11-01' as "previous" or similar, 
        // but since we have a single year 2024, let's look at the last 30 days vs previous for a robust delta)
        const momQuery = `
          SELECT 
            SUM(CASE WHEN status = 'active' AND signup_date < '2024-11-15' THEN mrr ELSE 0 END) as prev_active_mrr,
            COUNT(CASE WHEN status = 'churned' AND signup_date < '2024-11-15' THEN 1 END) as prev_churned,
            COUNT(CASE WHEN signup_date < '2024-11-15' THEN 1 END) as prev_total
          FROM data
          ${whereClause}
        `;

        // 2. Monthly Signups Trend
        const trendQuery = `
          SELECT 
            strftime(signup_date, '%Y-%m') as month,
            COUNT(*) as signups
          FROM data
          ${whereClause}
          GROUP BY month
          ORDER BY month ASC
        `;

        // 3. Status Distribution
        const statusQuery = `
          SELECT 
            status,
            COUNT(*) as count
          FROM data
          ${whereClause}
          GROUP BY status
          ORDER BY count DESC
        `;

        // 4. MRR by Plan
        const mrrPlanQuery = `
          SELECT 
            plan,
            SUM(mrr) as total_mrr
          FROM data
          ${whereClause}
          GROUP BY plan
          ORDER BY total_mrr DESC
        `;

        // 5. Plan Detail Table
        const planTableQuery = `
          SELECT 
            plan,
            COUNT(*) as customer_count,
            SUM(seats) as total_seats,
            SUM(mrr) as total_mrr
          FROM data
          ${whereClause}
          GROUP BY plan
          ORDER BY total_mrr DESC
        `;

        const [kRes, mRes, tRes, sRes, mpRes, ptRes] = await Promise.all([
          query(kpiQuery),
          query(momQuery),
          query(trendQuery),
          query(statusQuery),
          query(mrrPlanQuery),
          query(planTableQuery),
        ]);

        const activeMrr = Number(kRes[0]?.active_mrr || 0);
        const churnedCount = Number(kRes[0]?.churned_count || 0);
        const totalCount = Number(kRes[0]?.total_count || 0);
        const churnRate = totalCount > 0 ? (churnedCount / totalCount) * 100 : 0;
        const arpu = Number(kRes[0]?.arpu || 0);
        const activeSeats = Number(kRes[0]?.active_seats || 0);

        // MoM calculations
        const prevActiveMrr = Number(mRes[0]?.prev_active_mrr || 0);
        const prevChurned = Number(mRes[0]?.prev_churned || 0);
        const prevTotal = Number(mRes[0]?.prev_total || 0);
        const prevChurnRate = prevTotal > 0 ? (prevChurned / prevTotal) * 100 : 0;

        const mrrMoM = prevActiveMrr > 0 ? ((activeMrr - prevActiveMrr) / prevActiveMrr) * 100 : 0;
        const churnMoM = churnRate - prevChurnRate; // absolute difference in percentage points

        setKpis({
          activeMrr,
          churnRate,
          arpu,
          activeSeats,
          mrrMoM,
          churnMoM,
          totalCount,
        });

        setMonthlyTrend(
          tRes.map((r) => ({
            month: String(r.month),
            Signups: Number(r.signups),
          }))
        );

        setStatusDist(
          sRes.map((r) => ({
            name: String(r.status).toUpperCase(),
            value: Number(r.count),
          }))
        );

        setMrrByPlan(
          mpRes.map((r) => ({
            plan: String(r.plan),
            MRR: Number(r.total_mrr),
          }))
        );

        setPlanTable(
          ptRes.map((r) => ({
            plan: String(r.plan),
            customers: Number(r.customer_count),
            seats: Number(r.total_seats),
            mrr: Number(r.total_mrr),
          }))
        );

        setError(null);
      } catch (e: any) {
        setError(e?.message ?? "Failed to fetch dashboard data");
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [selectedCountry, selectedIndustry]);

  // Handle interaction click
  const handleElementClick = (title: string, queryText: string, description: string) => {
    selectFeature({
      title,
      type: "chart_element",
      tableName: "data",
      description,
      query: queryText,
    });
  };

  if (loading && !kpis) {
    return (
      <div className="min-h-screen bg-orange-50 font-sans p-6 md:p-8">
        <div className="max-w-7xl mx-auto space-y-8">
          <div className="space-y-3">
            <div className="h-8 w-64 bg-stone-200 rounded-lg animate-pulse" />
            <div className="h-4 w-96 bg-stone-200 rounded-lg animate-pulse" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-7">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-32 bg-white rounded-2xl border border-orange-100 animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Find highest MRR plan for insight
  const topPlan = planTable.reduce((prev, current) => (prev.mrr > current.mrr ? prev : current), { plan: "None", mrr: 0, seats: 0 });

  return (
    <div className="min-h-screen bg-orange-50 text-stone-900 font-sans pb-16">
      <div className="max-w-7xl mx-auto p-6 md:p-8 space-y-8">
        
        {/* Header Section */}
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
          <div>
            <h1 className="text-3xl font-serif font-semibold tracking-tight text-stone-900">
              Subscription Health Dashboard
            </h1>
            <p className="text-sm text-stone-600 mt-1">
              Real-time active MRR, churn metrics, and plan performance analysis.
            </p>
          </div>

          {/* Global Filters */}
          <div className="flex flex-wrap items-center gap-3 bg-white p-2 rounded-xl border border-orange-100 shadow-sm">
            <div className="flex items-center gap-2 text-stone-500 px-2 text-xs font-semibold uppercase tracking-wider">
              <Filter size={14} className="text-orange-600" />
              <span>Filters:</span>
            </div>
            
            {/* Country Filter */}
            <div className="flex items-center gap-1.5">
              <Globe size={14} className="text-stone-400" />
              <select
                value={selectedCountry}
                onChange={(e) => setSelectedCountry(e.target.value)}
                className="h-9 rounded-lg border border-stone-200 bg-stone-50 px-2.5 text-xs font-medium text-stone-700 focus:outline-none focus:ring-2 focus:ring-orange-500"
              >
                <option value="All">All Countries</option>
                {countries.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            {/* Industry Filter */}
            <div className="flex items-center gap-1.5">
              <Briefcase size={14} className="text-stone-400" />
              <select
                value={selectedIndustry}
                onChange={(e) => setSelectedIndustry(e.target.value)}
                className="h-9 rounded-lg border border-stone-200 bg-stone-50 px-2.5 text-xs font-medium text-stone-700 focus:outline-none focus:ring-2 focus:ring-orange-500"
              >
                <option value="All">All Industries</option>
                {industries.map((i) => (
                  <option key={i} value={i}>{i}</option>
                ))}
              </select>
            </div>
          </div>
        </header>

        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-800 p-4 rounded-xl text-sm">
            {error}
          </div>
        )}

        {/* Row 1: KPIs in one single line */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-7">
          {/* KPI 1: Active MRR */}
          <div 
            onClick={() => handleElementClick("Active MRR Detail", "SELECT * FROM data WHERE status = 'active'", "Active subscribers and their monthly recurring revenue")}
            className="bg-white rounded-2xl border border-orange-100 shadow-sm p-6 md:p-7 hover:border-orange-300 transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs font-medium uppercase tracking-wider text-stone-500">Active MRR</span>
              <div className="w-10 h-10 rounded-xl bg-orange-100 text-orange-700 grid place-items-center group-hover:scale-110 transition-transform">
                <DollarSign size={20} />
              </div>
            </div>
            <div className="text-3xl font-semibold tabular-nums text-stone-900 bg-gradient-to-r from-orange-600 to-rose-600 bg-clip-text text-transparent">
              ${kpis?.activeMrr?.toLocaleString() ?? "0"}
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-xs">
              <span className={`font-semibold ${kpis?.mrrMoM >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                {kpis?.mrrMoM >= 0 ? "+" : ""}{kpis?.mrrMoM?.toFixed(1)}%
              </span>
              <span className="text-stone-400">vs previous period</span>
            </div>
          </div>

          {/* KPI 2: Churn Rate */}
          <div 
            onClick={() => handleElementClick("Churned Customers", "SELECT * FROM data WHERE status = 'churned'", "Subscribers who have churned")}
            className="bg-white rounded-2xl border border-orange-100 shadow-sm p-6 md:p-7 hover:border-orange-300 transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs font-medium uppercase tracking-wider text-stone-500">Churn Rate</span>
              <div className="w-10 h-10 rounded-xl bg-rose-100 text-rose-700 grid place-items-center group-hover:scale-110 transition-transform">
                <Percent size={20} />
              </div>
            </div>
            <div className="text-3xl font-semibold tabular-nums text-stone-900">
              {kpis?.churnRate?.toFixed(1)}%
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-xs">
              <span className={`font-semibold ${kpis?.churnMoM <= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                {kpis?.churnMoM > 0 ? "+" : ""}{kpis?.churnMoM?.toFixed(1)}%
              </span>
              <span className="text-stone-400">MoM change</span>
            </div>
          </div>

          {/* KPI 3: ARPU */}
          <div 
            onClick={() => handleElementClick("ARPU Base", "SELECT * FROM data WHERE status = 'active'", "Active customers used for ARPU calculation")}
            className="bg-white rounded-2xl border border-orange-100 shadow-sm p-6 md:p-7 hover:border-orange-300 transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs font-medium uppercase tracking-wider text-stone-500">ARPU</span>
              <div className="w-10 h-10 rounded-xl bg-fuchsia-100 text-fuchsia-700 grid place-items-center group-hover:scale-110 transition-transform">
                <TrendingUp size={20} />
              </div>
            </div>
            <div className="text-3xl font-semibold tabular-nums text-stone-900">
              ${kpis?.arpu?.toFixed(0) ?? "0"}
            </div>
            <div className="mt-2 text-xs text-stone-400">
              Average revenue per active account
            </div>
          </div>

          {/* KPI 4: Total Seats */}
          <div 
            onClick={() => handleElementClick("Active Seats", "SELECT * FROM data WHERE status = 'active'", "Active seat counts across plans")}
            className="bg-white rounded-2xl border border-orange-100 shadow-sm p-6 md:p-7 hover:border-orange-300 transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs font-medium uppercase tracking-wider text-stone-500">Active Seats</span>
              <div className="w-10 h-10 rounded-xl bg-teal-100 text-teal-700 grid place-items-center group-hover:scale-110 transition-transform">
                <Users size={20} />
              </div>
            </div>
            <div className="text-3xl font-semibold tabular-nums text-stone-900">
              {kpis?.activeSeats?.toLocaleString() ?? "0"}
            </div>
            <div className="mt-2 text-xs text-stone-400">
              Total provisioned seats in active plans
            </div>
          </div>
        </div>

        {/* Row 2: Monthly Signups Trend & Status Donut Side-by-Side */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-7">
          {/* Monthly Signups Trend */}
          <div className="bg-white rounded-2xl border border-orange-100 shadow-sm p-6 md:p-7 flex flex-col justify-between">
            <div>
              <div className="mb-6">
                <h2 className="text-lg font-serif font-semibold text-stone-900">Monthly Signups Trend</h2>
                <p className="text-xs text-stone-500">Acquisition velocity and signups over time</p>
              </div>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={monthlyTrend} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid stroke="#f5e6dd" vertical={false} />
                    <XAxis 
                      dataKey="month" 
                      tick={{ fill: "#78716c", fontSize: 11 }} 
                      axisLine={false} 
                      tickLine={false} 
                    />
                    <YAxis 
                      tick={{ fill: "#78716c", fontSize: 11 }} 
                      axisLine={false} 
                      tickLine={false} 
                    />
                    <Tooltip 
                      contentStyle={{ borderRadius: 12, border: "1px solid #ffedd5", fontSize: 12, backgroundColor: "#fff" }} 
                    />
                    <Line 
                      type="monotone" 
                      dataKey="Signups" 
                      stroke="#ea580c" 
                      strokeWidth={3} 
                      dot={{ r: 4, fill: "#ea580c", strokeWidth: 0 }}
                      activeDot={{ r: 6 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Status Distribution Donut */}
          <div className="bg-white rounded-2xl border border-orange-100 shadow-sm p-6 md:p-7 flex flex-col justify-between">
            <div>
              <h2 className="text-lg font-serif font-semibold text-stone-900">Status Distribution</h2>
              <p className="text-xs text-stone-500">Breakdown of customer health states</p>
            </div>
            
            <div className="relative h-56 my-4 flex items-center justify-center">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={statusDist}
                    cx="50%"
                    cy="50%"
                    innerRadius={65}
                    outerRadius={85}
                    paddingAngle={4}
                    dataKey="value"
                  >
                    {statusDist.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip 
                    contentStyle={{ borderRadius: 12, border: "1px solid #ffedd5", fontSize: 12 }}
                  />
                </PieChart>
              </ResponsiveContainer>
              
              {/* Center Text */}
              <div className="absolute text-center">
                <span className="text-xs uppercase tracking-wider text-stone-400 font-medium">Total Accounts</span>
                <div className="text-3xl font-bold text-stone-800 tabular-nums">{kpis?.totalCount ?? 0}</div>
              </div>
            </div>

            {/* Legend */}
            <div className="flex justify-center gap-4 flex-wrap text-xs">
              {statusDist.map((entry, index) => (
                <div key={entry.name} className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                  <span className="text-stone-600 font-medium">{entry.name}</span>
                  <span className="text-stone-400">({entry.value})</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Row 3: MRR by Plan Bar Chart & Plan Detail Table Side-by-Side */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-7">
          {/* MRR by Plan Horizontal Bar */}
          <div className="bg-white rounded-2xl border border-orange-100 shadow-sm p-6 md:p-7 flex flex-col justify-between">
            <div>
              <div className="mb-6">
                <h2 className="text-lg font-serif font-semibold text-stone-900">MRR by Plan</h2>
                <p className="text-xs text-stone-500">Total recurring revenue contribution per plan tier</p>
              </div>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={mrrByPlan} layout="vertical" margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                    <CartesianGrid stroke="#f5e6dd" horizontal={false} />
                    <XAxis 
                      type="number" 
                      tick={{ fill: "#78716c", fontSize: 11 }} 
                      axisLine={false} 
                      tickLine={false} 
                    />
                    <YAxis 
                      type="category" 
                      dataKey="plan" 
                      tick={{ fill: "#78716c", fontSize: 11 }} 
                      axisLine={false} 
                      tickLine={false} 
                      width={80}
                    />
                    <Tooltip 
                      contentStyle={{ borderRadius: 12, border: "1px solid #ffedd5", fontSize: 12 }}
                      formatter={(value) => [`$${Number(value).toLocaleString()}`, "MRR"]}
                    />
                    <Bar 
                      dataKey="MRR" 
                      radius={[0, 6, 6, 0]} 
                      onClick={(data) => handleElementClick(`Plan: ${data.plan}`, `SELECT * FROM data WHERE plan = '${data.plan}'`, `Subscribers on the ${data.plan} plan`)}
                      cursor="pointer"
                    >
                      {mrrByPlan.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Plan Detail Table */}
          <div className="bg-white rounded-2xl border border-orange-100 shadow-sm p-6 md:p-7 flex flex-col justify-between">
            <div>
              <div className="mb-6">
                <h2 className="text-lg font-serif font-semibold text-stone-900">Plan Detail Performance</h2>
                <p className="text-xs text-stone-500">Customer counts, seats, and revenue metrics by tier</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wider text-stone-500 border-b border-stone-200">
                      <th className="text-left font-semibold py-3">Plan Tier</th>
                      <th className="text-right font-semibold py-3">Customers</th>
                      <th className="text-right font-semibold py-3">Total Seats</th>
                      <th className="text-right font-semibold py-3">Total MRR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {planTable.map((row, i) => (
                      <tr 
                        key={row.plan} 
                        className="border-b border-stone-100 hover:bg-orange-50/50 transition-colors cursor-pointer"
                        onClick={() => handleElementClick(`Plan Detail: ${row.plan}`, `SELECT * FROM data WHERE plan = '${row.plan}'`, `Detailed records for ${row.plan} plan`)}
                      >
                        <td className="py-4 font-medium text-stone-900 flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                          {row.plan}
                        </td>
                        <td className="py-4 text-right tabular-nums text-stone-600">{row.customers.toLocaleString()}</td>
                        <td className="py-4 text-right tabular-nums text-stone-600">{row.seats.toLocaleString()}</td>
                        <td className="py-4 text-right tabular-nums font-semibold text-stone-900">${row.mrr.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Key Insight Box */}
            {topPlan.plan !== "None" && (
              <div className="mt-6 p-4 bg-gradient-to-r from-orange-50 to-rose-50 rounded-xl border border-orange-100 flex items-start gap-3">
                <Sparkles className="text-orange-600 shrink-0 mt-0.5" size={18} />
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-orange-800">Key Performance Insight</h4>
                  <p className="text-xs text-stone-700 mt-1 leading-relaxed">
                    The <strong className="text-orange-900">{topPlan.plan}</strong> tier is currently driving the highest MRR contribution at <strong className="text-orange-900">${topPlan.mrr.toLocaleString()}</strong>. Monitor seat utilization on this tier to maximize expansion revenue opportunities.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}