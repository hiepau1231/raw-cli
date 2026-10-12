import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    remove(dir);
  }
}

/** Windows may still hold a file a just-exited child had open; retry briefly and never fail the run over it. */
function remove(dir) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (error) { process.stderr.write(`test-tmp: could not remove ${dir}: ${error.message}\n`); }
}

/**
 * One disposable directory for a whole test run. Tests create temp files through `os.tmpdir()` and do not all remove
 * them, so the run points TMPDIR (TEMP and TMP on Windows, where Node reads those) and the XDG homes inside this
 * directory and removes it when the run ends, including
 * on Ctrl-C. A run killed outright leaves its directory behind; the next run removes it once its owner has exited.
 * `signals: false` leaves Ctrl-C to a runner that shuts down on its own and then calls `cleanup`.
 */
export function testRun({ signals = true, platform = process.platform } = {}) {
  // The long form: Windows runners report a short 8.3 TEMP (RUNNER~1) that canonical paths would not match.
  const root = realpathSync.native(tmpdir());
  sweep(root);
  const dir = mkdtempSync(join(root, PREFIX));
  writeFileSync(join(dir, "owner"), String(process.pid));
  const temp = join(dir, "tmp");
  const env = { TMPDIR: temp, ...(platform === "win32" ? { TEMP: temp, TMP: temp } : {}),
    XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), XDG_DATA_HOME: join(dir, "data") };
  for (const path of new Set(Object.values(env))) mkdirSync(path);
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    remove(dir);
  };
  process.on("exit", cleanup);
  if (signals) for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.once(signal, () => {
      cleanup();
      process.kill(process.pid, signal);
    });
  return { env, cleanup };
}
