import { highlightCode, languageForPath } from "./highlight.js";
import { wrapStyled } from "./layout.js";
import { icon, paint, type IconRole } from "./theme.js";
import type { TerminalCapabilities, UiOptions } from "./options.js";
import { statusLabel, type VisibleToolCall, type VisibleToolResult } from "../sessions/visible.js";
import { callSummary, callTitle, isMcpIdentity } from "../tools/display.js";
import { renderMarkdown } from "./markdown.js";
import { safeTerminalText } from "./safe.js";
import { reduceJson } from "../tools/results.js";

const ROLES = new Set<IconRole>(["read", "write", "bash", "skill", "mcp", "generic"]);

/** The hint's icon when the terminal has it, then MCP (config or package), then the kind (§5.4). */
function typeIcon(call: Pick<VisibleToolCall, "identity" | "icon" | "kind">): IconRole {
  if (call.icon && ROLES.has(call.icon as IconRole)) return call.icon as IconRole;
  if (isMcpIdentity(call.identity)) return "mcp";
  return call.kind === "read" ? "read" : call.kind === "edit" ? "write" : call.kind === "execute" ? "bash" : "generic";
}

/** `<icon> <title> <summary>`; an old record without a title or summary gets the generic ones from its arguments. */
export function formatToolStart(call: VisibleToolCall, ui: UiOptions, caps: TerminalCapabilities, width: number): string {
  const title = safeTerminalText(call.title ?? callTitle(call.name, call.arguments));
  const glyph = icon(typeIcon(call), ui, caps);
  const label = paint("accent", `${glyph} ${title}`, ui, caps)
    + (ui.density === "verbose" ? ` ${paint("muted", `(${safeTerminalText(call.identity ?? call.name)})`, ui, caps)}` : "");
  const summary = safeTerminalText(call.summary ?? callSummary(call.arguments));
  // `$ Run command  npm test`, not `$ Run command  $ npm test`: the icon already says it.
  const detail = summary.startsWith(`${glyph} `) ? summary.slice(glyph.length + 1) : summary;
  const prefix = call.started ? label : `${paint("warning", icon("attention", ui, caps), ui, caps)} ${label}`;
  const lines = wrapStyled(`${prefix}${detail ? `  ${paint("path", detail, ui, caps)}` : ""}`, width);
  // A call that never ran (rejected or interrupted) also prints its complete display arguments: nothing else shows them.
  if (!call.started) lines.push(...wrapStyled(`  ${paint("muted", safeTerminalText(JSON.stringify(call.arguments)), ui, caps)}`, width));
  return lines.join("\n") + "\n";
}

/** The pretty-printed lines of the largest value-safe reduction of a JSON value that fits in `budget` lines. */
function fittedJson(value: unknown, budget: number): string[] {
  for (const bytes of [1500, 800, 400, 200, 100, 48]) {
    const lines = JSON.stringify(reduceJson(value, bytes) ?? null, null, 2).split("\n");
    if (lines.length <= budget) return lines;
  }
  return [JSON.stringify(`… JSON value of ${Buffer.byteLength(JSON.stringify(value) ?? "")} bytes omitted`)];
}

/** `<status> · <duration>` with the changed-line counts of file edits, then the preview lines the density allows. */
export function formatToolResult(result: VisibleToolResult, ui: UiOptions, caps: TerminalCapabilities, width: number): string {
  const files = result.host?.files ?? [];
  const counted = files.length > 0 && files.every((file) => file.added !== undefined && file.removed !== undefined);
  const meta = [
    ...(counted ? [`+${files.reduce((sum, file) => sum + file.added!, 0)} −${files.reduce((sum, file) => sum + file.removed!, 0)}`] : []),
    ...(result.code && result.failed && result.code !== statusLabel(result) ? [result.code] : []),
    ...(result.truncated ? ["model output capped"] : []),
    ...(typeof result.durationMs === "number" ? [`${result.durationMs}ms`] : []),
  ];
  const header = paint(result.failed ? "error" : "success", `${icon(result.failed ? "failure" : "success", ui, caps)} ${statusLabel(result)}`, ui, caps)
    + (meta.length ? ` ${paint("muted", `· ${meta.map(safeTerminalText).join(" · ")}`, ui, caps)}` : "");
  const limit = result.failed || ui.density === "verbose" ? 9 : ui.density === "normal" ? 4 : 0;
  // JSON is printed whole from a reduction that fits its line budget, never cut by lines (§5.3); the rest is sliced.
  const values = result.json ?? [];
  const lines = values.length ? result.segments.filter((segment) => segment.kind !== "json") : result.segments;
  const shown = lines.slice(0, limit);
  const body: string[] = [];
  for (let index = 0; index < shown.length; index++) {
    const segment = shown[index]!;
    if (segment.kind === "markdown") {
      // Consecutive markdown lines render together so lists and fences keep their structure.
      const group = [segment.text];
      while (shown[index + 1]?.kind === "markdown") group.push(shown[++index]!.text);
      const rendered = renderMarkdown(safeTerminalText(group.join("\n")), ui, caps, Math.max(8, width - 2));
      body.push(...rendered.replace(/\n+$/, "").split("\n").map((line) => `  ${line}`));
      continue;
    }
    const safe = safeTerminalText(segment.text);
    const content = segment.kind === "code" ? highlightCode(safe, segment.language ?? (segment.path ? languageForPath(segment.path) : undefined), ui, caps)
      : segment.kind === "json" ? paint("muted", safe, ui, caps) : safe;
    body.push(wrapStyled(`  ${content}`, width).join("\n"));
  }
  if (lines.length > limit && limit > 0) body.push(paint("muted", `  … ${lines.length - limit} preview lines hidden`, ui, caps));
  // One JSON line budget for the whole result; values past it are omitted whole. JSON lines are never hard-wrapped, which
  // would put newlines inside strings: the terminal folds them visually and the printed text stays valid JSON.
  let budget = limit * 3;
  for (const [index, value] of (limit > 0 ? values : []).entries()) {
    const lines = budget > 0 ? fittedJson(value, budget) : [];
    if (!lines.length) {
      body.push(paint("muted", `  … ${values.length - index} more JSON value${values.length - index === 1 ? "" : "s"} omitted`, ui, caps));
      break;
    }
    budget -= lines.length;
    for (const line of lines) body.push(`  ${paint("muted", safeTerminalText(line), ui, caps)}`);
  }
  return [header, ...body].join("\n") + "\n";
}
