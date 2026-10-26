import { existsSync } from "node:fs";
import { join } from "node:path";

const MAX_CONTINUATIONS = 3;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  // Only a finished answer can be continued; say nothing and the run ends as usual.
  if (request.run?.status !== "completed") return;
  if (existsSync(join(request.cwd, "DONE")) || request.stop.continuations >= MAX_CONTINUATIONS) return;
  process.stdout.write(JSON.stringify({ decision: "deny",
    reason: "Keep going until a file named DONE exists in the working directory, then say so." }));
});
