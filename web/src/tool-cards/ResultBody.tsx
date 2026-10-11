import type { ReactNode } from "react";
import type { PreviewSegment, VisibleToolResult } from "../../../src/sessions/visible.js";
import type { ToolResultType } from "../../../src/tools/display.js";
import { highlightLine, Markdown } from "../markdown.js";
import { CopyButton } from "../ui.js";
import { JsonTree } from "./JsonTree.js";
import { parseTerminalPreview, type TerminalLine } from "./terminal.js";
import { bodyKind, diffKinds, parsedJson, textOf } from "./result-data.js";

const HIDDEN = /^… \[(\d+) lines hidden\] …$/;

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
function CodeLines({ segments, start, path, label = true }: {
  segments: PreviewSegment[]; start: number; path?: string | undefined; /** Off in a tool card, whose footer has the path and Copy. */ label?: boolean;
}) {
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
      {label && (
        <div className="code-label">
          <span>{path ?? language}</span>
          <CopyButton
            value={textOf(segments.filter((segment) => segment.kind === "code"))}
            label="Copy code"
          />
        </div>
      )}
      <pre tabIndex={0}>
        <code>{rows}</code>
      </pre>
    </div>
  );
}


/** A unified diff; in a tool card the card's footer carries the path and Copy diff, so `label` is off there. */
export function Diff({ text, label = true }: { text: string; label?: boolean }) {
  const lines = text.replace(/\n$/, "").split("\n");
  const kinds = diffKinds(lines);
  return (
    <div className="code-block diff-view">
      {label && (
        <div className="code-label">
          <span>diff</span>
          <CopyButton value={text} label="Copy diff" />
        </div>
      )}
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


/** A command's preview in a tool card: markers removed, stderr lines in the error colour (docs/chat-design.md §6). */
export function TerminalLines({ lines }: { lines: TerminalLine[] }) {
  return (
    <pre className="tool-terminal" tabIndex={0}>
      <code>
        {lines.map((line, index) => (
          <span className={`term-line${line.notice ? " notice" : ""}`} data-channel={line.channel} key={index}>
            {line.text}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}

/**
 * The result body by type (docs/tool-ux-design.md §5.4). An error or a denial shows its message as text; a command that
 * exited nonzero, timed out or was cancelled keeps its terminal output.
 */
export function ResultBody({ result, hint, card = false }: {
  result: VisibleToolResult; hint?: ToolResultType | undefined; /** Inside a chat tool card, whose footer has Copy. */ card?: boolean;
}) {
  const type = result.resultType ?? hint;
  // Structured JSON is always a tree; the other segments (text, a capping notice, MCP markdown) get the body of the type.
  const json = parsedJson(result);
  const segments = json ? result.segments.filter((segment) => segment.kind !== "json") : result.segments;
  const text = textOf(segments);
  const failed = result.status ? !["ok", "exit"].includes(result.status) : result.failed;
  const kind = bodyKind(result, hint);
  const body = (): ReactNode => {
    if (kind === "terminal")
      return card ? <TerminalLines lines={parseTerminalPreview(text).lines} /> : <TerminalFrame label="Output" text={text} />;
    if (kind === "diff") return <Diff text={result.host?.diff ?? text} label={!card} />;
    if (!segments.length) return null;
    if (!failed && type === "code" && segments.some((segment) => segment.kind === "code"))
      return (
        <CodeLines
          segments={segments}
          start={result.host?.range?.start ?? 1}
          path={result.host?.path ?? segments.find((segment) => segment.path)?.path}
          label={!card}
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
