// ProgressBar.tsx — the design's step indicator, driven by REAL pipeline states.
// We get no streaming from the BFF (one POST per turn), so the steps are the
// honest, observable ones — no simulated "Writing Logic" theater.
// The design's Deploy button (which did nothing) is replaced by a real Export.
import { HiOutlineCheck, HiOutlineDownload } from "react-icons/hi";
import { useEffect, useRef } from "react";
import "./ProgressBar.css";

const STEPS = [
  { id: "data", label: "Data Ready" },
  { id: "generate", label: "Generating" },
  { id: "live", label: "App Live" },
] as const;

export type PipelineStep = (typeof STEPS)[number]["id"] | "idle";

export interface StatusLine { message: string; type?: "info" | "success" | "error"; }

export interface ProgressBarProps {
  /** idle = nothing yet; data = files profiled; generate = request in flight; live = app mounted */
  currentStep: PipelineStep;
  canExport: boolean;
  onExport: () => void;
  statuses?: StatusLine[];
  isGenerating?: boolean;
}

export default function ProgressBar({ currentStep, canExport, onExport, statuses = [], isGenerating = false }: ProgressBarProps) {
  const statusesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    statusesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [statuses]);
  const stepIndex = STEPS.findIndex((s) => s.id === currentStep);

  return (
    <div className="progress-bar">
      <div className="progress-bar__row">
        <div className="progress-bar__steps">
          {STEPS.map((step, i) => {
            let status: "pending" | "active" | "completed" = "pending";
            if (currentStep === "live") status = "completed"; // terminal state: all done
            else if (i < stepIndex) status = "completed";
            else if (i === stepIndex) status = "active";

            return (
              <div key={step.id} className={`progress-bar__step progress-bar__step--${status}`}>
                <div className="progress-bar__dot">
                  {status === "completed" ? (
                    <HiOutlineCheck className="progress-bar__check" />
                  ) : status === "active" ? (
                    <span className="progress-bar__pulse" />
                  ) : (
                    <span className="progress-bar__empty" />
                  )}
                </div>
                <span className="progress-bar__label">{step.label}</span>
                {i < STEPS.length - 1 && (
                  <div
                    className={`progress-bar__connector ${
                      i < stepIndex || currentStep === "live" ? "progress-bar__connector--filled" : ""
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>

        <button
          className={`progress-bar__deploy ${canExport ? "progress-bar__deploy--ready" : ""}`}
          onClick={onExport}
          disabled={!canExport}
          id="export-btn"
          title="Download the generated App.tsx"
        >
          <HiOutlineDownload />
          <span>Export App.tsx</span>
        </button>
      </div>

      {isGenerating && statuses.length > 0 && (
        <div className="progress-bar__stream">
          <div className="progress-bar__stream-label">Steps:</div>
          <div className="progress-bar__stream-logs">
            {statuses.map((s, i) => (
              <div key={i} className={`progress-bar__stream-line progress-bar__stream-line--${s.type || "info"}`}>
                <span className="progress-bar__stream-prefix">›</span>
                <span>{s.message}</span>
              </div>
            ))}
            <div ref={statusesEndRef} />
          </div>
        </div>
      )}
    </div>
  );
}
