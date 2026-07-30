// bff/sources/describe-error.ts — turn a thrown thing into a sentence.
//
// Lives here rather than inside a handler because there are now two consumers
// (the selection routes and the selection store) and a third on the way (the
// global error handler in server.ts). It was reasonable to leave it in
// selection-handler.ts while it had one caller; a second caller is when moving
// stops being churn.
//
// The reason it exists at all: `err.message` is EMPTY for the errors that matter
// most here. Node's AggregateError — what a failed pg Pool throws — has no
// message, so `err?.message ?? "fallback"` yields "" (an empty string is not
// nullish, so the fallback never fires) and the user is told "failed:" with
// nothing after it. The cause lives in `.code`, `.address`/`.port`, and in
// `.errors[0]`. This digs for it.

export function describeError(err: any, depth = 0): string {
  if (!err || depth > 3) return "";
  const parts: string[] = [];
  const msg = typeof err.message === "string" ? err.message.trim() : "";
  if (msg) parts.push(msg);
  if (err.code) parts.push(String(err.code));
  if (err.address || err.port) parts.push(`connecting to ${err.address ?? "?"}:${err.port ?? "?"}`);
  // AggregateError carries the real failures in .errors; wrapped errors use .cause.
  const inner = Array.isArray(err.errors) ? err.errors[0] : err.cause;
  if (!parts.length || (!err.code && inner)) {
    const nested = describeError(inner, depth + 1);
    if (nested) parts.push(nested);
  }
  return [...new Set(parts)].join(" ").trim() || (err.name ? String(err.name) : "");
}
