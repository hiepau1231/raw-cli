/** Shared steps of the bundled tools' argument normalizers (docs/tool-ux-design.md §4.3). */

/**
 * Moves `from` to `to` with a note. With the canonical name already present the alias stays, so dispatch drops it as
 * an unknown argument with a note the model can read.
 */
export function renameArgument(args: Record<string, unknown>, notes: string[], from: string, to: string,
  convert: (value: unknown) => unknown = (value) => value): void {
  if (!Object.hasOwn(args, from) || args[to] !== undefined) return;
  args[to] = convert(args[from]);
  delete args[from];
  notes.push(`read ${from} as ${to}`);
}

/** A digit string such as `"200"` as the number a model meant. */
export const integerArgument = (value: unknown): unknown => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;

export const PATH_ALIASES = ["file_path", "filePath", "absolute_path"] as const;

/** Bound of the ignored-argument note dispatch appends to a result; a tool that sizes its own output leaves this room. */
export const MODEL_NOTE_BYTES = 256;
