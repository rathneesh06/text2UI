// LivePreview.tsx — the design's preview chrome (header, device toggles, browser bar,
// status terminal) wrapped around text2UI's REAL preview: the Sandpack <Sandbox>.
// The demo iframe/doc.write is gone — a static iframe can't host the generated app.
// Stage is intentionally LIGHT inside the dark shell (generated apps render on white).
import { useEffect, useRef, useState } from "react";
import { HiOutlineDeviceMobile, HiOutlineDesktopComputer } from "react-icons/hi";
import { BsTablet } from "react-icons/bs";
import Sandbox from "./Sandbox";
import type { GeneratedApp } from "../../shared/types";
import type { TableData, RemoteDataConfig } from "../lib/data";
import "./LivePreview.css";

const DEVICE_SIZES: Record<string, { width: number | string; label: string }> = {
  mobile: { width: 375, label: "Mobile" },
  tablet: { width: 768, label: "Tablet" },
  desktop: { width: "100%", label: "Desktop" },
};

export interface StatusLine { message: string; type?: "info" | "success" | "error"; id?: string; }

export interface LivePreviewProps {
  app: GeneratedApp | null;
  tables: TableData[];
  remote?: RemoteDataConfig;
  statuses: StatusLine[];
  /** rolling tail of the code as the model writes it (streaming mode) */
  streamTail?: string | null;
  isGenerating: boolean;
  versions: { id: string; label: string }[];
  activeVersion: number;
  onPickVersion: (i: number) => void;
  runtimeError: string | null;
  onAutoFix: () => void;
  onRuntimeError: (e: string) => void;
}

export default function LivePreview({
  app,
  tables,
  remote,
  statuses,
  streamTail = null,
  isGenerating,
  versions,
  activeVersion,
  onPickVersion,
  runtimeError,
  onAutoFix,
  onRuntimeError,
}: LivePreviewProps) {
  const [device, setDevice] = useState<"mobile" | "tablet" | "desktop">("desktop");
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [statuses, streamTail]);

  const showSandbox = !!app && !isGenerating;
  const deviceWidth = DEVICE_SIZES[device].width;

  return (
    <div className="live-preview">
      <div className="live-preview__header">
        <h3 className="live-preview__title">Live Preview</h3>
        {showSandbox && (
          <span className="live-preview__running">
            <span className="live-preview__running-dot" />
            Running
          </span>
        )}
        {versions.length > 0 && (
          <div className="live-preview__versions">
            {versions.map((v, i) => (
              <button
                key={v.id}
                className={`version-pill ${i === activeVersion ? "version-pill--active" : ""}`}
                onClick={() => onPickVersion(i)}
                title={v.label}
              >
                v{i + 1}
              </button>
            ))}
          </div>
        )}
        <div className="live-preview__devices">
          {([
            ["mobile", HiOutlineDeviceMobile],
            ["tablet", BsTablet],
            ["desktop", HiOutlineDesktopComputer],
          ] as const).map(([key, Icon]) => (
            <button
              key={key}
              className={`live-preview__device-btn ${device === key ? "active" : ""}`}
              onClick={() => setDevice(key)}
              title={DEVICE_SIZES[key].label}
            >
              <Icon />
              <span className="live-preview__device-label">{DEVICE_SIZES[key].label}</span>
            </button>
          ))}
        </div>
        <span className="live-preview__version">
          {versions.length ? `v${activeVersion + 1} of ${versions.length}` : "no build yet"}
        </span>
      </div>

      <div className="live-preview__frame">
        <div className="live-preview__browser-bar">
          <div className="live-preview__dots">
            <span className="dot dot--red" />
            <span className="dot dot--yellow" />
            <span className="dot dot--green" />
          </div>
          <div className="live-preview__url-bar">
            <span>preview.app/live</span>
          </div>
        </div>

        {runtimeError && showSandbox && (
          <div className="live-preview__autofix">
            <span>Runtime error</span>
            <span className="live-preview__autofix-msg">{runtimeError}</span>
            <button className="live-preview__autofix-btn" onClick={onAutoFix} disabled={isGenerating}>
              Auto-fix
            </button>
          </div>
        )}

        <div
          className={`live-preview__content ${showSandbox ? "live-preview__content--light" : ""}`}
          id="preview-container"
        >
          {!showSandbox ? (
            <div className="live-preview__terminal">
              <div className="terminal__lines">
                {statuses.length > 0 ? (
                  statuses.map((log, i) => (
                    <div key={i} className={`terminal__line terminal__line--${log.type || "info"}`}>
                      <span className="terminal__prefix">{">"}</span>
                      <span>{log.message}</span>
                    </div>
                  ))
                ) : (
                  <div className="terminal__placeholder">
                    <span className="terminal__cursor">_</span>
                    <span>Waiting for prompt...</span>
                  </div>
                )}
                {streamTail && (
                  <pre className="terminal__stream">
                    {streamTail}
                    <span className="terminal__cursor">▌</span>
                  </pre>
                )}
                <div ref={logsEndRef} />
              </div>
            </div>
          ) : (
            <div
              className="live-preview__sandbox"
              style={{ width: typeof deviceWidth === "number" ? `${deviceWidth}px` : deviceWidth }}
            >
              <Sandbox
                app={app!}
                tables={tables}
                remote={remote}
                onRuntimeError={onRuntimeError}
                height={560}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}