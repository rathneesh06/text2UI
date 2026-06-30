// CodeViewer.tsx — the design's tabbed code panel, fed the real generated files.
// Markup/classes match CodeViewer.css verbatim. Adds Prism's TypeScript/TSX
// grammars (the model emits App.tsx, not plain JS).
import { useEffect, useRef, useState } from "react";
import { HiOutlineClipboardCopy, HiOutlineDownload, HiOutlineCheck } from "react-icons/hi";
import Prism from "prismjs";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-css";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "./CodeViewer.css";

const LANGUAGE_MAP: Record<string, string> = {
  html: "markup",
  htm: "markup",
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  css: "css",
  json: "json",
};

function getLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_MAP[ext] || "tsx";
}

function fileIcon(name: string): string {
  if (name.endsWith(".html")) return "🌐";
  if (name.endsWith(".css")) return "🎨";
  if (/\.(jsx?|tsx?)$/.test(name)) return "⚙️";
  return "📄";
}

export interface CodeFile { name: string; content: string; }

export interface CodeViewerProps {
  files: CodeFile[];
  visible: boolean;
  onToggle: () => void;
}

export default function CodeViewer({ files, visible, onToggle }: CodeViewerProps) {
  const [activeTab, setActiveTab] = useState(0);
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (visible && codeRef.current) Prism.highlightElement(codeRef.current);
  }, [activeTab, visible, files]);

  if (!visible || files.length === 0) return null;

  const currentFile = files[Math.min(activeTab, files.length - 1)];
  const language = getLanguage(currentFile.name);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(currentFile.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable (permissions) — ignore */ }
  };

  const handleDownload = () => {
    const blob = new Blob([currentFile.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = currentFile.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="code-viewer" id="code-viewer">
      <div className="code-viewer__header">
        <div className="code-viewer__tabs">
          {files.map((file, i) => (
            <button
              key={file.name}
              className={`code-viewer__tab ${i === activeTab ? "code-viewer__tab--active" : ""}`}
              onClick={() => setActiveTab(i)}
            >
              <span className="code-viewer__tab-icon">{fileIcon(file.name)}</span>
              <span>{file.name}</span>
            </button>
          ))}
        </div>
        <div className="code-viewer__actions">
          <button className="code-viewer__action-btn" onClick={handleCopy} title="Copy code">
            {copied ? <HiOutlineCheck /> : <HiOutlineClipboardCopy />}
            <span>{copied ? "Copied!" : "Copy"}</span>
          </button>
          <button className="code-viewer__action-btn" onClick={handleDownload} title="Download file">
            <HiOutlineDownload />
            <span>Download</span>
          </button>
          <button className="code-viewer__action-btn code-viewer__close-btn" onClick={onToggle}>
            ✕
          </button>
        </div>
      </div>

      <div className="code-viewer__body">
        <div className="code-viewer__line-numbers">
          {currentFile.content.split("\n").map((_, i) => (
            <span key={i}>{i + 1}</span>
          ))}
        </div>
        <pre className="code-viewer__pre">
          <code
            ref={codeRef}
            className={`language-${language}`}
            key={`${activeTab}-${currentFile.name}`}
          >
            {currentFile.content}
          </code>
        </pre>
      </div>
    </div>
  );
}
