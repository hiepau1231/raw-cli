import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The parts of the dashboard fixture the gate needs. */
type Raw = { configPath: string; config: { agents: Record<string, unknown> } };

/** What the UserPromptSubmit gate does on its next run: wait, deny, or let the message through. */
export type Gate = { sleepMs?: number; deny?: string };
const gateFolder = (raw: Raw) => join(dirname(raw.configPath), "hooks", "gate");
export function setGate(raw: Raw, gate: Gate) {
  writeFileSync(join(gateFolder(raw), "mode.json"), JSON.stringify(gate));
}
/** Installs the gate beside the config and selects it for the agent; it reads its mode on every run. */
export function installGate(raw: Raw, gate: Gate) {
  mkdirSync(gateFolder(raw), { recursive: true });
  writeFileSync(join(gateFolder(raw), "hook.json"), JSON.stringify({ protocol_version: 2, name: "gate", command: "node",
    args: ["./gate.mjs"], events: [{ name: "UserPromptSubmit" }] }));
  writeFileSync(join(gateFolder(raw), "gate.mjs"), `import { readFileSync } from "node:fs";
process.stdin.resume();
process.stdin.on("end", () => {
  const mode = JSON.parse(readFileSync(new URL("./mode.json", import.meta.url), "utf8"));
  setTimeout(() => process.stdout.write(JSON.stringify(mode.deny ? { decision: "deny", reason: mode.deny } : {})), mode.sleepMs ?? 0);
});
`);
  setGate(raw, gate);
  (raw.config.agents.raw as Record<string, unknown>).hooks = { use: ["agent/gate"] };
  writeFileSync(raw.configPath, JSON.stringify(raw.config));
}
