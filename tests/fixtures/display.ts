import { readFileSync } from "node:fs";
import { parseDisplay, type ToolDisplay } from "../../src/tools/display.js";

/** The display hints a bundled tool declares in its tool.json, read from the source tree. */
export function bundledDisplay(id: string): ToolDisplay {
  const manifest = JSON.parse(readFileSync(new URL(`../../src/tools/bundled/${id}/tool.json`, import.meta.url), "utf8")) as { display: unknown };
  return parseDisplay(manifest.display, id);
}
