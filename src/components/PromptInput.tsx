// PromptInput.tsx — the prompt box (design: aibuilder), extended with what text2UI
// actually needs: a real data-file attach (hidden input + drag-drop) and table chips.
import { useRef, useState, type ReactNode } from "react";
import { HiOutlinePaperClip } from "react-icons/hi";
import type { Table } from "../lib/datasets";
import "./PromptInput.css";

const ACCEPT = ".csv,.tsv,.xlsx,.xls,.json";

export function DataChips({ tables, onRemove }: { tables: Table[]; onRemove?: (id: string) => void }) {
  if (!tables.length) return null;
  return (
    <div className="prompt-input__chips">
      {tables.map((t) => (
        <span className="data-chip" key={t.id}>
          <code className="data-chip__tbl">{t.tableName}</code>
          <span>{t.filename}</span>
          <span className="data-chip__meta">{t.ingest.profile.rowCount.toLocaleString()} rows</span>
          {onRemove && (
            <button className="data-chip__x" onClick={() => onRemove(t.id)} aria-label={`Remove ${t.filename}`}>
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

export interface PromptInputProps {
  onSubmit: (prompt: string) => void;
  onFiles?: (files: FileList | File[]) => void;
  placeholder?: string;
  variant?: "hero" | "dashboard";
  initialValue?: string;
  disabled?: boolean;
  canSubmit?: boolean; // extra gate beyond non-empty text (e.g. "has data")
  error?: string | null;
  submitLabel?: string;
  children?: ReactNode; // chips row
}

export default function PromptInput({
  onSubmit,
  onFiles,
  placeholder = "Describe your dream app...",
  variant = "hero",
  initialValue = "",
  disabled = false,
  canSubmit = true,
  error = null,
  submitLabel,
  children,
}: PromptInputProps) {
  const [value, setValue] = useState(initialValue);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const isHero = variant === "hero";

  const handleSubmit = () => {
    if (value.trim() && !disabled && canSubmit) {
      onSubmit(value.trim());
      if (!isHero) setValue("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const dropHandlers = onFiles
    ? {
        onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDragOver(true); },
        onDragLeave: () => setDragOver(false),
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) onFiles(e.dataTransfer.files);
        },
      }
    : {};

  return (
    <div
      className={`prompt-input prompt-input--${variant} ${dragOver ? "prompt-input--drag" : ""}`}
      {...dropHandlers}
    >
      <div className="prompt-input__wrapper">
        {onFiles && (
          <>
            <button
              className="prompt-input__attachment"
              title="Attach a data file (CSV, Excel, JSON)"
              onClick={() => fileInput.current?.click()}
            >
              <HiOutlinePaperClip />
            </button>
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) onFiles(e.target.files);
                e.target.value = ""; // allow re-adding the same file
              }}
            />
          </>
        )}

        {isHero ? (
          <input
            type="text"
            className="prompt-input__field"
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            id="prompt-input-field"
          />
        ) : (
          <textarea
            className="prompt-input__field prompt-input__field--textarea"
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            rows={3}
            id="prompt-textarea-field"
          />
        )}

        <button
          className="prompt-input__submit"
          onClick={handleSubmit}
          disabled={!value.trim() || disabled || !canSubmit}
          id="build-now-btn"
        >
          <span>{submitLabel ?? (isHero ? "Build Now" : "Update App")}</span>
          <span className="prompt-input__submit-icon">✦</span>
        </button>
      </div>

      {children}
      {error && <p className="prompt-input__error">{error}</p>}
    </div>
  );
}
