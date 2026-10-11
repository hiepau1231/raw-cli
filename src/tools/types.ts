export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

export interface ToolContentText {
  type: "text";
  text: string;
  channel?: "stdout" | "stderr";
}

export interface ToolContentJson {
  type: "json";
  value: unknown;
}

export interface ToolContentImage {
  type: "image";
  mimeType: "image/png" | "image/jpeg";
  data: string;
  path?: string;
  byteSize?: number;
}

export type ToolContent = ToolContentText | ToolContentJson | ToolContentImage;

/**
 * A raw.panel/2 update returned by a tool handler (docs/panels-design.md §8.1). It is host-only data:
 * `ToolRegistry.dispatch` removes it before hooks, caps, providers and history, so it is not part of `ToolContent`.
 */
export interface ToolContentPanel {
  type: "panel";
  panel: string;
  op: "replace" | "patch" | "close";
  document?: unknown;
  patches?: unknown;
  base_revision?: unknown;
}

export type ToolHandlerContent = ToolContent | ToolContentPanel;

/** One changed file in host data (docs/tool-ux-design.md §4.5). */
export interface HostFileChange {
  path: string;
  action: "create" | "overwrite" | "edit" | "delete" | "rename";
  added?: number;
  removed?: number;
  destination?: string;
}

/**
 * Structured facts for the host (docs/tool-ux-design.md §4.5): persisted with the result in history and model context,
 * given to hooks as `tool.result.host`, never sent to a provider and never counted by the output cap.
 */
export interface HostData {
  summary?: string;
  status?: "ok" | "error" | "timeout" | "cancelled";
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  fullOutputPath?: string;
  fullOutputCapped?: boolean;
  page?: { cursor: number; next: number };
  files?: HostFileChange[];
  diff?: string;
  diffOmitted?: boolean;
  processId?: string;
  /** Normalization notes such as `read file_path as path`; host-only. */
  notes?: string[];
}

export interface ToolResult {
  isError: boolean;
  content: ToolContent[];
  truncated?: boolean;
  retainedBytes?: number;
  observedBytes?: number;
  code?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  /** Complete copy of output that was truncated before reaching the model, saved for later reading. */
  fullOutputPath?: string;
  fullOutputCapped?: boolean;
  host?: HostData;
}

/** What a handler (or an MCP/ACP conversion) may return: a ToolResult that can also carry panel blocks. */
export type ToolHandlerResult = Omit<ToolResult, "content"> & { content: ToolHandlerContent[] };
