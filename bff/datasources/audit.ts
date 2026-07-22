// bff/datasources/audit.ts — the audit trail (doc: "prompt -> plan -> validation
// outcome -> query plan -> execution -> rendered change").
//
// Append-only JSONL, one line per pipeline stage, correlated by a turn id — the
// minimum viable lineage: enough to answer "why does this widget exist and what
// SQL fed it" for any past turn, without a telemetry stack. Fire-and-forget:
// auditing can never fail a build.
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const AUDIT_DIR = process.env.T2UI_AUDIT_DIR || "./.t2ui";
const AUDIT_FILE = path.join(AUDIT_DIR, "audit.jsonl");
const ENABLED = (process.env.T2UI_AUDIT ?? "1") === "1";

export interface AuditEvent {
  at?: string;
  turnId: string;
  conversationId?: string;
  stage: "prompt" | "enhance" | "decompose" | "agents" | "edit_ops" | "history" | "validate" | "render" | "reject" | "query";
  detail: Record<string, unknown>;
}

let warned = false;

/** Append one audit line. Never throws, never blocks the pipeline. */
export function audit(event: AuditEvent): void {
  if (!ENABLED) return;
  const line = JSON.stringify({ at: new Date().toISOString(), ...event });
  void (async () => {
    try {
      await mkdir(AUDIT_DIR, { recursive: true });
      await appendFile(AUDIT_FILE, line + "\n", "utf-8");
    } catch (err) {
      if (!warned) { warned = true; console.warn(`[audit] disabled (write failed: ${(err as Error).message})`); }
    }
  })();
}

export function newTurnId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
