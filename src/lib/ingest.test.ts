import * as XLSX from "xlsx";
import { ingest } from "./ingest";

const csv = `id,name,signup_date,revenue,active
1,Acme,2024-01-15,1200.50,true
2,Globex,2024-02-03,980,false
3,Initech,2024-02-20,,true
4,Umbrella,2024-03-01,4500.00,true`;

console.log("=== CSV ===");
const csvOut = ingest("customers.csv", csv);
console.log(JSON.stringify(csvOut.profile, null, 2));
console.log("rows parsed:", csvOut.rows.length);

console.log("\n=== JSON (nested under 'data') ===");
const json = JSON.stringify({
  data: [
    { sku: "A1", price: 9.99, qty: 3, category: "tools" },
    { sku: "B2", price: 19.5, qty: 0, category: "tools" },
    { sku: "C3", price: 4, qty: 12, category: "parts" },
  ],
});
const jsonOut = ingest("inventory.json", json);
console.log(JSON.stringify(jsonOut.profile.columns, null, 2));

console.log("\n=== XLSX (native types + dates) ===");
const ws = XLSX.utils.json_to_sheet([
  { order: 1001, customer: "Acme", placed: new Date("2024-05-01"), total: 250 },
  { order: 1002, customer: "Globex", placed: new Date("2024-05-04"), total: 99.95 },
]);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Orders");
const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
const xlsxOut = ingest("orders.xlsx", buf);
console.log("sheet:", xlsxOut.profile.source.sheetName);
console.log(JSON.stringify(xlsxOut.profile.columns, null, 2));
