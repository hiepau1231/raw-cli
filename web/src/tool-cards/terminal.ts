export interface TerminalLine {
  text: string;
  /** Known only after a `[stdout]`/`[stderr]` marker; unknown before one and after a hidden-lines notice. */
  channel?: "stdout" | "stderr";
  /** A hidden-lines notice or a status note (timed out, aborted, clamped timeout), not output. */
  notice?: true;
}
export interface TerminalPreview {
  lines: TerminalLine[];
  exit?: { code: number; seconds: number };
}

const MARKER = /^\[(stdout|stderr)\]$/;
const HIDDEN = /^… \[\d+ lines hidden\] …$/;
const EXIT = /^\[exit (-?\d+) · (\d+(?:\.\d+)?)s\]$/;
// The status lines bashTool ends a preview with (src/tools/primitives.ts), and the notes it may add after them.
const STATUS = /^\[(?:timed out after |aborted after |killed by )[^\]]*\]$/;
const NOTE = /^\[(?:timeout clamped to |ignored run_in_background: )[^\]]*\]$/;

/**
 * A command's saved preview as lines (docs/chat-design.md §6): channel markers are removed and colour the lines after
 * them, the exit line becomes `exit`, and the other status lines stay as notices. Only lines in the preview's trailing
 * status run count as status, so output that prints the same text keeps it.
 */
export function parseTerminalPreview(text: string): TerminalPreview {
  const raw = text.split("\n");
  // The trailing status run: notes, after the exit or status line they follow.
  let start = raw.length;
  while (start > 0 && NOTE.test(raw[start - 1]!)) start--;
  const status = raw[start - 1];
  const match = status === undefined ? null : EXIT.exec(status);
  if (match || (status !== undefined && STATUS.test(status))) start--;
  const lines: TerminalLine[] = [];
  let channel: TerminalLine["channel"];
  for (const line of raw.slice(0, start)) {
    const marker = MARKER.exec(line);
    if (marker) channel = marker[1] as TerminalLine["channel"];
    else if (HIDDEN.test(line)) {
      channel = undefined;
      lines.push({ text: line, notice: true });
    } else lines.push(channel ? { text: line, channel } : { text: line });
  }
  for (const line of raw.slice(match ? start + 1 : start)) lines.push({ text: line, notice: true });
  return match ? { lines, exit: { code: Number(match[1]), seconds: Number(match[2]) } } : { lines };
}
