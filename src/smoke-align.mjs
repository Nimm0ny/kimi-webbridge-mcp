/**
 * Browser smoke with helpers that need full profile (e.g. wb_hover).
 * Run: npm run smoke:e2e
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedToolCount } from "./tool-profile.js";

process.env.WEBBRIDGE_TOOL_PROFILE = "full";

const root = dirname(fileURLToPath(import.meta.url));
const t = new StdioClientTransport({
  command: "node",
  args: [join(root, "index.js")],
  env: { ...process.env, WEBBRIDGE_TOOL_PROFILE: "full" },
});
const c = new Client({ name: "smoke-align", version: "1.0.0" });
await c.connect(t);

const tools = await c.listTools();
const names = tools.tools.map((x) => x.name).sort();
const expected = expectedToolCount();
console.log("profile full tool_count", names.length, "expected", expected);
console.log(names.join("\n"));
if (names.length !== expected) {
  console.error(`FAIL tool count: got ${names.length} expected ${expected}`);
  process.exitCode = 1;
}

const session = "mcp-align-test";

async function call(name, args = {}) {
  const r = await c.callTool({ name, arguments: { session, ...args } });
  const text = r.content?.find((x) => x.type === "text")?.text || JSON.stringify(r);
  const err = r.isError ? " [isError]" : "";
  console.log(`\n== ${name}${err} ==`);
  console.log(text.slice(0, 800));
  return { r, text };
}

await call("wb_status", {});
await call("wb_navigate", {
  url: "https://example.com",
  newTab: true,
  group_title: "对齐测试",
});
await call("wb_get_text", { maxChars: 500 });
await call("wb_find", { query: "learn", role: "link" });
await call("wb_wait", { text: "Example Domain", timeoutMs: 5000 });
await call("wb_scroll", { direction: "down", amount: 200 });
await call("wb_console", { cmd: "start" });
await call("wb_evaluate", {
  code: '(() => { console.log("wb-align-probe"); return "ok"; })()',
});
await call("wb_console", { cmd: "list" });
await call("wb_press_key", { key: "Escape" });
await call("wb_hover", { selector: "@e1" });
await call("wb_reload", { hard: false });

await c.close();
console.log("\nSMOKE DONE");
