// FinalDesign.tsx — Wave 1 / N5, Step 3: the polished "finished app" display.
// A full-screen, read-only render of the generated app WITHOUT the editor chrome
// (no device toggles, no status terminal, no version rail) — just the app, plus a
// header with a "Download project" action. Reuses the real <Sandbox> mount so what
// the user sees here is exactly what they'll get in the exported project.
import { useEffect, useState } from "react";
import { HiOutlineDownload, HiOutlineX } from "react-icons/hi";
import Sandbox from "./Sandbox";
import type { GeneratedApp } from "../../shared/types";
import type { TableData, RemoteDataConfig } from "../lib/data";
import "./FinalDesign.css";

const BAR_HEIGHT = 56;

export interface FinalDesignProps {
  app: GeneratedApp;
  tables: TableData[];
  remote?: RemoteDataConfig;
  title?: string;
  onClose: () => void;
  onDownload: () => void;
  downloading?: boolean;
}

export default function FinalDesign({
  app,
  tables,
  remote,
  title,
  onClose,
  onDownload,
  downloading = false,
}: FinalDesignProps) {
  const [stageHeight, setStageHeight] = useState(() =>
    typeof window !== "undefined" ? window.innerHeight - BAR_HEIGHT : 720,
  );

  useEffect(() => {
    const onResize = () => setStageHeight(window.innerHeight - BAR_HEIGHT);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="final-design" role="dialog" aria-modal="true">
      <header className="final-design__bar">
        <span className="final-design__title">{title || app.summary || "Finished app"}</span>
        <div className="final-design__actions">
          <button
            className="final-design__btn final-design__btn--primary"
            onClick={onDownload}
            disabled={downloading}
          >
            <HiOutlineDownload />
            <span>{downloading ? "Preparing\u2026" : "Download project"}</span>
          </button>
          <button className="final-design__btn final-design__btn--icon" onClick={onClose} aria-label="Close preview">
            <HiOutlineX />
          </button>
        </div>
      </header>
      <div className="final-design__stage">
        <Sandbox
          app={app}
          tables={tables}
          remote={remote}
          height={Math.max(480, stageHeight)}
          theme="light"
        />
      </div>
    </div>
  );
}
