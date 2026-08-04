/**
 * Stress every wb_* tool against real browser (Edge extension + cookies).
 * Uses full profile so extras (hover/cdp/pdf/…) are registered.
 * Run: node src/stress-all.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expectedToolCount } from "./tool-profile.js";

// Force full surface for this harness (parent env for expectedToolCount too)
process.env.WEBBRIDGE_TOOL_PROFILE = "full";

const root = dirname(fileURLToPath(import.meta.url));
const SESSION = `stress-${Date.now().toString(36)}`;
const results = [];
const EXPECTED = expectedToolCount();

const t = new StdioClientTransport({
  command: "node",
  args: [join(root, "index.js")],
  env: { ...process.env, WEBBRIDGE_TOOL_PROFILE: "full" },
});
const c = new Client({ name: "stress-all", version: "1.0.0" });
await c.connect(t);

function parse(r) {
  const text = r.content?.find((x) => x.type === "text")?.text ?? "";
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* raw */
  }
  return { isError: Boolean(r.isError), text, json, hasImage: r.content?.some((x) => x.type === "image") };
}

async function call(name, args = {}, { allowError = false } = {}) {
  const started = Date.now();
  try {
    const r = await c.callTool({ name, arguments: { session: SESSION, ...args } });
    const p = parse(r);
    const ms = Date.now() - started;
    const ok = allowError ? true : !p.isError;
    const row = {
      tool: name,
      ok,
      isError: p.isError,
      ms,
      summary: summarize(name, p),
    };
    results.push(row);
    console.log(`${ok ? "PASS" : "FAIL"} ${name} (${ms}ms) ${row.summary}`);
    return p;
  } catch (err) {
    const ms = Date.now() - started;
    results.push({ tool: name, ok: false, isError: true, ms, summary: err.message });
    console.log(`FAIL ${name} (${ms}ms) ${err.message}`);
    return null;
  }
}

function summarize(name, p) {
  if (p.isError) return (p.text || "").slice(0, 160);
  const j = p.json;
  if (!j) return (p.text || "").slice(0, 80);
  if (name === "wb_status") return `ready=${j.ready} ver=${j.mcp_version} ext=${j.extension_connected}`;
  if (name === "wb_navigate") return j.data?.url || j.url || "ok";
  if (name === "wb_get_text") return `title=${j.title} len=${j.length}`;
  if (name === "wb_find") return `count=${j.count} first=${j.matches?.[0]?.ref}`;
  if (name === "wb_snapshot") return `title=${j.data?.title || j.title} url=${(j.data?.url || j.url || "").slice(0, 40)}`;
  if (name === "wb_screenshot") return `path=${j.data?.path || j.path} img=${p.hasImage}`;
  if (name === "wb_save_as_pdf") return `path=${j.data?.path || j.path}`;
  if (name === "wb_console" && j.messages) return `msgs=${j.count}`;
  if (name === "wb_network" && j.data) return JSON.stringify(j.data).slice(0, 80);
  if (name === "wb_list_tabs") return `tabs=${j.data?.tabs?.length ?? j.tabs?.length}`;
  if (name === "wb_hover") return `tag=${j.tag}`;
  if (name === "wb_press_key") return `mode=${j.mode} key=${j.key}`;
  if (name === "wb_evaluate") return String(j.data?.value ?? j.value ?? "ok").slice(0, 60);
  return "ok";
}

// Upload fixture
const uploadFile = join(tmpdir(), `wb-stress-upload-${Date.now()}.txt`);
writeFileSync(uploadFile, "kimi-webbridge stress upload payload\n", "utf8");

console.log("=== STRESS session=", SESSION, "===\n");

// 1 session + status
await call("wb_set_session", { session: SESSION });
// set_session doesn't take nested session from our wrapper - fix: call without SESSION merge for set_session
// Actually our call always adds session: SESSION which is fine for set_session if schema only has session field

await call("wb_status", {});

// 2 navigate github (real site, cookies apply in Edge profile)
await call("wb_navigate", {
  url: "https://github.com/",
  newTab: true,
  group_title: "MCP全工具压测",
});
await call("wb_wait", { text: "GitHub", timeoutMs: 15000 });
await call("wb_get_text", { maxChars: 800 });
await call("wb_snapshot", {});
const findR = await call("wb_find", { query: "Sign", role: "link", limit: 5 });
const signRef = findR?.json?.matches?.find((m) => m.ref)?.ref;

// 3 console + network
await call("wb_console", { cmd: "start" });
await call("wb_network", { cmd: "start" });
await call("wb_evaluate", {
  code: '(() => { console.log("stress-probe", location.hostname); return JSON.stringify({host:location.hostname,cookieLen:document.cookie.length}); })()',
});
await call("wb_console", { cmd: "list" });
await call("wb_network", { cmd: "list" });
await call("wb_console", { cmd: "clear" });
await call("wb_console", { cmd: "stop" });
await call("wb_network", { cmd: "stop" });

// 4 interact
await call("wb_scroll", { direction: "down", amount: 400 });
await call("wb_scroll", { y: -200 });
if (signRef) {
  await call("wb_hover", { selector: signRef });
} else {
  await call("wb_hover", { selector: "a" });
}
await call("wb_press_key", { key: "Escape" });
await call("wb_screenshot", { format: "png" });

// 5 form page for fill / fill_form / dblclick / upload
await call("wb_navigate", {
  url: "https://httpbin.org/forms/post",
  newTab: true,
});
await call("wb_wait", { selector: "input[name=custname]", timeoutMs: 15000 });
await call("wb_fill", { selector: "input[name=custname]", value: "StressUser" });
await call("wb_fill_form", {
  fields: [
    { selector: "input[name=custtel]", value: "123456" },
    { selector: "input[name=custemail]", value: "stress@example.com" },
  ],
});
await call("wb_find", { role: "textbox", limit: 10 });
// dblclick on textbox
await call("wb_dblclick", { selector: "input[name=custname]" });
// upload - httpbin form may not have file input; use a data page
await call("wb_navigate", {
  url: "data:text/html,<html><body><h1>Upload</h1><input type=file id=f><button id=b>Go</button></body></html>",
});
await call("wb_wait", { selector: "#f", timeoutMs: 5000 });
await call("wb_upload", { selector: "#f", files: [uploadFile] });
await call("wb_click", { selector: "#b" });
await call("wb_evaluate", {
  code: '(() => { const f=document.getElementById("f"); return JSON.stringify({files:f?.files?.length||0,name:f?.files?.[0]?.name||null}); })()',
});

// 6 cdp + pdf + navigation history
await call("wb_navigate", { url: "https://example.com/", newTab: true });
await call("wb_wait", { text: "Example Domain", timeoutMs: 10000 });
await call("wb_cdp", { method: "Runtime.evaluate", params: { expression: "1+1", returnByValue: true } });
await call("wb_save_as_pdf", { paper_format: "a4", scale: 0.8 });
await call("wb_screenshot", { format: "jpeg", quality: 60 });

// second page then back/forward/reload
await call("wb_navigate", { url: "https://example.org/" });
await call("wb_wait", { text: "Example", timeoutMs: 10000 });
await call("wb_go_back", {});
await call("wb_go_forward", {});
await call("wb_reload", { hard: false });

// 7 tabs
await call("wb_list_tabs", {});
await call("wb_find_tab", { url: "https://example.com/" });
// borrow active if any
await call("wb_find_tab", { active: true });

// 8 scroll with @e if available
const snap2 = await call("wb_snapshot", {});
// try find link on example.com
const find2 = await call("wb_find", { query: "More", role: "link", limit: 3 });
const ref2 = find2?.json?.matches?.[0]?.ref;
if (ref2) {
  await call("wb_scroll", { selector: ref2 });
  await call("wb_click", { selector: ref2 });
}

// 9 close one tab then close session
await call("wb_list_tabs", {});
await call("wb_close_tab", {});
const tabsBefore = await call("wb_list_tabs", {});
await call("wb_close_session", {});

// cleanup upload file
try {
  unlinkSync(uploadFile);
} catch {
  /* ignore */
}

await c.close();

const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
const toolsHit = new Set(results.map((r) => r.tool));
const ALL = [
  "wb_status",
  "wb_set_session",
  "wb_navigate",
  "wb_go_back",
  "wb_go_forward",
  "wb_reload",
  "wb_find_tab",
  "wb_list_tabs",
  "wb_close_tab",
  "wb_close_session",
  "wb_snapshot",
  "wb_get_text",
  "wb_find",
  "wb_wait",
  "wb_click",
  "wb_dblclick",
  "wb_hover",
  "wb_fill",
  "wb_fill_form",
  "wb_press_key",
  "wb_scroll",
  "wb_evaluate",
  "wb_cdp",
  "wb_screenshot",
  "wb_save_as_pdf",
  "wb_network",
  "wb_console",
  "wb_upload",
];
const missing = ALL.filter((t) => !toolsHit.has(t));

console.log("\n========== SUMMARY ==========");
console.log(`calls: ${results.length}  pass: ${pass}  fail: ${fail}`);
console.log(`unique tools: ${toolsHit.size}/${EXPECTED} (profile=full)`);
if (missing.length) console.log("MISSING:", missing.join(", "));
console.log("\nFailures:");
for (const r of results.filter((x) => !x.ok)) {
  console.log(` - ${r.tool}: ${r.summary}`);
}
console.log("\nPer-tool best ms:");
const byTool = {};
for (const r of results) {
  if (!byTool[r.tool]) byTool[r.tool] = { ok: r.ok, ms: r.ms, n: 1 };
  else {
    byTool[r.tool].n++;
    byTool[r.tool].ms = Math.max(byTool[r.tool].ms, r.ms);
    byTool[r.tool].ok = byTool[r.tool].ok && r.ok;
  }
}
for (const name of ALL) {
  const b = byTool[name];
  if (!b) console.log(`  ${name}: NOT RUN`);
  else console.log(`  ${b.ok ? "OK" : "NG"} ${name} x${b.n} max ${b.ms}ms`);
}

process.exit(fail > 0 || missing.length ? 1 : 0);
