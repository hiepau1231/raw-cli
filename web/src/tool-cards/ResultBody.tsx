import type { ReactNode } from "react";
import type { PreviewSegment, VisibleToolResult } from "../../../src/sessions/visible.js";
import type { ToolResultType } from "../../../src/tools/display.js";
import { highlightLine, Markdown } from "../markdown.js";
import { CopyButton } from "../ui.js";
import { JsonTree } from "./JsonTree.js";

const HIDDEN = /^… \[(\d+) lines hidden\] …$/;
const textOf = (segments: PreviewSegment[]) => segments.map((segment) => segment.text).join("\n");

/** A dark terminal frame with a copy button; the output keeps its lines and spacing. */
export function TerminalFrame({ label, text }: { label: string; text: string }) {
  return (
    <div className="terminal-frame">
      <div className="terminal-bar">
        <span>{label}</span>
        <CopyButton value={text} label={`Copy ${label.toLowerCase()}`} />
      </div>
      <pre tabIndex={0}>
        <code>{text}</code>
      </pre>
    </div>
  );
}

/** Code lines with their file line numbers: they start at the window's first line and skip the hidden lines. */
function CodeLines({ segments, start, path }: { segments: PreviewSegment[]; start: number; path?: string | undefined }) {
  const language = path?.split("/").pop()?.split(".").slice(1).pop()?.toLowerCase() ?? "text";
  let line = start;
  const rows: ReactNode[] = segments.map((segment, index) => {
    if (segment.kind === "code") {
      const number = line++;
      return (
        <span className="code-line" key={index}>
          <span className="line-number" aria-hidden="true">{number}</span>
          <span>{highlightLine(language, segment.text)}</span>
          {"\n"}
        </span>
      );
    }
    const hidden = HIDDEN.exec(segment.text);
    if (hidden) line += Number(hidden[1]);
    return (
      <span className={`code-line ${hidden ? "code-gap" : "code-note"}`} key={index}>
        <span className="line-number" aria-hidden="true" />
        <span>{segment.text}</span>
        {"\n"}
      </span>
    );
  });
  return (
    <div className="code-block code-file">
      <div className="code-label">
        <span>{path ?? language}</span>
        <CopyButton
          value={textOf(segments.filter((segment) => segment.kind === "code"))}
          label="Copy code"
        />
      </div>
      <pre tabIndex={0}>
        <code>{rows}</code>
      </pre>
    </div>
  );
}

/**
 * Each line's class in a unified diff. File headers are recognized only outside a hunk; inside one, the line counts of
 * its `@@` header decide where it ends, so a changed line whose text starts with `--` or `++` stays a change.
 */
function diffKinds(lines: string[]): string[] {
  let oldLeft = 0;
  let newLeft = 0;
  return lines.map((line) => {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
      return "diff-hunk";
    }
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("+")) { newLeft--; return "diff-add"; }
      if (line.startsWith("-")) { oldLeft--; return "diff-remove"; }
      if (line.startsWith("\\")) return "diff-meta";
      oldLeft--;
      newLeft--;
      return "diff-context";
    }
    return /^(diff |index |--- |\+\+\+ |@@)/.test(line) ? "diff-meta" : line.startsWith("+") ? "diff-add"
      : line.startsWith("-") ? "diff-remove" : "diff-context";
  });
}

function Diff({ text }: { text: string }) {
  const lines = text.replace(/\n$/, "").split("\n");
  const kinds = diffKinds(lines);
  return (
    <div className="code-block diff-view">
      <div className="code-label">
        <span>diff</span>
        <CopyButton value={text} label="Copy diff" />
      </div>
      <pre tabIndex={0}>
        <code>
          {lines.map((line, index) => (
            <span className={`diff-line ${kinds[index]}`} key={index}>
              {line}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

function parsedJson(result: VisibleToolResult): unknown[] | undefined {
  if (result.json) return result.json;
  // Old records carry only the pretty-printed preview.
  if (!result.segments.length || !result.segments.every((segment) => segment.kind === "json")) return undefined;
  try {
    return [JSON.parse(textOf(result.segments))];
  } catch {
    return undefined;
  }
}

/**
 * The result body by type (docs/tool-ux-design.md §5.4). An error or a denial shows its message as text; a command that
 * exited nonzero, timed out or was cancelled keeps its terminal output.
 */
export function ResultBody({ result, hint }: { result: VisibleToolResult; hint?: ToolResultType | undefined }) {
  const type = result.resultType ?? hint;
  // Structured JSON is always a tree; the other segments (text, a capping notice, MCP markdown) get the body of the type.
  const json = parsedJson(result);
  const segments = json ? result.segments.filter((segment) => segment.kind !== "json") : result.segments;
  const text = textOf(segments);
  const failed = result.status ? !["ok", "exit"].includes(result.status) : result.failed;
  const refused = result.status ? ["error", "denied"].includes(result.status) : result.failed && result.exitCode === undefined;
  const body = (): ReactNode => {
    if (type === "terminal" && !refused) return <TerminalFrame label="Output" text={text} />;
    if (!failed && type === "diff" && (result.host?.diff || text)) return <Diff text={result.host?.diff ?? text} />;
    if (!segments.length) return null;
    if (!failed && type === "code" && segments.some((segment) => segment.kind === "code"))
      return (
        <CodeLines
          segments={segments}
          start={result.host?.range?.start ?? 1}
          path={result.host?.path ?? segments.find((segment) => segment.path)?.path}
        />
      );
    if (!failed && type === "markdown")
      return (
        <div className="tool-markdown">
          <Markdown>{text}</Markdown>
        </div>
      );
    return (
      <pre className="tool-text" tabIndex={0}>
        {text}
      </pre>
    );
  };
  if (!json) return body();
  const tree = <JsonTree values={json} />;
  // A JSON result reads tree first, its notice after; text that came with JSON reads before it.
  return type === "json" ? <>{tree}{body()}</> : <>{body()}{tree}</>;
}
