/** The number of lines in the text: a final newline ends the last line rather than starting another. */
export function lineCount(text: string): number {
  if (text === "") return 0;
  const lines = text.split(/\r\n|\r|\n/);
  return text.endsWith("\n") || text.endsWith("\r") ? lines.length - 1 : lines.length;
}

/** B, KB or MB with at most one decimal, so the chip stays short. */
export function formatBytes(bytes: number): string {
  const unit = (value: number, name: string) => `${Number(value.toFixed(1))} ${name}`;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return unit(bytes / 1024, "KB");
  return unit(bytes / (1024 * 1024), "MB");
}
