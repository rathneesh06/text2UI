import { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  AreaChart,
  Area
} from "recharts";
import {
  TrendingUp,
  DollarSign,
  Percent,
  Target,
  Filter,
  Sparkles,
  MousePointerClick
} from "lucide-react";
import { query } from "./data";
import { selectFeature } from "./selection";

// Color Palette - "Pop" theme
const COLORS = [
  "#d946ef", // Fuchsia
  "#8b5cf6", // Violet
  "#ec4899", // Pink
  "#06b6d4", // Cyan
  "#f59e0b", // Amber
  "#10b981", // Emerald
  "#3b82f6", // Blue
  "#f43f5e"  // Rose
];

export default function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [selectedChannel, setSelectedChannel] = useState<string>("All");
  const [channelsList, setChannelsList] = useState<string[]>([]);

  // Data states
  const [kpiData, setKpiData] = useState<any>(null);
  const [trendData, setTrendData] = useState<any[]>([]);
  const [campaignEfficiency, setCampaignEfficiency] = useState<any[]>([]);
  const [channelBreakdown, setChannelBreakdown] = useState<any[]>([]);
  const [conversionTrend, setConversionTrend] = useState<any[]>([]);
  const [detailTable, setDetailTable] = useState<any[]>([]);
  const [bestCampaign, setBestCampaign] = useState<any>(null);

  useEffect(() => {
    async function init() {
      try {
        // Fetch distinct channels for filter
        const channelsRes = await query(`SELECT DISTINCT channel FROM data ORDER BY channel`);
        setChannelsList(channelsRes.map((r: any) => String(r.channel)));
      } catch (e: any) {
        setError(e?.message ?? "Failed to initialize filters");
      }
    }
    init();
  }, []);

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      try {
        // 1. KPI Data (including Period-over-Period logic)
        const kpisQuery = `
          WITH split_data AS (
            SELECT 
              revenue, 
              spend, 
              conversions, 
              clicks,
              CASE WHEN date < '2024-02-19' THEN 'P1' ELSE 'P2' END as period
            FROM data
            ${selectedChannel !== "All" ? `WHERE channel = '${selectedChannel}'` : ""}
          )
          SELECT 
            period,
            SUM(revenue) as total_revenue,
            SUM(spend) as total_spend,
            SUM(conversions) as total_conversions,
            SUM(clicks) as total_clicks
          FROM split_data
          GROUP BY period
        `;
        const kpisRes = await query(kpisQuery);
        
        const p1 = kpisRes.find((r: any) => r.period === 'P1') || { total_revenue: 0, total_spend: 0, total_conversions: 0, total_clicks: 0 };
        const p2 = kpisRes.find((r: any) => r.period === 'P2') || { total_revenue: 0, total_spend: 0, total_conversions: 0, total_clicks: 0 };
        
        const totalRevenue = Number(p1.total_revenue || 0) + Number(p2.total_revenue || 0);
        const totalSpend = Number(p1.total_spend || 0) + Number(p2.total_spend || 0);
        const totalConversions = Number(p1.total_conversions || 0) + Number(p2.total_conversions || 0);
        const totalClicks = Number(p1.total_clicks || 0) + Number(p2.total_clicks || 0);

        const revChange = p1.total_revenue ? ((p2.total_revenue - p1.total_revenue) / p1.total_revenue) * 100 : 0;
        const spendChange = p1.total_spend ? ((p2.total_spend - p1.total_spend) / p1.total_spend) * 100 : 0;

        setKpiData({
          revenue: totalRevenue,
          revenueChange: revChange,
          spend: totalSpend,
          spendChange: spendChange,
          roas: totalSpend ? totalRevenue / totalSpend : 0,
          convRate: totalClicks ? (totalConversions / totalClicks) * 100 : 0
        });

        // 2. Weekly Trend (Spend vs Revenue)
        const trendQuery = `
          SELECT 
            date,
            SUM(spend) as spend,
            SUM(revenue) as revenue
          FROM data
          ${selectedChannel !== "All" ? `WHERE channel = '${selectedChannel}'` : ""}
          GROUP BY date
          ORDER BY date ASC
        `;
        const trendRes = await query(trendQuery);
        setTrendData(trendRes.map((r: any) => ({
          date: String(r.date).split('T')[0],
          spend: Number(r.spend || 0),
          revenue: Number(r.revenue || 0)
        })));

        // 3. Campaign Efficiency (ROAS)
        const campaignQuery = `
          SELECT 
            campaign,
            SUM(spend) as spend,
            SUM(revenue) as revenue,
            CASE WHEN SUM(spend) > 0 THEN CAST(SUM(revenue) AS DOUBLE) / SUM(spend) ELSE 0 END as roas
          FROM data
          ${selectedChannel !== "All" ? `WHERE channel = '${selectedChannel}'` : ""}
          GROUP BY campaign
          ORDER BY roas DESC
        `;
        const campaignRes = await query(campaignQuery);
        setCampaignEfficiency(campaignRes.map((r: any) => ({
          campaign: String(r.campaign),
          spend: Number(r.spend || 0),
          revenue: Number(r.revenue || 0),
          roas: Number(Number(r.roas || 0).toFixed(2))
        })));

        if (campaignRes.length > 0) {
          setBestCampaign({
            campaign: campaignRes[0].campaign,
            roas: Number(campaignRes[0].roas || 0).toFixed(2)
          });
        }

        // 4. Channel Breakdown (Donut Chart)
        const channelQuery = `
          SELECT 
            channel,
            SUM(conversions) as conversions
          FROM data
          ${selectedChannel !== "All" ? `WHERE channel = '${selectedChannel}'` : ""}
          GROUP BY channel
          ORDER BY conversions DESC
        `;
        const channelRes = await query(channelQuery);
        setChannelBreakdown(channelRes.map((r: any) => ({
          name: String(r.channel),
          value: Number(r.conversions || 0)
        })));

        // 5. Conversion Trend (Area Chart)
        const convTrendQuery = `
          SELECT 
            date,
            SUM(conversions) as conversions
          FROM data
          ${selectedChannel !== "All" ? `WHERE channel = '${selectedChannel}'` : ""}
          GROUP BY date
          ORDER BY date ASC
        `;
        const convTrendRes = await query(convTrendQuery);
        setConversionTrend(convTrendRes.map((r: any) => ({
          date: String(r.date).split('T')[0],
          conversions: Number(r.conversions || 0)
        })));

        // 6. Detail Table
        const tableQuery = `
          SELECT 
            campaign,
            channel,
            SUM(spend) as spend,
            SUM(clicks) as clicks,
            SUM(conversions) as conversions,
            CASE WHEN SUM(conversions) > 0 THEN CAST(SUM(spend) AS DOUBLE) / SUM(conversions) ELSE 0 END as cpa
          FROM data
          ${selectedChannel !== "All" ? `WHERE channel = '${selectedChannel}'` : ""}
          GROUP BY campaign, channel
          ORDER BY spend DESC
        `;
        const tableRes = await query(tableQuery);
        setDetailTable(tableRes.map((r: any) => ({
          campaign: String(r.campaign),
          channel: String(r.channel),
          spend: Number(r.spend || 0),
          clicks: Number(r.clicks || 0),
          conversions: Number(r.conversions || 0),
          cpa: Number(Number(r.cpa || 0).toFixed(2))
        })));

      } catch (e: any) {
        setError(e?.message ?? "Failed to fetch dashboard data");
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [selectedChannel]);

  const handleElementClick = (title: string, queryText: string, description: string) => {
    selectFeature({
      title,
      type: "chart_click",
      tableName: "data",
      description,
      query: queryText
    });
  };

  if (loading && !kpiData) {
    return (
      <div className="min-h-screen bg-slate-50 font-sans flex flex-col justify-center items-center p-8">
        <div className="w-full max-w-7xl space-y-8 animate-pulse">
          <div className="h-12 bg-slate-200 rounded-xl w-1/4" />
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-32 bg-white rounded-2xl border border-slate-200" />
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="h-80 bg-white rounded-2xl border border-slate-200" />
            <div className="h-80 bg-white rounded-2xl border border-slate-200" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-50 font-sans grid place-items-center p-6">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 text-center max-w-md">
          <div className="w-12 h-12 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center mx-auto mb-4">
            <Target size={24} />
          </div>
          <h3 className="text-lg font-semibold text-slate-900 mb-2">Data Loading Error</h3>
          <p className="text-sm text-slate-500 mb-6">{error}</p>
          <button 
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-fuchsia-600 text-white rounded-lg text-sm font-medium hover:bg-fuchsia-700 transition-colors"
          >
            Retry Loading
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <div className="max-w-7xl mx-auto p-6 md:p-8 space-y-8">
        
        {/* Header & Filter Row */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-2 border-b border-slate-200">
          <div>
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-1 text-xs font-semibold tracking-wide uppercase rounded-full bg-gradient-to-r from-fuchsia-500 to-violet-500 text-white">
                Acquisition Live
              </span>
            </div>
            <h1 className="text-3xl font-bold tracking-tight mt-1 bg-gradient-to-r from-slate-900 via-fuchsia-950 to-indigo-950 bg-clip-text text-transparent">
              Marketing Performance Hub
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Track campaign efficiency, ROAS benchmarks, and conversion funnels.
            </p>
          </div>

          {/* Channel Filter */}
          <div className="flex items-center gap-3 self-start md:self-auto bg-white p-2 rounded-xl border border-slate-200 shadow-sm">
            <div className="text-slate-400 pl-1">
              <Filter size={16} />
            </div>
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Channel:</span>
            <select
              value={selectedChannel}
              onChange={(e) => setSelectedChannel(e.target.value)}
              className="h-8 rounded-lg border-0 bg-slate-50 px-3 text-xs font-semibold text-slate-700 focus:ring-2 focus:ring-fuchsia-500 cursor-pointer hover:bg-slate-100 transition-colors"
            >
              <option value="All">All Channels</option>
              {channelsList.map((ch) => (
                <option key={ch} value={ch}>{ch}</option>
              ))}
            </select>
          </div>
        </div>

        {/* KPI Row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {/* Total Revenue */}
          <div 
            onClick={() => handleElementClick("Total Revenue KPI", "SELECT SUM(revenue) FROM data", "Total revenue generated from campaigns")}
            className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 hover:border-fuchsia-300 transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Total Revenue</span>
              <div className="w-10 h-10 rounded-xl bg-fuchsia-100 text-fuchsia-700 flex items-center justify-center group-hover:scale-110 transition-transform">
                <DollarSign size={20} />
              </div>
            </div>
            <div className="text-3xl font-extrabold tracking-tight text-slate-900 tabular-nums">
              ${kpiData.revenue.toLocaleString()}
            </div>
            <div className="flex items-center gap-1.5 mt-2">
              <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${kpiData.revenueChange >= 0 ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                {kpiData.revenueChange >= 0 ? "+" : ""}{kpiData.revenueChange.toFixed(1)}%
              </span>
              <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">vs prior period</span>
            </div>
          </div>

          {/* Total Spend */}
          <div 
            onClick={() => handleElementClick("Total Spend KPI", "SELECT SUM(spend) FROM data", "Total marketing budget spent")}
            className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 hover:border-violet-300 transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Total Spend</span>
              <div className="w-10 h-10 rounded-xl bg-violet-100 text-violet-700 flex items-center justify-center group-hover:scale-110 transition-transform">
                <TrendingUp size={20} />
              </div>
            </div>
            <div className="text-3xl font-extrabold tracking-tight text-slate-900 tabular-nums">
              ${kpiData.spend.toLocaleString()}
            </div>
            <div className="flex items-center gap-1.5 mt-2">
              <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${kpiData.spendChange <= 0 ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                {kpiData.spendChange >= 0 ? "+" : ""}{kpiData.spendChange.toFixed(1)}%
              </span>
              <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">vs prior period</span>
            </div>
          </div>

          {/* ROAS */}
          <div 
            onClick={() => handleElementClick("ROAS KPI", "SELECT SUM(revenue)/SUM(spend) FROM data", "Return on Ad Spend efficiency ratio")}
            className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 hover:border-pink-300 transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">ROAS</span>
              <div className="w-10 h-10 rounded-xl bg-pink-100 text-pink-700 flex items-center justify-center group-hover:scale-110 transition-transform">
                <Sparkles size={20} />
              </div>
            </div>
            <div className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-fuchsia-600 to-violet-600 bg-clip-text text-transparent tabular-nums">
              {kpiData.roas.toFixed(2)}x
            </div>
            <div className="flex items-center gap-1.5 mt-2">
              <span className="text-xs font-semibold text-slate-500">Revenue / Spend efficiency</span>
            </div>
          </div>

          {/* Conversion Rate */}
          <div 
            onClick={() => handleElementClick("Conversion Rate KPI", "SELECT SUM(conversions)/SUM(clicks)*100 FROM data", "Conversion rate from clicks to conversions")}
            className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 hover:border-cyan-300 transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Conversion Rate</span>
              <div className="w-10 h-10 rounded-xl bg-cyan-100 text-cyan-700 flex items-center justify-center group-hover:scale-110 transition-transform">
                <Percent size={20} />
              </div>
            </div>
            <div className="text-3xl font-extrabold tracking-tight text-slate-900 tabular-nums">
              {kpiData.convRate.toFixed(2)}%
            </div>
            <div className="flex items-center gap-1.5 mt-2">
              <span className="text-xs font-semibold text-slate-500">Clicks to conversions</span>
            </div>
          </div>
        </div>

        {/* Key Insight Banner */}
        {bestCampaign && (
          <div className="bg-gradient-to-r from-fuchsia-500 via-violet-500 to-indigo-500 rounded-2xl p-[1px] shadow-md">
            <div className="bg-white rounded-[15px] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-fuchsia-500 to-violet-500 text-white flex items-center justify-center shrink-0 shadow-sm">
                  <Sparkles size={22} />
                </div>
                <div>
                  <h4 className="text-base font-bold text-slate-900">Strategic Budget Recommendation</h4>
                  <p className="text-sm text-slate-500 mt-0.5">
                    The <span className="font-semibold text-fuchsia-600">"{bestCampaign.campaign}"</span> campaign leads efficiency with an outstanding ROAS of <span className="font-bold text-slate-800">{bestCampaign.roas}x</span>. Consider shifting underperforming channel spend to maximize returns.
                  </p>
                </div>
              </div>
              <button 
                onClick={() => handleElementClick("Best Campaign Insight", `SELECT * FROM data WHERE campaign = '${bestCampaign.campaign}'`, "Details for top performing campaign")}
                className="px-4 py-2 bg-slate-950 hover:bg-slate-800 text-white text-xs font-bold uppercase tracking-wider rounded-xl transition-all shadow-sm shrink-0"
              >
                Inspect Campaign
              </button>
            </div>
          </div>
        )}

        {/* Charts Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          
          {/* Spend vs. Revenue Trend */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Spend vs. Revenue Trend</h3>
                <p className="text-xs text-slate-400 mt-0.5">Weekly performance tracking and budget efficiency</p>
              </div>
              <div className="flex items-center gap-4 text-xs font-semibold">
                <div className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-full bg-violet-500 inline-block" />
                  <span className="text-slate-600">Spend</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-full bg-fuchsia-500 inline-block" />
                  <span className="text-slate-600">Revenue</span>
                </div>
              </div>
            </div>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trendData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <CartesianGrid stroke="#e2e8f0" vertical={false} />
                  <XAxis 
                    dataKey="date" 
                    tick={{ fill: "#64748b", fontSize: 11 }} 
                    axisLine={false} 
                    tickLine={false} 
                  />
                  <YAxis 
                    tick={{ fill: "#64748b", fontSize: 11 }} 
                    axisLine={false} 
                    tickLine={false} 
                  />
                  <Tooltip 
                    contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12, boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.05)" }} 
                  />
                  <Line 
                    type="monotone" 
                    dataKey="spend" 
                    stroke="#8b5cf6" 
                    strokeWidth={3} 
                    dot={false} 
                    activeDot={{ r: 6 }}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="revenue" 
                    stroke="#d946ef" 
                    strokeWidth={3} 
                    dot={false} 
                    activeDot={{ r: 6 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Campaign Efficiency (Horizontal Bar Chart) */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Campaign Efficiency (ROAS)</h3>
                <p className="text-xs text-slate-400 mt-0.5">Ranked by Return on Ad Spend</p>
              </div>
            </div>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart 
                  data={campaignEfficiency} 
                  layout="vertical"
                  margin={{ top: 5, right: 20, left: 20, bottom: 5 }}
                  onClick={(d) => {
                    if (d && d.activeLabel) {
                      handleElementClick(
                        `Campaign: ${d.activeLabel}`,
                        `SELECT * FROM data WHERE campaign = '${d.activeLabel}'`,
                        `Performance metrics for campaign ${d.activeLabel}`
                      );
                    }
                  }}
                >
                  <CartesianGrid stroke="#e2e8f0" horizontal={false} />
                  <XAxis 
                    type="number" 
                    tick={{ fill: "#64748b", fontSize: 11 }} 
                    axisLine={false} 
                    tickLine={false} 
                  />
                  <YAxis 
                    type="category" 
                    dataKey="campaign" 
                    tick={{ fill: "#64748b", fontSize: 11 }} 
                    axisLine={false} 
                    tickLine={false} 
                    width={90}
                  />
                  <Tooltip 
                    contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }}
                    formatter={(value) => [`${value}x`, "ROAS"]}
                  />
                  <Bar 
                    dataKey="roas" 
                    fill="#d946ef" 
                    radius={[0, 8, 8, 0]} 
                    barSize={24}
                  >
                    {campaignEfficiency.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

        </div>

        {/* Second Row of Charts: Channel Breakdown & Conversion Velocity */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          
          {/* Channel Breakdown (Donut Chart) */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col justify-between">
            <div>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
                <div>
                  <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Channel Volume Contribution</h3>
                  <p className="text-xs text-slate-400 mt-0.5">Total conversions generated by acquisition channel</p>
                </div>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-center">
                <div className="h-56 md:col-span-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                      <Pie
                        data={channelBreakdown}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={90}
                        paddingAngle={4}
                        dataKey="value"
                        onClick={(d) => {
                          if (d && d.name) {
                            handleElementClick(
                              `Channel: ${d.name}`,
                              `SELECT * FROM data WHERE channel = '${d.name}'`,
                              `Performance metrics for channel ${d.name}`
                            );
                          }
                        }}
                      >
                        {channelBreakdown.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => [value.toLocaleString(), "Conversions"]} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>

                <div className="bg-slate-50 rounded-xl p-4 border border-slate-100 space-y-2">
                  <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Conversion Leader</h4>
                  {channelBreakdown.length > 0 ? (
                    <div>
                      <div className="text-xl font-extrabold text-slate-900">{channelBreakdown[0].name}</div>
                      <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                        Leads acquisition with <span className="font-semibold text-slate-700">{channelBreakdown[0].value.toLocaleString()}</span> total conversions.
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-400">No channel data available.</p>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5 pt-4 mt-4 border-t border-slate-100">
              {channelBreakdown.map((entry, index) => (
                <div key={entry.name} className="flex items-center gap-1.5 text-xs font-medium bg-slate-50 px-2.5 py-1 rounded-full border border-slate-100">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                  <span className="text-slate-600">{entry.name} ({entry.value.toLocaleString()})</span>
                </div>
              ))}
            </div>
          </div>

          {/* Conversion Velocity (Area Chart) */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Conversion Velocity</h3>
                  <p className="text-xs text-slate-400 mt-0.5">Cumulative conversions over time</p>
                </div>
              </div>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={conversionTrend} margin={{ top: 10, right: 10, left: -15, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorConversions" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#e2e8f0" vertical={false} />
                    <XAxis 
                      dataKey="date" 
                      tick={{ fill: "#64748b", fontSize: 11 }} 
                      axisLine={false} 
                      tickLine={false} 
                    />
                    <YAxis 
                      tick={{ fill: "#64748b", fontSize: 11 }} 
                      axisLine={false} 
                      tickLine={false} 
                    />
                    <Tooltip 
                      contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }} 
                    />
                    <Area 
                      type="monotone" 
                      dataKey="conversions" 
                      stroke="#8b5cf6" 
                      strokeWidth={3}
                      fillOpacity={1} 
                      fill="url(#colorConversions)" 
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="pt-4 mt-4 border-t border-slate-100 text-xs text-slate-400">
              Visualizing conversion volume acceleration across active campaigns.
            </div>
          </div>

        </div>

        {/* Detail Table Row */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col justify-between">
          <div>
            <div className="p-6 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Campaign & Channel Performance Matrix</h3>
                <p className="text-xs text-slate-400 mt-0.5">Granular breakdown of spend, engagement, and acquisition costs</p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead>
                  <tr className="text-xs uppercase tracking-wider text-slate-400 bg-slate-50 border-b border-slate-200">
                    <th className="font-bold px-4 py-3">Campaign</th>
                    <th className="font-bold px-4 py-3">Channel</th>
                    <th className="font-bold px-4 py-3 text-right">Spend</th>
                    <th className="font-bold px-4 py-3 text-right">Clicks</th>
                    <th className="font-bold px-4 py-3 text-right">Conversions</th>
                    <th className="font-bold px-4 py-3 text-right">CPA</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {detailTable.map((row, i) => (
                    <tr 
                      key={i} 
                      onClick={() => handleElementClick(
                        `${row.campaign} - ${row.channel}`,
                        `SELECT * FROM data WHERE campaign = '${row.campaign}' AND channel = '${row.channel}'`,
                        `Segment analysis for ${row.campaign} via ${row.channel}`
                      )}
                      className="hover:bg-slate-50/80 transition-colors cursor-pointer group"
                    >
                      <td className="px-4 py-3 font-semibold text-slate-800 group-hover:text-fuchsia-600 transition-colors text-xs">{row.campaign}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-700">
                          {row.channel}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-slate-900 tabular-nums text-xs">${row.spend.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right text-slate-500 tabular-nums text-xs">{row.clicks.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right text-slate-500 tabular-nums text-xs">{row.conversions.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right font-bold text-slate-900 tabular-nums text-xs">
                        ${row.cpa.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="p-4 bg-slate-50 border-t border-slate-100 text-xs text-slate-400 italic flex items-center gap-1 justify-center">
            <MousePointerClick size={12} /> Click rows to inspect segment
          </div>
        </div>

      </div>
    </div>
  );
}