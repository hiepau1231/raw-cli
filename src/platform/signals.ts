/**
 * The signals that end Raw like SIGTERM: SIGHUP when its terminal goes away (on Windows, when the console window is
 * closed) and, on Windows, SIGBREAK from Ctrl+Break. Windows never delivers SIGTERM.
 */
export function shutdownSignals(platform: NodeJS.Platform = process.platform): NodeJS.Signals[] {
  return platform === "win32" ? ["SIGTERM", "SIGHUP", "SIGBREAK"] : ["SIGTERM", "SIGHUP"];
}

type SignalTarget = { on(event: NodeJS.Signals, listener: () => void): unknown; off(event: NodeJS.Signals, listener: () => void): unknown };

/** Runs `handler` on every shutdown signal; the returned function removes it again. */
export function onShutdown(handler: () => void, target: SignalTarget = process, platform: NodeJS.Platform = process.platform): () => void {
  const signals = shutdownSignals(platform);
  for (const signal of signals) target.on(signal, handler);
  return () => { for (const signal of signals) target.off(signal, handler); };
}
