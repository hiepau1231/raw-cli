import { ToolRegistry, type ToolPolicyRule, type ToolRegistration } from "../../src/tools/registry.js";
import readManifest from "../../src/tools/bundled/read_file/tool.json" with { type: "json" };
import writeManifest from "../../src/tools/bundled/write_file/tool.json" with { type: "json" };
import bashManifest from "../../src/tools/bundled/bash/tool.json" with { type: "json" };
import imageManifest from "../../src/tools/bundled/view_image/tool.json" with { type: "json" };
import * as readModule from "../../src/tools/bundled/read_file/index.js";
import * as writeModule from "../../src/tools/bundled/write_file/index.js";
import * as imageModule from "../../src/tools/bundled/view_image/index.js";
import * as bashModule from "../../src/tools/bundled/bash/index.js";

export { ToolRegistry, BUILTIN_TOOL_DEFINITIONS } from "../../src/tools/registry.js";

export function createTestToolRegistry(rules: readonly ToolPolicyRule[] = [], vision = false): ToolRegistry {
  const registry = new ToolRegistry(rules);
  const entries: Array<[{ name: string; id: string; description: string; input_schema: unknown; display?: unknown }, Pick<ToolRegistration, "handler" | "validateArgs" | "normalizeArguments">
    & { example?: Record<string, unknown>; renamedArguments?: Record<string, string> }]> =
    [[readManifest, readModule], [writeManifest, writeModule], [bashManifest, bashModule]];
  if (vision) entries.push([imageManifest, imageModule]);
  // Each bundled tool normalizes the way the production loader forwards it; bash delegation needs the process tool.
  for (const [manifest, module] of entries) registry.register({
    name: manifest.name, canonicalName: `builtin/${manifest.id}`,
    description: manifest.description, inputSchema: manifest.input_schema as ToolRegistration["inputSchema"],
    ...(manifest.display ? { display: manifest.display as NonNullable<ToolRegistration["display"]> } : {}),
    ...(manifest.id === "write_file" ? { conditionSources: ["effects"], effectsSchema: writeManifest.effects_schema,
      describeEffects: writeModule.describeEffects } : { conditionSources: ["arguments"] }),
    ...(module.normalizeArguments ? { normalizeArguments: module.normalizeArguments } : {}),
    ...(module.example ? { example: module.example } : {}),
    ...(module.renamedArguments ? { renamedArguments: module.renamedArguments } : {}),
    handler: module.handler, validateArgs: module.validateArgs!,
  });
  return registry;
}
