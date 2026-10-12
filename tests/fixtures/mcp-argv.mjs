// A stdio MCP server whose one tool, `argv`, returns the arguments it was started with. With MCP_MARKER it starts a
// detached grandchild carrying that marker, which only a whole-tree stop ends; with MCP_IGNORE_EOF it keeps running
// after its stdin closes, so only a forced stop ends it.
import { spawn } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.env.MCP_MARKER) {
  spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)", process.env.MCP_MARKER], { detached: true, stdio: "ignore" }).unref();
}
if (process.env.MCP_IGNORE_EOF) setInterval(() => {}, 1000);
const server = new Server({ name: "raw-fixture-argv", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "argv", description: "The server's arguments",
  inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }));
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: JSON.stringify(process.argv.slice(2)) }] }));
await server.connect(new StdioServerTransport());
