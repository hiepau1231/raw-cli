import type { PanelDeclaration } from "../../panels/contract.js";
import type { ToolDisplay } from "../display.js";
import type { ToolRegistration } from "../registry.js";
import type { ConditionSource } from "../policy.js";

export interface ToolManifest {
  api_version: 2;
  id: string;
  version: string;
  name: string;
  description: string;
  input_schema: ToolRegistration["inputSchema"];
  entry: "./index.mjs";
  condition_sources?: ConditionSource[];
  effects_schema?: Readonly<Record<string, unknown>>;
  panels?: PanelDeclaration[];
  /** How surfaces show the tool (docs/tool-ux-design.md §5.1). */
  display?: ToolDisplay;
}

export interface ToolPlugin {
  id: string;
  version: string;
  sourceDigest: string;
  registration: ToolRegistration;
}
