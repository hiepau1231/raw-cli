import { parseFilePatch } from "./file-patch.js";

/** How a tool is shown on every surface (docs/tool-ux-design.md §5.1). All fields are optional. */
export type ToolKind = "read" | "edit" | "execute" | "search" | "fetch" | "think" | "other";
export type ToolResultType = "text" | "markdown" | "code" | "json" | "terminal" | "diff";
export interface ToolDisplay {
  /** Human title; a template like the summary. Default: the tool name in sentence case. */
  title?: string;
  kind?: ToolKind;
  /** A dashboard icon name; default by kind. */
  icon?: string;
  /** Template over the normalized arguments, e.g. `$ {command}`; default: §5.2. */
  summary?: string;
  result?: ToolResultType;
}

export const TOOL_KINDS: readonly ToolKind[] = ["read", "edit", "execute", "search", "fetch", "think", "other"];
export const RESULT_TYPES: readonly ToolResultType[] = ["text", "markdown", "code", "json", "terminal", "diff"];
const DISPLAY_KEYS = ["title", "kind", "icon", "summary", "result"];
export const SUMMARY_CHARS = 120;
const MASK = "•••";
const SECRET = /token|secret|password|key/i;
const FIRST = ["command", "path", "url", "query", "pattern", "name", "id", "title"];

/** Validates `display` from a tool.json or an MCP config override; throws with the offending field. */
export function parseDisplay(value: unknown, where: string): ToolDisplay {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where}: display must be an object`);
  const item = value as Record<string, unknown>;
  const unknown = Object.keys(item).find((key) => !DISPLAY_KEYS.includes(key));
  if (unknown) throw new Error(`${where}: unknown display field ${unknown}`);
  const text = (key: string, max: number) => {
    const field = item[key];
    if (field !== undefined && (typeof field !== "string" || !field.trim() || [...field].length > max)) throw new Error(`${where}: display.${key} must be text of at most ${max} characters`);
  };
  text("title", 80); text("summary", 200);
  if (item.icon !== undefined && (typeof item.icon !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(item.icon))) throw new Error(`${where}: display.icon must be an icon name`);
  if (item.kind !== undefined && !TOOL_KINDS.includes(item.kind as ToolKind)) throw new Error(`${where}: display.kind must be one of ${TOOL_KINDS.join(", ")}`);
  if (item.result !== undefined && !RESULT_TYPES.includes(item.result as ToolResultType)) throw new Error(`${where}: display.result must be one of ${RESULT_TYPES.join(", ")}`);
  return { ...item } as ToolDisplay;
}

/** An MCP tool's hints from its annotations, then the config override field by field (§5.1). */
export function mcpDisplay(annotations: unknown, override?: ToolDisplay): ToolDisplay {
  const notes = annotations && typeof annotations === "object" ? annotations as Record<string, unknown> : {};
  const title = typeof notes.title === "string" && notes.title.trim() ? [...notes.title.trim()].slice(0, 80).join("") : undefined;
  const kind: ToolKind = notes.readOnlyHint === true ? "read" : notes.openWorldHint === true ? "fetch" : "other";
  return { ...(title ? { title } : {}), kind, ...override };
}

/** Whether an identity names an MCP tool, from config (`mcp/…`) or a package (`<package>#mcp/…`). */
export const isMcpIdentity = (identity: string | undefined) => identity !== undefined && (identity.startsWith("mcp/") || identity.includes("#mcp/"));

const bytes = (value: unknown) => typeof value === "string" ? Buffer.byteLength(value, "utf8") : undefined;
const pick = (args: Record<string, unknown>, names: readonly string[]) => names.map((name) => args[name]).find((value) => typeof value === "string") as string | undefined;
const PATH_NAMES = ["path", "file_path", "filePath", "absolute_path"];

/**
 * The arguments a surface may show. File contents never enter a display record: the bundled editing tools show paths
 * and sizes, and any other shape of theirs (an old batch, a typo) only its keys. Arguments may still carry aliases.
 */
export function displayArguments(identity: string | undefined, args: Record<string, unknown>): Record<string, unknown> {
  const path = pick(args, PATH_NAMES);
  if (identity === "builtin/write_file") {
    const content = pick(args, ["content", "file_text", "text", "contents"]);
    if (content !== undefined) return { path, content_bytes: bytes(content) };
  } else if (identity === "builtin/edit_file") {
    const oldString = pick(args, ["old_string", "old_str", "oldString", "old_text"]);
    const newString = pick(args, ["new_string", "new_str", "newString", "new_text"]);
    const all = [args.replace_all, args.replaceAll, args.allow_multiple].find((value) => typeof value === "boolean");
    if (oldString !== undefined || newString !== undefined) {
      return { path, old_string_bytes: bytes(oldString), new_string_bytes: bytes(newString), ...(all !== undefined ? { replace_all: all } : {}) };
    }
  } else if (identity === "builtin/apply_patch") {
    const patch = pick(args, ["patch", "input"]);
    if (patch !== undefined) {
      let paths: string[] = [];
      try { paths = parseFilePatch(patch, "/").changes.map((change) => change.rawDestination ? `${change.rawPath} → ${change.rawDestination}` : change.rawPath); } catch { /* an invalid patch still gets a content-free summary */ }
      return { patch_bytes: Buffer.byteLength(patch), patch_paths: paths };
    }
  } else return structuredClone(args);
  return { argument_keys: Object.keys(args) };
}

/** A copy of a value with every property whose name looks like a secret replaced by the mask, at any depth. */
function masked(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(masked);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET.test(key) ? MASK : masked(item)]));
}

const oneLine = (text: string) => text.replace(/\s*\r?\n\s*/g, " ⏎ ").replace(/[\r\n]/g, " ");

/** One display value: secrets masked at any depth, lists joined, objects as compact JSON, everything on one line. */
function shown(key: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (SECRET.test(key)) return MASK;
  const text = typeof value === "string" ? value : Array.isArray(value) && value.every((item) => typeof item !== "object" || item === null)
    ? value.join(" · ") : typeof value === "object" ? JSON.stringify(masked(value)) : String(value);
  return oneLine(text);
}

const PLACEHOLDER = /\{([A-Za-z0-9_.-]+)(?:\|([^}]*))?\}/g;

/**
 * A template over the arguments: `{name}` is the value, `{name|text}` falls back to the text, and a `[…]` part is shown
 * only when every placeholder inside it has a value. Returns undefined when a required placeholder has none. The
 * template is read once: substituted argument text is never read as template syntax.
 */
export function renderTemplate(template: string, args: Record<string, unknown>): string | undefined {
  // Fills one part of the template; `missing` reports a placeholder with neither a value nor a fallback.
  const fill = (part: string): { text: string; missing: boolean } => {
    let missing = false;
    const text = part.replace(PLACEHOLDER, (_match, name: string, fallback?: string) => {
      const value = shown(name, args[name]);
      if (value !== undefined) return value;
      if (fallback !== undefined) return fallback;
      missing = true;
      return "";
    });
    return { text, missing };
  };
  let result = "";
  let missing = false;
  let cursor = 0;
  for (const match of template.matchAll(/\[([^\]]*)\]/g)) {
    const before = fill(template.slice(cursor, match.index));
    const optional = fill(match[1]!);
    result += before.text + (optional.missing ? "" : optional.text);
    missing ||= before.missing;
    cursor = match.index + match[0].length;
  }
  const rest = fill(template.slice(cursor));
  return missing || rest.missing ? undefined : oneLine(result + rest.text);
}

const cut = (text: string, chars: number) => [...text].length <= chars ? text : `${[...text].slice(0, chars - 1).join("")}…`;

/**
 * The one-line call summary (§5.2): the display template, or the first present value among command, path, url, query,
 * pattern, name, id and title (else the first string argument), then up to two short `key=value` pairs. Cut to 120.
 */
export function callSummary(args: Record<string, unknown>, display?: ToolDisplay): string {
  if (display?.summary !== undefined) {
    const rendered = renderTemplate(display.summary, args);
    if (rendered !== undefined) return cut(rendered.trim(), SUMMARY_CHARS);
  }
  const lead = FIRST.find((key) => shown(key, args[key]) !== undefined && typeof args[key] !== "object")
    ?? Object.keys(args).find((key) => typeof args[key] === "string" && args[key] !== "");
  const pairs = Object.entries(args).filter(([key, value]) => key !== lead && value !== null && value !== undefined && value !== ""
    && ["string", "number", "boolean"].includes(typeof value) && [...String(value)].length <= 40).slice(0, 2)
    .map(([key, value]) => `${key}=${shown(key, value)}`);
  return cut([lead === undefined ? undefined : shown(lead, args[lead]), ...pairs].filter(Boolean).join(" · "), SUMMARY_CHARS);
}

/** The title of a call: the display title (a template) or the tool name in sentence case. */
export function callTitle(name: string, args: Record<string, unknown>, display?: ToolDisplay): string {
  const rendered = display?.title === undefined ? undefined : renderTemplate(display.title, args);
  if (rendered?.trim()) return cut(rendered.trim(), 80);
  const words = name.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}
