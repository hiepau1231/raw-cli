import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getEncoding } from "js-tiktoken";
import { DEFAULT_SYSTEM_PROMPT } from "../src/llm/prompt.js";
import { BUILTIN_TOOL_DEFINITIONS } from "../src/tools/registry.js";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

/** The PowerShell definition that takes bash's place in the starter on Windows without Git Bash. */
function powershellDefinition() {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../src/tools/bundled/powershell/tool.json", import.meta.url)), "utf8"));
  return { name: manifest.name, description: manifest.description, inputSchema: manifest.input_schema };
}

export function countOverhead() {
  const encoder = getEncoding("o200k_base");
  const definitions = BUILTIN_TOOL_DEFINITIONS;
  const canonical = JSON.stringify(canonicalize({ system: DEFAULT_SYSTEM_PROMPT, tools: definitions }));
  const tokens = (definition) => encoder.encode(JSON.stringify(canonicalize(definition))).length;
  return {
    promptTokens: encoder.encode(DEFAULT_SYSTEM_PROMPT).length,
    combinedTokens: encoder.encode(canonical).length,
    definitionTokens: Object.fromEntries([...definitions, powershellDefinition()].map((definition) => [definition.name, tokens(definition)])),
    definitions,
    canonical,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = countOverhead();
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (report.promptTokens > 50 || report.definitions.length !== 3) process.exitCode = 1;
}
