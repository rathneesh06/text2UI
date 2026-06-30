import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server for the builder UI. Set VITE_BFF_URL if the BFF isn't on :8787.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    watch: {
      // bff/ is SERVER ONLY (tsx watches it); Vite must never watch it.
      // Critically, bff/data/*.duckdb is held locked by DuckDB on Windows —
      // letting the watcher touch it crashes Vite with EBUSY.
      ignored: ["**/bff/**", "**/*.duckdb", "**/*.duckdb.wal"],
    },
  },
});