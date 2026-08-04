/** List-only smoke: no browser navigation. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const root = dirname(fileURLToPath(import.meta.url));

const t = new StdioClientTransport({
  command: "node",
  args: [join(root, "index.js")],
});
const c = new Client({ name: "smoke-list", version: "1.0.0" });
await c.connect(t);
const tools = await c.listTools();
const names = tools.tools.map((x) => x.name).sort();
console.log("package", pkg.version);
console.log("tool_count", names.length);
console.log(names.join("\n"));
if (names.length !== 28) {
  console.error(`FAIL: expected 28 tools, got ${names.length}`);
  process.exitCode = 1;
} else {
  console.log("SMOKE LIST OK");
}
await c.close();
