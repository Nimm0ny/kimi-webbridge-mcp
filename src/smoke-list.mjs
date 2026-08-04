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
  env: { ...process.env },
});
const c = new Client({ name: "smoke-list", version: "1.0.0" });
await c.connect(t);
const tools = await c.listTools();
const names = tools.tools.map((x) => x.name).sort();
const profile = String(process.env.WEBBRIDGE_TOOL_PROFILE || "compact").toLowerCase();
const expected = profile === "full" || profile === "all" ? 28 : 20;
console.log("package", pkg.version);
console.log("profile", profile);
console.log("tool_count", names.length, "expected", expected);
console.log(names.join("\n"));
if (names.length !== expected) {
  console.error(`FAIL: expected ${expected} tools, got ${names.length}`);
  process.exitCode = 1;
} else {
  console.log("SMOKE LIST OK");
}
await c.close();
