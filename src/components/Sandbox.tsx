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

export default function Sandbox({
  app,
  tables,
  onRuntimeError,
  showEditor = false,
  height = 560,
  theme = "light",
  remote,
}: SandboxProps) {
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