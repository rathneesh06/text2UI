// Sandbox.tsx — pipeline stage 4 mount (BROWSER).
// Thin React wrapper: takes a GeneratedApp + the user's rows, builds the Sandpack
// config, renders the live preview, and forwards runtime/compile errors out so the
// caller can drive the self-heal loop. Verified against @codesandbox/sandpack-react v2.
import { useEffect, useMemo } from "react";
import {
  SandpackProvider,
  SandpackLayout,
  SandpackPreview,
  SandpackCodeEditor,
  useSandpack,
} from "@codesandbox/sandpack-react";
import type { GeneratedApp } from "../../shared/types";
import { buildSandpackConfig, SANDBOX_EXTERNAL_RESOURCES } from "../lib/sandbox";
import type { TableData, RemoteDataConfig } from "../lib/data";

export interface SandboxProps {
  app: GeneratedApp;
  tables: TableData[];
  /** Called with a normalized error string whenever the preview throws. */
  onRuntimeError?: (error: string) => void;
  /** Show the read/edit code panel beside the preview. */
  showEditor?: boolean;
  height?: number;
  /** Sandpack theme — "light" by default (the app stage stays light inside the dark shell). */
  theme?: "light" | "dark" | "auto";
  /** When set, the sandbox queries the BFF instead of embedding rows (M1 backend). */
  remote?: RemoteDataConfig;
}

// Lives inside the provider so it can read Sandpack's reactive error state.
// sandpack.error is set for both compile and runtime errors (it drives the
// "Something went wrong" overlay), so this reliably fires the self-heal hook.
function RuntimeErrorBridge({ onError }: { onError?: (e: string) => void }) {
  const { sandpack } = useSandpack();
  const message = sandpack.error?.message ?? null;
  const path = sandpack.error?.path;
  useEffect(() => {
    if (onError && message) {
      onError(path ? `${message} (${path})` : message);
    }
  }, [onError, message, path]);
  return null;
}

/** Host side of the sandbox data bridge. The preview iframe runs on a foreign
 *  https origin, and browsers can block its direct fetches to http://localhost
 *  (mixed-content / private-network rules — not fixable by server CORS). So the
 *  generated data.js posts `t2ui.query` to the host, this hook performs the
 *  fetch from the app's own origin (same-site with the BFF — always allowed),
 *  and replies to the SENDING window with `t2ui.queryResult`.
 *  Security: queries only ever run against the host-configured projectId — a
 *  message cannot pick a different project — and replies go only to e.source. */
function useQueryBridge(remote?: RemoteDataConfig) {
  useEffect(() => {
    if (!remote) return;
    const onMsg = async (e: MessageEvent) => {
      const d = e.data as any;
      const isSql = d && d.type === "t2ui.query" && typeof d.sql === "string";
      // A1: filtered widget queries — the sandbox sends a typed widget + filter
      // VALUES; the host forwards them and the SERVER rebuilds the SQL.
      const isWidget = d && d.type === "t2ui.widgetQuery" && d.widget && typeof d.widget === "object";
      if (!d || (!isSql && !isWidget) || typeof d.id !== "string") return;
      const source = e.source as Window | null;
      if (!source) return;
      // Only answer iframes embedded in this document. That blocks external
      // windows (openers, hostile framers) while accepting any sandpack origin —
      // an origin allowlist would be as brittle here as it was for CORS.
      const embedded = Array.from(document.querySelectorAll("iframe"))
        .some((f) => f.contentWindow === source);
      if (!embedded) return;
      const reply = (body: object) => {
        try { source.postMessage({ type: "t2ui.queryResult", id: d.id, ...body }, e.origin); } catch { /* frame gone */ }
      };
      try {
        const res = isWidget
          ? await fetch(`${remote.bffUrl}/api/dashboard/query`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ projectId: remote.projectId, widget: d.widget, filters: Array.isArray(d.filters) ? d.filters : [] }),
            })
          : await fetch(`${remote.bffUrl}/api/query`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ projectId: remote.projectId, sql: d.sql }),
            });
        const json: any = await res.json().catch(() => ({}));
        if (!res.ok) return reply({ ok: false, error: json.error || `query failed: HTTP ${res.status}` });
        if (json.truncated) console.warn("[sandbox] query result truncated by the server row cap");
        reply({ ok: true, rows: json.rows ?? [] });
      } catch (err) {
        reply({ ok: false, error: (err as Error)?.message || "query failed" });
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [remote]);
}

export default function Sandbox({
  app,
  tables,
  onRuntimeError,
  showEditor = false,
  height = 560,
  theme = "light",
  remote,
}: SandboxProps) {
  useQueryBridge(remote);
  const { files, customSetup, needsCdnFallback } = useMemo(
    () => buildSandpackConfig(app, tables, remote),
    [app, tables, remote],
  );
  // Compiled CSS ships inside index.html; only pull the CDN when it's missing.
  const externalResources = useMemo(
    () => (needsCdnFallback ? ["https://cdn.tailwindcss.com"] : SANDBOX_EXTERNAL_RESOURCES),
    [needsCdnFallback],
  );

  return (
    <SandpackProvider
      template="react-ts"
      theme={theme}
      files={files}
      customSetup={customSetup}
      options={{
        recompileMode: "delayed",
        recompileDelay: 300,
        externalResources: externalResources, // CDN only when no compiled CSS
      }}
    >
      <RuntimeErrorBridge onError={onRuntimeError} />
      <SandpackLayout>
        {showEditor && (
          <SandpackCodeEditor showLineNumbers showTabs style={{ height }} />
        )}
        <SandpackPreview
          showOpenInCodeSandbox={false}
          showRefreshButton
          style={{ height }}
        />
      </SandpackLayout>
    </SandpackProvider>
  );
}