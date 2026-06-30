import { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  Cell,
} from "recharts";
import {
  TrendingUp,
  DollarSign,
  Percent,
  AlertTriangle,
  Filter,
  Layers,
  Building2,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";
import { query } from "./data";
import { selectFeature } from "./selection";

const COLORS = [
  "#a855f7", // Purple
  "#6366f1", // Indigo
  "#06b6d4", // Cyan
  "#14b8a6", // Teal
  "#f59e0b", // Amber
  "#ec4899", // Pink
];

interface KPIState {
  totalBudget: number;
  totalActual: number;
  netVariance: number;
  variancePct: number;
}

interface TrendData {
  month: string;
  budget: number;
  actual: number;
}

interface CategoryData {
  category: string;
  actual: number;
}

interface DepartmentData {
  department: string;
  budget: number;
  actual: number;
  variance: number;
  variancePct: number;
}

interface InsightData {
  department: string;
  category: string;
  variance: number;
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [selectedDept, setSelectedDept] = useState<string | null>(null);

  // Data states
  const [departments, setDepartments] = useState<string[]>([]);
  const [kpis, setKpis] = useState<KPIState | null>(null);
  const [trend, setTrend] = useState<TrendData[]>([]);
  const [categories, setCategories] = useState<CategoryData[]>([]);
  const [deptPerformance, setDeptPerformance] = useState<DepartmentData[]>([]);
  const [insight, setInsight] = useState<InsightData | null>(null);

  // Fetch initial department list
  useEffect(() => {
    async function init() {
      try {
        const depts = await query("SELECT DISTINCT department FROM data ORDER BY department");
        setDepartments(depts.map((d: any) => d.department));
      } catch (e: any) {
        setError(e?.message ?? "Failed to load departments");
      }
    }
    init();
  }, []);

  // Fetch dashboard data based on selected department filter
  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      try {
        const filterClause = selectedDept ? `WHERE department = '${selectedDept}'` : "";

        // 1. KPIs
        const kpiRes = await query(`
          SELECT 
            SUM(budget) as total_budget,
            SUM(actual) as total_actual
          FROM data
          ${filterClause}
        `);
        const totalBudget = Number(kpiRes[0]?.total_budget || 0);
        const totalActual = Number(kpiRes[0]?.total_actual || 0);
        const netVariance = totalBudget - totalActual;
        const variancePct = totalBudget ? ((totalActual - totalBudget) / totalBudget) * 100 : 0;

        setKpis({
          totalBudget,
          totalActual,
          netVariance,
          variancePct,
        });

        // 2. Monthly Trend
        const trendRes = await query(`
          SELECT 
            month,
            SUM(budget) as budget,
            SUM(actual) as actual
          FROM data
          ${filterClause}
          GROUP BY month
          ORDER BY month ASC
        `);
        setTrend(
          trendRes.map((r: any) => {
            const date = new Date(r.month);
            const monthStr = date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
            return {
              month: monthStr,
              budget: Number(r.budget || 0),
              actual: Number(r.actual || 0),
            };
          })
        );

        // 3. Ranked Categories
        const catRes = await query(`
          SELECT 
            category,
            SUM(actual) as actual
          FROM data
          ${filterClause}
          GROUP BY category
          ORDER BY actual DESC
        `);
        setCategories(
          catRes.map((r: any) => ({
            category: String(r.category),
            actual: Number(r.actual || 0),
          }))
        );

        // 4. Department Performance Table
        const deptRes = await query(`
          SELECT 
            department,
            SUM(budget) as budget,
            SUM(actual) as actual,
            (SUM(budget) - SUM(actual)) as variance,
            ((SUM(actual) - SUM(budget)) * 100.0 / SUM(budget)) as variance_pct
          FROM data
          GROUP BY department
          ORDER BY variance_pct DESC
        `);
        setDeptPerformance(
          deptRes.map((r: any) => ({
            department: String(r.department),
            budget: Number(r.budget || 0),
            actual: Number(r.actual || 0),
            variance: Number(r.variance || 0),
            variancePct: Number(r.variance_pct || 0),
          }))
        );

        // 5. Key Insight
        const insightRes = await query(`
          SELECT 
            department,
            category,
            (actual - budget) as overrun
          FROM data
          ORDER BY overrun DESC
          LIMIT 1
        `);
        if (insightRes.length > 0) {
          setInsight({
            department: String(insightRes[0].department),
            category: String(insightRes[0].category),
            variance: Number(insightRes[0].overrun),
          });
        }
      } catch (e: any) {
        setError(e?.message ?? "Failed to load dashboard data");
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [selectedDept]);

  const handleSelectDept = (dept: string | null) => {
    setSelectedDept(dept);
    selectFeature({
      title: dept ? `Department Filter: ${dept}` : "All Departments",
      type: "filter",
      tableName: "data",
      description: `Filtering financial data by ${dept || "all departments"}`,
      query: `SELECT * FROM data ${dept ? `WHERE department = '${dept}'` : ""}`,
    });
  };

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(val);
  };

  if (loading && !kpis) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 font-sans flex items-center justify-center">
        <div className="max-w-7xl w-full p-4 space-y-4">
          <div className="h-8 w-64 bg-slate-800 rounded animate-pulse" />
          <div className="grid grid-cols-4 gap-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-20 bg-slate-900 rounded-xl border border-slate-800 animate-pulse" />
            ))}
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2 h-64 bg-slate-900 rounded-xl border border-slate-800 animate-pulse" />
            <div className="h-64 bg-slate-900 rounded-xl border border-slate-800 animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 font-sans grid place-items-center">
        <div className="bg-slate-900 rounded-xl border border-slate-800 p-8 text-center max-w-md">
          <AlertTriangle className="h-8 w-8 text-rose-500 mx-auto mb-3" />
          <p className="text-sm text-slate-300 font-medium mb-2">Error Loading Data</p>
          <p className="text-xs text-slate-500">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 text-slate-100 font-sans overflow-x-hidden flex flex-col justify-between p-4 md:p-6">
      <div className="max-w-7xl mx-auto w-full space-y-4 my-auto">
        {/* Header */}
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-purple-400 via-indigo-300 to-cyan-400 bg-clip-text text-transparent">
              Corporate Spend & Budget Control
            </h1>
            <p className="text-xs text-slate-400">Real-time budget vs actual performance tracking across departments</p>
          </div>

          {/* Department Filter Dropdown */}
          <div className="flex items-center gap-2 self-start sm:self-auto">
            <Filter size={14} className="text-purple-400" />
            <select
              value={selectedDept || ""}
              onChange={(e) => handleSelectDept(e.target.value || null)}
              className="h-8 rounded-lg border border-slate-700 bg-slate-900/80 px-2.5 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-purple-500"
            >
              <option value="">All Departments</option>
              {departments.map((dept) => (
                <option key={dept} value={dept}>
                  {dept}
                </option>
              ))}
            </select>
            {selectedDept && (
              <button
                onClick={() => handleSelectDept(null)}
                className="text-xs text-purple-400 hover:text-purple-300 font-medium"
              >
                Clear
              </button>
            )}
          </div>
        </header>

        {/* Key Insight Banner */}
        {insight && (
          <div className="bg-gradient-to-r from-purple-900/90 via-indigo-950/90 to-slate-900/90 border border-purple-500/30 rounded-xl p-3 text-white shadow-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-1.5 bg-purple-500/20 rounded-lg border border-purple-500/30">
                <AlertTriangle className="h-4 w-4 text-amber-400" />
              </div>
              <div>
                <h3 className="text-xs font-semibold text-purple-200">Critical Cost Overrun Identified</h3>
                <p className="text-[11px] text-slate-300">
                  <span className="font-bold text-white">{insight.department}</span> spent an extra{" "}
                  <span className="font-bold text-purple-300">{formatCurrency(insight.variance)}</span> on{" "}
                  <span className="font-bold text-white">{insight.category}</span>.
                </p>
              </div>
            </div>
            <button
              onClick={() => handleSelectDept(insight.department)}
              className="text-[11px] bg-purple-600 hover:bg-purple-500 text-white font-semibold px-3 py-1 rounded-lg transition-colors self-start sm:self-auto"
            >
              Analyze {insight.department}
            </button>
          </div>
        )}

        {/* Row 1: KPIs */}
        {kpis && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Total Budget */}
            <div
              className="bg-gradient-to-br from-slate-900 to-indigo-950/40 rounded-xl border border-slate-800 p-4 cursor-pointer hover:border-purple-500/50 transition-all shadow-md relative overflow-hidden group"
              onClick={() =>
                selectFeature({
                  title: "Total Budget KPI",
                  type: "kpi",
                  tableName: "data",
                  description: "Sum of total allocated budget",
                  query: `SELECT SUM(budget) FROM data ${selectedDept ? `WHERE department = '${selectedDept}'` : ""}`,
                })
              }
            >
              <div className="absolute top-0 right-0 w-24 h-24 bg-purple-500/5 rounded-full blur-xl group-hover:bg-purple-500/10 transition-all" />
              <div className="flex items-center gap-2.5 mb-1.5">
                <div className="w-8 h-8 rounded-lg bg-purple-500/10 text-purple-400 border border-purple-500/20 grid place-items-center">
                  <Layers size={16} />
                </div>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Total Budget</span>
              </div>
              <div className="text-2xl font-bold tabular-nums text-white">
                {formatCurrency(kpis.totalBudget)}
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">Allocated capital</div>
            </div>

            {/* Total Actual */}
            <div
              className="bg-gradient-to-br from-slate-900 to-indigo-950/40 rounded-xl border border-slate-800 p-4 cursor-pointer hover:border-indigo-500/50 transition-all shadow-md relative overflow-hidden group"
              onClick={() =>
                selectFeature({
                  title: "Total Actual Spend KPI",
                  type: "kpi",
                  tableName: "data",
                  description: "Sum of actual spend incurred",
                  query: `SELECT SUM(actual) FROM data ${selectedDept ? `WHERE department = '${selectedDept}'` : ""}`,
                })
              }
            >
              <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-500/5 rounded-full blur-xl group-hover:bg-indigo-500/10 transition-all" />
              <div className="flex items-center gap-2.5 mb-1.5">
                <div className="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 grid place-items-center">
                  <DollarSign size={16} />
                </div>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Total Actual</span>
              </div>
              <div className="text-2xl font-bold tabular-nums text-white">
                {formatCurrency(kpis.totalActual)}
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">Incurred expenditures</div>
            </div>

            {/* Net Variance */}
            <div
              className="bg-gradient-to-br from-slate-900 to-indigo-950/40 rounded-xl border border-slate-800 p-4 cursor-pointer hover:border-teal-500/50 transition-all shadow-md relative overflow-hidden group"
              onClick={() =>
                selectFeature({
                  title: "Net Variance KPI",
                  type: "kpi",
                  tableName: "data",
                  description: "Budget minus actual spend (positive is under budget, negative is over budget)",
                  query: `SELECT SUM(budget) - SUM(actual) FROM data ${
                    selectedDept ? `WHERE department = '${selectedDept}'` : ""
                  }`,
                })
              }
            >
              <div className="absolute top-0 right-0 w-24 h-24 bg-teal-500/5 rounded-full blur-xl group-hover:bg-teal-500/10 transition-all" />
              <div className="flex items-center gap-2.5 mb-1.5">
                <div className="w-8 h-8 rounded-lg bg-teal-500/10 text-teal-400 border border-teal-500/20 grid place-items-center">
                  <TrendingUp size={16} />
                </div>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Net Variance</span>
              </div>
              <div className="text-2xl font-bold tabular-nums text-white">
                {formatCurrency(kpis.netVariance)}
              </div>
              <div className="flex items-center gap-1 text-[10px] mt-0.5">
                {kpis.netVariance >= 0 ? (
                  <span className="text-emerald-400 font-medium flex items-center">
                    <ArrowDownRight size={12} /> Under Budget
                  </span>
                ) : (
                  <span className="text-rose-400 font-medium flex items-center">
                    <ArrowUpRight size={12} /> Over Budget
                  </span>
                )}
              </div>
            </div>

            {/* Variance % */}
            <div
              className="bg-gradient-to-br from-slate-900 to-indigo-950/40 rounded-xl border border-slate-800 p-4 cursor-pointer hover:border-amber-500/50 transition-all shadow-md relative overflow-hidden group"
              onClick={() =>
                selectFeature({
                  title: "Variance Percentage KPI",
                  type: "kpi",
                  tableName: "data",
                  description: "Percentage overrun relative to budget",
                  query: `SELECT (SUM(actual) - SUM(budget)) / SUM(budget) * 100 FROM data ${
                    selectedDept ? `WHERE department = '${selectedDept}'` : ""
                  }`,
                })
              }
            >
              <div className="absolute top-0 right-0 w-24 h-24 bg-amber-500/5 rounded-full blur-xl group-hover:bg-amber-500/10 transition-all" />
              <div className="flex items-center gap-2.5 mb-1.5">
                <div className="w-8 h-8 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 grid place-items-center">
                  <Percent size={16} />
                </div>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Variance %</span>
              </div>
              <div className="text-2xl font-bold tabular-nums text-white">
                {kpis.variancePct >= 0 ? "+" : ""}
                {kpis.variancePct.toFixed(1)}%
              </div>
              <div className="text-[10px] mt-0.5">
                {kpis.variancePct <= 0 ? (
                  <span className="text-emerald-400 font-medium">Within target limit</span>
                ) : (
                  <span className="text-rose-400 font-medium">Exceeds budget target</span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Row 2: Charts & Table Side-by-Side for Compact Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Monthly Burn vs Target (Left 5 cols) */}
          <div className="lg:col-span-5 bg-slate-900/60 backdrop-blur-sm rounded-xl border border-slate-800 p-4">
            <div className="mb-2">
              <h2 className="text-xs font-semibold text-slate-200">Monthly Burn vs Target</h2>
              <p className="text-[10px] text-slate-400">Budgeted limits against actual spend</p>
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={trend} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                <CartesianGrid stroke="#1e293b" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: "#94a3b8", fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis
                  tick={{ fill: "#94a3b8", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => `$${v / 1000}k`}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: "#0f172a", borderRadius: 8, border: "1px solid #334155", fontSize: 11, color: "#fff" }}
                  formatter={(value: any) => [formatCurrency(Number(value)), ""]}
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 10, paddingTop: 5 }} />
                <Line
                  name="Budget Limit"
                  type="monotone"
                  dataKey="budget"
                  stroke="#64748b"
                  strokeDasharray="3 3"
                  strokeWidth={1.5}
                  dot={false}
                />
                <Line
                  name="Actual Spend"
                  type="monotone"
                  dataKey="actual"
                  stroke="#a855f7"
                  strokeWidth={2.5}
                  dot={{ r: 3, fill: "#a855f7" }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Ranked Category Spend (Middle 3 cols) */}
          <div className="lg:col-span-3 bg-slate-900/60 backdrop-blur-sm rounded-xl border border-slate-800 p-4">
            <div className="mb-2">
              <h2 className="text-xs font-semibold text-slate-200">Spend by Category</h2>
              <p className="text-[10px] text-slate-400">Ranked actual expenditures</p>
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={categories} layout="vertical" margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                <CartesianGrid stroke="#1e293b" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fill: "#94a3b8", fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => `$${v / 1000}k`}
                />
                <YAxis
                  type="category"
                  dataKey="category"
                  width={80}
                  tick={{ fill: "#94a3b8", fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: "#0f172a", borderRadius: 8, border: "1px solid #334155", fontSize: 11, color: "#fff" }}
                  formatter={(value: any) => [formatCurrency(Number(value)), "Actual"]}
                />
                <Bar dataKey="actual" radius={[0, 4, 4, 0]}>
                  {categories.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Department Performance Table (Right 4 cols) */}
          <div className="lg:col-span-4 bg-slate-900/60 backdrop-blur-sm rounded-xl border border-slate-800 p-4 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h2 className="text-xs font-semibold text-slate-200">Department Performance</h2>
                  <p className="text-[10px] text-slate-400">Variance breakdown</p>
                </div>
                {selectedDept && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-medium bg-purple-500/10 text-purple-300 border border-purple-500/20">
                    <Building2 size={10} /> {selectedDept}
                  </span>
                )}
              </div>

              <div className="overflow-x-auto max-h-[145px] overflow-y-auto custom-scrollbar">
                <table className="w-full text-left text-[11px]">
                  <thead>
                    <tr className="text-[9px] uppercase tracking-wider text-slate-400 border-b border-slate-800">
                      <th className="py-1.5 px-2 font-medium">Dept</th>
                      <th className="py-1.5 px-2 text-right font-medium">Actual</th>
                      <th className="py-1.5 px-2 text-right font-medium">Var %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deptPerformance.map((dept) => {
                      const isSelected = selectedDept === dept.department;
                      const isOverBudget = dept.variancePct > 0;

                      return (
                        <tr
                          key={dept.department}
                          onClick={() => handleSelectDept(isSelected ? null : dept.department)}
                          className={`border-b border-slate-800/50 hover:bg-slate-800/30 cursor-pointer transition-colors ${
                            isSelected ? "bg-purple-500/10 font-medium" : ""
                          }`}
                        >
                          <td className="py-1.5 px-2 text-slate-200 flex items-center gap-1.5 truncate max-w-[100px]">
                            <span
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                isSelected ? "bg-purple-400" : "bg-slate-600"
                              }`}
                            />
                            {dept.department}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-slate-300">
                            {formatCurrency(dept.actual)}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums">
                            <span
                              className={`inline-flex items-center rounded px-1 py-0.5 text-[10px] font-medium ${
                                isOverBudget ? "bg-rose-500/10 text-rose-400" : "bg-emerald-500/10 text-emerald-400"
                              }`}
                            >
                              {isOverBudget ? "+" : ""}
                              {dept.variancePct.toFixed(0)}%
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}