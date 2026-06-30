// bff/design-rag/render-data.ts — the synthetic data module injected into the
// render page (as the exemplars' "./data" import).
//
// Exemplars call `query(sql)` against a `data` table backed by DuckDB-WASM at
// runtime. For one-time reference screenshots we don't need real SQL — we need
// the charts/KPIs to POPULATE so the design reads as a finished dashboard. So
// query() parses the SELECT clause to learn the result columns and returns
// deterministic synthetic rows of the right shape. It is shipped as a JS string
// (DATA_MODULE_JS) so the in-page module and the offline test run identical code.

export const DATA_MODULE_JS = `
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const CATS = ["Alpha","Bravo","Charlie","Delta","Echo","Foxtrot","Golf","Hotel","India","Juliet"];

function strHash(s){let h=2166136261>>>0;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)>>>0;}return h>>>0;}
function rnd(seed){let t=(seed+0x6D2B79F5)>>>0;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;}

// Parse a SELECT clause into output columns: { name, kind: 'num'|'date'|'cat', distinct }.
export function __columnsOf(sql){
  const m = /select\\s+([\\s\\S]*?)\\s+from\\b/i.exec(sql || "");
  if(!m) return [];
  let list = m[1];
  const distinct = /^\\s*distinct\\b/i.test(list);
  list = list.replace(/^\\s*distinct\\b/i, "");
  if(/^\\s*\\*\\s*$/.test(list)){
    return ["id","name","category","value","amount","date"].map((n)=>({name:n, kind: n==="date"?"date":(n==="value"||n==="amount"||n==="id")?"num":"cat", distinct:false}));
  }
  // split on top-level commas (ignore commas inside parens)
  const parts=[]; let depth=0, cur="";
  for(const ch of list){ if(ch==='(')depth++; else if(ch===')')depth--; if(ch===',' && depth===0){parts.push(cur);cur="";} else cur+=ch; }
  if(cur.trim()) parts.push(cur);
  return parts.map((raw)=>{
    const c = raw.trim();
    const asM = /\\sas\\s+["'\\\`]?([A-Za-z_][\\w]*)["'\\\`]?\\s*$/i.exec(c);
    let name;
    if(asM){ name = asM[1]; }
    else {
      const fn = /^(\\w+)\\s*\\(/.exec(c);
      name = fn ? fn[1].toLowerCase() : c.replace(/^[\\w]+\\./, "");
    }
    name = name.replace(/["'\\\`]/g, "").trim();
    const agg = /\\b(sum|count|avg|min|max|total)\\b/i.test(c);
    const dateish = /\\b(date|month|day|year|time|week|quarter)\\b/i.test(name);
    return { name, kind: agg ? "num" : dateish ? "date" : "cat", distinct };
  });
}

export async function query(sql){
  const cols = __columnsOf(sql);
  if(!cols.length) return [];
  const allNum = cols.every((c)=>c.kind==="num");
  const anyDistinct = cols.some((c)=>c.distinct);
  // single-row aggregate (KPI) vs a list/series
  const n = anyDistinct ? 6 : (cols.length <= 2 && allNum ? 1 : 8);
  const seed = strHash(sql);
  const out = [];
  for(let i=0;i<n;i++){
    const row = {};
    for(const c of cols){
      if(c.kind==="num") row[c.name] = Math.round(rnd(seed + i*131 + c.name.length*7) * 9000 + 1000);
      else if(c.kind==="date") row[c.name] = MONTHS[i % 12];
      else row[c.name] = CATS[i % CATS.length];
    }
    out.push(row);
  }
  return out;
}

export const rows = [];
`;

/** The no-op selection module (exemplars import { selectFeature } from "./selection"). */
export const SELECTION_MODULE_JS = `export function selectFeature(){}\nexport const rows = [];\n`;
