import { spawnSync } from "node:child_process";
import { systemBinary } from "../../src/platform/windows.js";

export interface MarkedProcess { pid: number; name: string; commandLine: string }

/**
 * Live Windows processes whose command line contains `marker`, from Win32_Process. The query's own PowerShell is
 * excluded; the marker reaches it through the environment, never its command line.
 */
export function processesWithMarker(marker: string): MarkedProcess[] {
  // -InputObject keeps a one-element array an array in Windows PowerShell 5.1, which has no -AsArray.
  const script = "$m = $env:RAW_TEST_MARKER; $found = @(Get-CimInstance Win32_Process | "
    + "Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($m) } | "
    + "ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name; commandLine = [string]$_.CommandLine } }); "
    + "ConvertTo-Json -Compress -InputObject $found";
  const powershell = systemBinary("WindowsPowerShell\\v1.0\\powershell.exe");
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", env: { ...process.env, RAW_TEST_MARKER: marker }, windowsHide: true });
  if (result.status !== 0) throw new Error(`Win32_Process query failed: ${result.stderr}`);
  const text = result.stdout.trim();
  return text ? JSON.parse(text) as MarkedProcess[] : [];
}

/** Polls until no process carries `marker`, for up to `timeoutMs`; returns the survivors. */
export async function waitForNoMarked(marker: string, timeoutMs = 3000): Promise<MarkedProcess[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = processesWithMarker(marker);
    if (!left.length || Date.now() >= deadline) return left;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
