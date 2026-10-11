import {
  Brain,
  FilePen,
  FileText,
  Globe,
  Image,
  ListTodo,
  MessageCircleQuestion,
  Plug,
  Puzzle,
  Search,
  Sparkles,
  SquareTerminal,
  Variable,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { ToolKind } from "../../../src/tools/display.js";

// Icon names a tool's display hint may use (docs/tools.md, Display hints), including the CLI's roles; an unknown
// name falls back to the kind.
const NAMED: Record<string, LucideIcon> = {
  read: FileText,
  write: FilePen,
  bash: SquareTerminal,
  generic: Wrench,
  terminal: SquareTerminal,
  file: FileText,
  edit: FilePen,
  search: Search,
  globe: Globe,
  web: Globe,
  brain: Brain,
  skill: Sparkles,
  todo: ListTodo,
  question: MessageCircleQuestion,
  image: Image,
  variable: Variable,
  plug: Plug,
  mcp: Plug,
  puzzle: Puzzle,
  tool: Wrench,
};
const KINDS: Record<ToolKind, [string, LucideIcon]> = {
  read: ["file", FileText],
  edit: ["edit", FilePen],
  execute: ["terminal", SquareTerminal],
  search: ["search", Search],
  fetch: ["globe", Globe],
  think: ["brain", Brain],
  other: ["tool", Wrench],
};

const isMcp = (identity?: string) =>
  identity !== undefined && (identity.startsWith("mcp/") || identity.includes("#mcp/"));

/** The hint's icon, then the MCP icon for MCP tools, then the kind's icon (the CLI's order, src/terminal/tools.ts). */
export function ToolIcon({
  icon,
  identity,
  kind,
}: {
  icon?: string | undefined;
  identity?: string | undefined;
  kind?: ToolKind | undefined;
}) {
  const [name, Icon] =
    icon && Object.hasOwn(NAMED, icon)
      ? [icon, NAMED[icon]!]
      : isMcp(identity)
        ? ["mcp", Plug]
        : (kind && Object.hasOwn(KINDS, kind) ? KINDS[kind] : KINDS.other);
  return (
    <span className="tool-icon" data-icon={name}>
      <Icon size={16} aria-hidden="true" />
    </span>
  );
}
