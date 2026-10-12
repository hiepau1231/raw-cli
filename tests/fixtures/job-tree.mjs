// A process tree for the job launcher tests. The marker reaches every process through RAW_JOB_MARKER and appears only
// on the command line of the long-lived process the tests look for.
//   leader: starts the marked process and exits when its stdin closes.
//   orphan: starts an intermediate process that starts the marked process and exits at once; reports
//           "middle-exited" on stdout and keeps running.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const marked = () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)", process.env.RAW_JOB_MARKER ?? "unmarked"],
  { detached: true, stdio: "ignore" }).unref();
const mode = process.argv[2];
if (mode === "intermediate") marked();
else if (mode === "orphan") {
  const middle = spawn(process.execPath, [fileURLToPath(import.meta.url), "intermediate"], { stdio: "ignore" });
  middle.on("exit", () => process.stdout.write("middle-exited\n"));
  setInterval(() => {}, 1000);
} else if (mode === "leader") {
  marked();
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
} else throw new Error(`unknown mode: ${mode}`);
