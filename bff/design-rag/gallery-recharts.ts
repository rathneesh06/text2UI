// bff/design-rag/gallery-recharts.ts — curated, self-contained Recharts dashboard
// compositions (Increment 2). Each is a default-exported component with inline
// data and a compact KPI-row + multi-column chart grid, rendered through the
// exemplar harness (Tailwind + Recharts). MIT (Recharts).

import type { GallerySpec } from "./gallery";

const LICENSE = "MIT";
const ATTRIBUTION = "Recharts (MIT) — curated dashboard compositions";
const SOURCE = "https://recharts.org";

const sales = `
import { BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
const months = [["Jan",420,310],["Feb",510,380],["Mar",470,360],["Apr",560,420],["May",600,450],["Jun",640,500],["Jul",610,470],["Aug",680,520],["Sep",720,560],["Oct",700,540],["Nov",760,590],["Dec",810,640]];
const data = months.map(([m,rev,ord]) => ({ m, rev, ord }));
const kpis = [["Revenue","$7.8M","+12.4%"],["Orders","48,210","+5.1%"],["AOV","$162","+2.3%"],["Refunds","1.8%","-0.4%"]];
export default function App() {
  return (
    <div className="min-h-screen bg-slate-50 p-5 text-slate-800">
      <h1 className="text-lg font-semibold mb-4">Sales Overview</h1>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        {kpis.map(([l,v,d]) => (
          <div key={l} className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="text-xs text-slate-500">{l}</div>
            <div className="text-2xl font-semibold mt-1">{v}</div>
            <div className="text-xs mt-1 text-emerald-600">{d}</div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="text-sm font-medium mb-2">Revenue by month</div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="m" fontSize={11}/><YAxis fontSize={11}/><Tooltip/><Bar dataKey="rev" fill="#6366f1" radius={[4,4,0,0]}/></BarChart>
          </ResponsiveContainer>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="text-sm font-medium mb-2">Orders trend</div>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={data}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="m" fontSize={11}/><YAxis fontSize={11}/><Tooltip/><Area dataKey="ord" stroke="#06b6d4" fill="#cffafe"/></AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}`;

const finance = `
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
const data = [["Q1",240,180],["Q2",280,210],["Q3",260,230],["Q4",320,250],["Q5",350,260],["Q6",400,300]].map(([q,inc,exp])=>({q,inc,exp}));
const kpis = [["Net Income","$4.1M","+8.2%"],["Cash Flow","$1.6M","+3.4%"],["Burn","$420K","-1.1%"],["Runway","18 mo","+2 mo"]];
export default function App() {
  return (
    <div className="min-h-screen bg-white p-5 text-slate-800">
      <h1 className="text-lg font-semibold mb-4">Finance Summary</h1>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        {kpis.map(([l,v,d]) => (
          <div key={l} className="rounded-xl border border-slate-200 p-4 bg-slate-50">
            <div className="text-xs text-slate-500">{l}</div>
            <div className="text-2xl font-semibold mt-1">{v}</div>
            <div className="text-xs mt-1 text-emerald-600">{d}</div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl border border-slate-200 p-4">
          <div className="text-sm font-medium mb-2">Income vs Expense</div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={data}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="q" fontSize={11}/><YAxis fontSize={11}/><Tooltip/><Legend/><Line dataKey="inc" stroke="#16a34a" strokeWidth={2} dot={false}/><Line dataKey="exp" stroke="#ef4444" strokeWidth={2} dot={false}/></LineChart>
          </ResponsiveContainer>
        </div>
        <div className="rounded-xl border border-slate-200 p-4">
          <div className="text-sm font-medium mb-2">Net by quarter</div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="q" fontSize={11}/><YAxis fontSize={11}/><Tooltip/><Bar dataKey="inc" fill="#14b8a6" radius={[4,4,0,0]}/></BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}`;

const webAnalytics = `
import { AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
const traffic = Array.from({length:14},(_,i)=>({d:"D"+(i+1), v: 800+Math.round(Math.sin(i/2)*200)+i*30}));
const sources = [["Organic",44],["Direct",26],["Social",18],["Referral",12]].map(([n,v])=>({n,v}));
const COLORS=["#6366f1","#06b6d4","#f59e0b","#ec4899"];
const kpis = [["Sessions","128K","+9.1%"],["Users","94K","+6.7%"],["Bounce","38%","-1.2%"],["Avg Time","3m 12s","+0.4%"]];
export default function App() {
  return (
    <div className="min-h-screen bg-slate-50 p-5 text-slate-800">
      <h1 className="text-lg font-semibold mb-4">Web Analytics</h1>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        {kpis.map(([l,v,d]) => (
          <div key={l} className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="text-xs text-slate-500">{l}</div>
            <div className="text-2xl font-semibold mt-1">{v}</div>
            <div className="text-xs mt-1 text-emerald-600">{d}</div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 p-4">
          <div className="text-sm font-medium mb-2">Sessions (14d)</div>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={traffic}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="d" fontSize={11}/><YAxis fontSize={11}/><Tooltip/><Area dataKey="v" stroke="#6366f1" fill="#e0e7ff"/></AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="text-sm font-medium mb-2">Traffic sources</div>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart><Pie data={sources} dataKey="v" nameKey="n" innerRadius={45} outerRadius={80}>{sources.map((_,i)=><Cell key={i} fill={COLORS[i]}/>)}</Pie><Tooltip/></PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}`;

export const RECHARTS_SPECS: GallerySpec[] = [
  { id: "recharts-sales", renderer: "recharts", code: sales, domainHint: "sales", license: LICENSE, attribution: ATTRIBUTION, sourceUrl: SOURCE },
  { id: "recharts-finance", renderer: "recharts", code: finance, domainHint: "finance", license: LICENSE, attribution: ATTRIBUTION, sourceUrl: SOURCE },
  { id: "recharts-web", renderer: "recharts", code: webAnalytics, domainHint: "web_analytics", license: LICENSE, attribution: ATTRIBUTION, sourceUrl: SOURCE },
];
