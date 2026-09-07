import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { expectedToolCount } from "./tool-profile.js";

process.env.WEBBRIDGE_TOOL_PROFILE = "full";
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(readFileSync(new URL("../fixtures/actions.html", import.meta.url)));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const transport = new StdioClientTransport({ command: "node", args: [fileURLToPath(new URL("index.js", import.meta.url))], env: { ...process.env, WEBBRIDGE_TOOL_PROFILE: "full" } });
const client = new Client({ name: "smoke-align", version: "1.3.0" });
const session = `wb-regression-${randomUUID()}`;
let created = false;
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: { ...args, session } }, undefined, { timeout: 90000 });
  const text = result.content?.find(c => c.type === "text")?.text || "null";
  console.log(name, result.isError ? "FAIL" : "OK", text.slice(0, 300));
  if (result.isError && name !== "wb_evaluate" && name !== "wb_close_session") {
    await call("wb_evaluate", { code: 'JSON.stringify({events:window.testEvents,checked:document.querySelector("#agree")?.checked,viewport:{w:innerWidth,h:innerHeight,dpr:devicePixelRatio},rect:document.querySelector("#agree")?.getBoundingClientRect()})' });
  }
  assert.ok(!result.isError, `${name}: ${text}`);
  return { result, value: JSON.parse(text) };
}
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, expectedToolCount());
  await call("wb_status");
  created = true; // cleanup this unique test session even after an uncertain navigation.
  await call("wb_navigate", { url: `http://127.0.0.1:${server.address().port}/`, newTab: true, group_title: "MCP 回归测试" });
  await call("wb_wait", { selector: "#name", timeoutMs: 10000 });
  await call("wb_snapshot");
  await call("wb_fill", { target: { role: "textbox", name: "姓名" }, value: "中文 smoke" });
  await call("wb_check", { selector: "#agree", checked: true });
  await call("wb_select", { selector: "#choice", values: ["b"] });
  await call("wb_hover", { selector: "#hover" });
  await call("wb_dblclick", { selector: "#double", inputMode: "dom", expect: { text: "double:false" } });
  await call("wb_click", { target: { role: "button", name: "保存", within: "#main" }, followNewTab: false, expect: { text: "saved:中文 smoke" } });
  const shot = await call("wb_screenshot", { format: "jpeg", timeoutMs: 15000 });
  assert.ok(shot.result.content.some(c => c.type === "image"), "Screenshot must return an image block");
  console.log("SMOKE E2E PASS");
} finally {
  try { if (created) await call("wb_close_session"); }
  finally { await client.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
