import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "raw-test-run-";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/** Removes run directories whose owner process is gone: a run killed before it could clean up. */
function sweep(root) {
  for (const name of readdirSync(root)) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = join(root, name);
    let pid;
    try { pid = Number(readFileSync(join(dir, "owner"), "utf8")); } catch { pid = NaN; }
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) continue;
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One disposable directory for a whole test run. Tests create temp files through `os.tmpdir()` and do not all remove
 * them, so the run points TMPDIR and the XDG homes inside this directory and removes it when the run ends, including
 * on Ctrl-C. A run killed outright leaves its directory behind; the next run removes it once its owner has exited.
 * `signals: false` leaves Ctrl-C to a runner that shuts down on its own and then calls `cleanup`.
 */
export function testRun({ signals = true } = {}) {
  const root = tmpdir();
  sweep(root);
  const dir = mkdtempSync(join(root, PREFIX));
  writeFileSync(join(dir, "owner"), String(process.pid));
  const env = { TMPDIR: join(dir, "tmp"), XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), XDG_DATA_HOME: join(dir, "data") };
  for (const path of Object.values(env)) mkdirSync(path);
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    rmSync(dir, { recursive: true, force: true });
  };
  process.on("exit", cleanup);
  if (signals) for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.once(signal, () => {
      cleanup();
      process.kill(process.pid, signal);
    });
  return { env, cleanup };
}
