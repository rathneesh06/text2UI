// src/components/ChatMarkdown.tsx — the chat's text renderer.
//
// WHY THIS EXISTS AND NOT `marked`
// Assistant replies are model output. Rendering model output through an HTML
// markdown library means `dangerouslySetInnerHTML`, which turns every reply into
// an XSS surface — and the analyst chat's replies contain values read out of
// whatever database the user pasted. So this builds React elements directly and
// never touches innerHTML. No sanitiser to keep current, no new dependency.
//
// STREAMING-SAFE BY CONSTRUCTION
// Tokens arrive mid-word, so this is called on half-finished markdown many times
// a second. Every inline rule requires its CLOSING delimiter to match; an
// unterminated `**bold` renders as the literal characters until its partner
// arrives, then snaps into place. Nothing throws on partial input, and an
// unterminated fence renders as a code block that grows — which is what you want
// to watch happen.
//
// Deliberately NOT supported: raw HTML (ignored as text), images, tables. The
// analyst prompt is told not to emit tables; if that changes, add them here
// rather than reaching for a library.
import { memo, type ReactNode } from "react";
import "./ChatMarkdown.css";

/** Inline: `code`, **bold**, *italic*, [text](href). Applied in that order so a
 *  code span's contents are never re-parsed as emphasis. */
function inline(src: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  // One pass, one regex, alternation ordered by precedence.
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|(?<!\*)\*([^*]+)\*(?!\*)|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const k = `${keyPrefix}-i${i++}`;
    if (m[1] !== undefined) out.push(<code key={k} className="md-code">{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={k}>{m[2]}</strong>);
    else if (m[3] !== undefined) out.push(<em key={k}>{m[3]}</em>);
    else if (m[4] !== undefined) {
      const href = m[5];
      // Only http(s). A model-authored `javascript:` URL is not a link we render.
      const safe = /^https?:\/\//i.test(href);
      out.push(safe
        ? <a key={k} href={href} target="_blank" rel="noopener noreferrer nofollow">{m[4]}</a>
        : <span key={k}>{m[4]}</span>);
    }
    last = re.lastIndex;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; level: number; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "pre"; lines: string[]; lang: string };

/** Line-oriented block parse. Tolerant: anything unrecognised is a paragraph. */
function parse(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code. An unterminated fence consumes the rest — correct while streaming.
    const fence = /^```\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++; // closing fence
      blocks.push({ kind: "pre", lines: body, lang });
      continue;
    }

    if (!line.trim()) { i++; continue; }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { blocks.push({ kind: "h", level: h[1].length, text: h[2] }); i++; continue; }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", lines: body });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ""));
      blocks.push({ kind: "ul", items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      blocks.push({ kind: "ol", items });
      continue;
    }

    const body: string[] = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^```/.test(lines[i]) && !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i])
    ) body.push(lines[i++]);
    blocks.push({ kind: "p", lines: body });
  }
  return blocks;
}

/** Memoised: while a reply streams, every sibling turn re-renders on each token
 *  otherwise. Only the growing message reparses. */
export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  const blocks = parse(text ?? "");
  return (
    <div className="md">
      {blocks.map((b, n) => {
        const k = `b${n}`;
        switch (b.kind) {
          case "h": {
            const Tag = (`h${Math.min(b.level + 2, 6)}`) as "h3" | "h4" | "h5" | "h6";
            return <Tag key={k} className="md-h">{inline(b.text, k)}</Tag>;
          }
          case "pre":
            return <pre key={k} className="md-pre" data-lang={b.lang || undefined}><code>{b.lines.join("\n")}</code></pre>;
          case "ul":
            return <ul key={k} className="md-list">{b.items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>)}</ul>;
          case "ol":
            return <ol key={k} className="md-list">{b.items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>)}</ol>;
          case "quote":
            return <blockquote key={k} className="md-quote">{inline(b.lines.join(" "), k)}</blockquote>;
          default:
            return <p key={k} className="md-p">{inline(b.lines.join("\n"), k)}</p>;
        }
      })}
    </div>
  );
});

export default ChatMarkdown;
