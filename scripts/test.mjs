import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { testRun } from "./test-tmp.mjs";

// `node scripts/test.mjs tests/a.test.ts …` runs only those files, with the same disposable temp directory.
const only = process.argv.slice(2);

const files = readdirSync(new URL("../tests/", import.meta.url))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `tests/${name}`);

const required = ["dashboard-assets", "dashboard-management", "dashboard-packages", "dashboard-installed", "dashboard-sessions", "dashboard-attachments", "dashboard-streams", "dashboard-approval", "dashboard-server", "dashboard-cli", "management-config", "management-components", "config", "prompt", "foundation-cli", "primitives", "registry", "overhead", "providers",
  "provider-content", "user-images", "request-controls", "dashboard-request-controls", "web-attachment-kinds", "web-request-choice", "web-context-usage", "context-anchor", "dashboard-session-title", "dashboard-workspaces", "web-workspace-state", "web-panel-state", "panels-protocol", "panels-host", "panels-declarations", "todo-tool", "dashboard-panels", "panels-actions", "panels-surfaces", "panels-compaction", "agent", "agent-lifecycle", "compact", "cache", "usage", "mcp", "mcp-content",
  "acp", "acp-client", "acp-transport", "cli", "repl", "package", "session-operations", "session-view", "session-store", "session-agent", "session-process", "session-cli", "session-api", "session-acp", "session-retention", "session-transition", "session-replay", "tool-plugins", "package-manifest", "component-references", "skill-frontmatter", "package-export", "package-archive", "package-store", "package-lifecycle", "package-config", "package-cli", "package-runtime", "package-sharing-installed"]
  .map((name) => `tests/${name}.test.ts`);
const missing = only.length ? only.filter((file) => !files.includes(file)) : required.filter((file) => !files.includes(file));

if (files.length === 0 || missing.length) {
  process.stderr.write(`Missing test files: ${missing.join(", ") || "all"}\n`);
  process.exitCode = 1;
} else {
  const run = testRun();
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...(only.length ? only : files)], {
    stdio: "inherit",
    env: { ...process.env, ...run.env },
  });
  run.cleanup();
  process.exitCode = result.status ?? 1;
}
