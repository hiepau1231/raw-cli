import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// The Windows job launcher's C# source; Raw compiles it on first use on Windows (src/platform/windows.ts).
mkdirSync(join("dist", "platform"), { recursive: true });
copyFileSync(join("src", "platform", "job-launcher.cs"), join("dist", "platform", "job-launcher.cs"));
