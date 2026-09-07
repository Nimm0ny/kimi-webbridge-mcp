#!/usr/bin/env node
/**
 * kimi-webbridge-mcp
 *
 * MCP adapter over Kimi WebBridge daemon (http://127.0.0.1:10086).
 * Core tools map 1:1 to daemon actions; convenience tools align with Claude-in-Chrome UX.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { packageVersion, WebBridgeClient } from "./client.js";
import { savePdfSmart, screenshotSmart } from "./capture.js";
import { formatToolError } from "./errors.js";
import { formatResult } from "./format.js";
import {
  clickSmart,
  consoleCmd,
  fillForm,
  getPageText,
  goBack,
  goForward,
  pressKey,
  reload,
  scroll,
  searchSnapshot,
  unwrap,
  waitFor,
} from "./page-actions.js";
import { findTabSmart } from "./tab-actions.js";
import { ToolError } from "./errors.js";
import { isToolEnabled, profileInfo } from "./tool-profile.js";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { interact, snapshotWithTargets, drag } from "./targets.js";
import { OperationQueue } from "./operation-queue.js";

const VERSION = packageVersion();
const client = new WebBridgeClient();
const profile = profileInfo();
const operations = new OperationQueue();

const server = new McpServer(
  {
    name: "kimi-webbridge",
    version: VERSION,
  },
  {
    instructions: [
      "Kimi WebBridge: REAL browser (logins/cookies) via daemon + extension. Compact tool set (Claude-in-Chrome sized).",
      "Workflow: wb_status → wb_navigate → wb_snapshot|wb_find → wb_click|wb_fill (@e refs). Prefer few tools, not tool spam.",
      "Actions use strict targets. Auto pointer input uses CDP on visible tabs and DOM on hidden tabs; returned mode is authoritative. Snapshot refs bind observed nodes; stale/ambiguous refs fail.",
      "wb_click only follows a unique new session tab with a verified opener relationship. Inspect candidates otherwise. outcome=dispatched is not verified success.",
      "wb_screenshot defaults to jpeg; retries on timeout. wb_find_tab is path-aware via list_tabs.",
      "Errors include problem + hint. Escape hatch: wb_evaluate (full profile also has wb_cdp).",
      "Session via optional session arg (default from env). Close tabs only when user asks.",
      `Profile: ${profile.profile} (${profile.toolCount} tools). ${profile.note}`,
    ].join("\n"),
  },
);

function tool(name, description, shape, handler, { preferImage = false } = {}) {
  if (!isToolEnabled(name)) return;
  server.tool(name, description, shape, async (args) => operations.run(async () => {
    try {
      const result = await handler(args ?? {});
      return formatResult(result, { preferImage });
    } catch (err) {
      return formatToolError(err, { tool: name });
    }
  }));
}

const sessionOpt = z
  .string()
  .optional()
  .describe("Per-call session override (does not change the process default)");

const targetSchema = z.object({
  css: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  name: z.string().optional(),
  exact: z.boolean().optional(),
  within: z.string().min(1).optional().describe("Unique CSS container, including open shadow roots"),
  ref: z.string().regex(/^@e/).optional(),
  snapshotId: z.string().optional(),
}).strict().refine(t => Boolean(t.css || t.role || t.name != null || t.ref), "Provide css, role/name or ref")
  .refine(t => !t.ref || (!t.css && !t.role && t.name == null && !t.within), "ref cannot be combined with another locator");
const actionShape = {
  selector: z.string().min(1).optional().describe("Legacy CSS or @e reference; use selector OR target"),
  target: targetSchema.optional(),
  timeoutMs: z.number().int().min(100).max(120000).optional(),
  inputMode: z.enum(["auto", "cdp", "dom"]).optional().describe("Click/check/double-click: auto uses DOM in hidden tabs, CDP in visible tabs. Never retries uncertain input."),
  session: sessionOpt,
};
function actionTarget(args) {
  if (Boolean(args.selector) === Boolean(args.target)) throw new ToolError("Provide exactly one of selector or target", { code: "target_args" });
  return args.target || args.selector;
}
const expectSchema = z.object({
  text: z.string().optional(), selector: z.string().min(1).optional(), url: z.string().url().optional(),
  state: z.enum(["visible", "hidden", "attached", "detached", "enabled"]).optional(),
}).strict().refine(e => e.text != null || e.selector || e.url, "Expectation needs text, selector or url");

async function verifyExpected(result, expect, timeoutMs, session) {
  if (!expect) return result;
  try {
    const observation = await waitFor(client, { ...expect, timeoutMs: timeoutMs ?? 10000 }, session);
    return { ...result, verified: true, outcome: "verified", observation };
  } catch (err) {
    throw new ToolError("Action dispatched but expectation was not met", { code: "verification_failed", detail: { action: result, error: err.message }, hint: "Inspect the page before repeating the action." });
  }
}

// ── Connectivity ──────────────────────────────────────────────

tool(
  "wb_status",
  "Check WebBridge daemon + browser extension connection. Call first if unsure whether the bridge is ready.",
  {},
  async () => {
    client.invalidateStatusCache();
    const ensured = await client.ensureDaemon();
    return {
      ...ensured.status,
      mcp_version: VERSION,
      tool_profile: profile.profile,
      tool_count: profile.toolCount,
      daemon_started_now: ensured.started,
      default_session: client.getSession(),
      capabilities: {
        strict_targets: "implemented", trusted_input: "requires_bridge_cdp",
        open_shadow_roots: "implemented", snapshot_refs: "bound_top_document_nodes",
        native_tab_id_selection: "unsupported_by_adapter; unique URL compatibility only",
        cross_origin_frames: "requires_bridge_target_routing", closed_shadow_roots: "unsupported",
        browser_windows: "requires_extension_api", download_events: "requires_extension_api",
        coordinate_input: "not_exposed; element-based CDP input available",
        events: "polling; no daemon event subscription", upstream: ensured.status?.capabilities ?? null,
      },
      ready: Boolean(ensured.status?.running && ensured.status?.extension_connected),
      hint: ensured.status?.extension_connected
        ? "Ready. Use wb_navigate or wb_find_tab."
        : "Daemon OK but extension not connected. Enable Kimi WebBridge in the browser.",
    };
  },
);

tool(
  "wb_set_session",
  "Set the default session name for subsequent tools (one task = one session = one tab group).",
  {
    session: z.string().min(1).describe("Session / task id used as tab group key"),
  },
  async ({ session }) => ({
    session: client.setSession(session),
    message: `Default session set to "${session}".`,
  }),
);

// ── Navigation & tabs ─────────────────────────────────────────

tool(
  "wb_navigate",
  "Open or navigate to a URL in the real browser. First call of a task should pass group_title. Use newTab:true when pages should coexist.",
  {
    url: z.string().url().describe("Full URL to open"),
    newTab: z.boolean().optional().describe("Open in a new tab (default false)"),
    group_title: z.string().optional().describe("Human-readable tab group label"),
    session: sessionOpt,
  },
  async ({ url, newTab, group_title, session }) => {
    const args = { url };
    if (newTab != null) args.newTab = newTab;
    if (group_title) args.group_title = group_title;
    return client.command("navigate", args, { session });
  },
);

tool(
  "wb_go_back",
  "Browser history back (Claude-in-Chrome style navigation helper).",
  { session: sessionOpt },
  async ({ session }) => goBack(client, session),
);

tool(
  "wb_go_forward",
  "Browser history forward.",
  { session: sessionOpt },
  async ({ session }) => goForward(client, session),
);

tool(
  "wb_reload",
  "Reload the current page. hard:true bypasses cache when CDP allows.",
  {
    hard: z.boolean().optional().describe("Hard reload ignore cache (default false)"),
    session: sessionOpt,
  },
  async ({ hard, session }) => reload(client, { hard: Boolean(hard) }, session),
);

tool(
  "wb_find_tab",
  "Select a session tab by exact URL or tabId resolved to unique URL. Never navigates on failure. Duplicate URLs require upstream ID support.",
  {
    url: z.string().optional().describe("Exact URL of a session-owned tab from wb_list_tabs"),
    active: z.boolean().optional().describe("Prefer the active/focused tab in this session"),
    tabId: z.number().int().optional(),
    session: sessionOpt,
  },
  async ({ url, active, tabId, session }) => findTabSmart(client, { url, active, tabId, session }),
);

tool(
  "wb_list_tabs",
  "List tabs belonging to the current session (tab group).",
  { session: sessionOpt },
  async ({ session }) => client.command("list_tabs", {}, { session }),
);

tool(
  "wb_close_tab",
  "Close the current tab in the session.",
  { session: sessionOpt },
  async ({ session }) => client.command("close_tab", {}, { session }),
);

tool(
  "wb_close_session",
  "Close ALL tabs in the session/group. Only when the user asks to clear agent tabs.",
  { session: sessionOpt },
  async ({ session }) => client.command("close_session", {}, { session }),
);

// ── Inspect ───────────────────────────────────────────────────

tool(
  "wb_snapshot",
  "Accessibility tree with @e refs (like Claude read_page). Prefer before click/fill.",
  { session: sessionOpt },
  async ({ session }) => snapshotWithTargets(client, session),
);

tool(
  "wb_get_text",
  "Extract visible page text (like Claude get_page_text). Better than full snapshot for articles.",
  {
    maxChars: z.number().int().min(100).max(200000).optional().describe("Max characters (default 50000)"),
    session: sessionOpt,
  },
  async ({ maxChars, session }) => getPageText(client, { maxChars: maxChars ?? 50000 }, session),
);

tool(
  "wb_find",
  "Search the accessibility tree by text/role (like Claude find). Returns matching @e refs when present.",
  {
    query: z.string().optional().describe("Case-insensitive substring against name/role/ref"),
    role: z.string().optional().describe("Exact role filter e.g. link, button, textbox"),
    limit: z.number().int().min(1).max(50).optional().describe("Max matches (default 20)"),
    session: sessionOpt,
  },
  async ({ query, role, limit, session }) => {
    if (!query && !role) {
      throw new ToolError("wb_find needs query and/or role", {
        code: "find_args",
        hint: 'Example: { query: "登录" } or { role: "link", query: "动态" }.',
      });
    }
    const snap = await snapshotWithTargets(client, session);
    const tree = snap?.tree ?? snap;
    const unresolved = new Map((snap.unresolvedRefs || []).map(item => [item.ref, item.code]));
    const matches = searchSnapshot(tree, { query, role, limit: limit ?? 20 }).map(match => ({
      ...match, refBound: Boolean(match.ref) && !unresolved.has(match.ref), refError: unresolved.get(match.ref),
    }));
    return {
      ok: true,
      url: snap?.url,
      title: snap?.title,
      count: matches.length,
      matches,
      snapshotId: snap.snapshotId,
      hint: matches.some((m) => m.refBound)
        ? "Use wb_click/wb_fill with a match.ref (e.g. @e1)."
        : "No @e refs in matches; try wb_snapshot or CSS via wb_evaluate.",
    };
  },
);

tool(
  "wb_wait",
  "Wait until text appears, CSS selector matches, or document is ready (timeout).",
  {
    text: z.string().optional().describe("Substring to wait for in document.body.innerText"),
    selector: z.string().optional().describe("CSS selector to wait for"),
    url: z.string().url().optional().describe("Exact expected URL"),
    state: z.enum(["visible", "hidden", "attached", "detached", "enabled"]).optional().describe("Selector state; default visible. Multiple conditions use AND."),
    timeoutMs: z.number().int().min(100).max(120000).optional().describe("Timeout ms (default 15000)"),
    intervalMs: z.number().int().min(50).max(5000).optional().describe("Poll interval ms (default 400)"),
    session: sessionOpt,
  },
  async ({ text, selector, url, state, timeoutMs, intervalMs, session }) =>
    waitFor(client, { text, selector, url, state, timeoutMs, intervalMs }, session),
);

// ── Interact ──────────────────────────────────────────────────

tool(
  "wb_click",
  "Click a unique actionable target. Auto uses CDP in visible tabs, DOM in hidden tabs. Optional expect verifies the result. Auto-follow requires opener evidence.",
  {
    ...actionShape,
    button: z.enum(["left", "right", "middle"]).optional(),
    expect: expectSchema.optional(),
    followTimeoutMs: z.number().int().min(100).max(10000).optional(),
    followNewTab: z
      .boolean()
      .optional()
      .describe("Follow newly opened session tab after click (default true)"),
    session: sessionOpt,
  },
  async (args) => verifyExpected(await clickSmart(client, actionTarget(args), args.session, args), args.expect, args.timeoutMs, args.session),
);

tool(
  "wb_dblclick",
  "Double-click a unique actionable element. Auto uses CDP on visible tabs and synthetic DOM input on hidden tabs; mode is reported.",
  { ...actionShape, expect: expectSchema.optional() },
  async args => verifyExpected(await interact(client, "dblclick", actionTarget(args), args, args.session), args.expect, args.timeoutMs, args.session),
);

tool(
  "wb_hover",
  "Hover/mouseover an element (@e or CSS). Useful for menus and tooltips.",
  { ...actionShape, expect: expectSchema.optional() },
  async args => verifyExpected(await interact(client, "hover", actionTarget(args), args, args.session), args.expect, args.timeoutMs, args.session),
);

tool(
  "wb_fill",
  "Clear-and-fill input/textarea/contenteditable. selector = @e or CSS.",
  {
    ...actionShape,
    value: z.string().describe("Text to insert (replaces existing)"),
    session: sessionOpt,
  },
  async args => interact(client, "fill", actionTarget(args), args, args.session),
);

tool("wb_type", "Insert text at the target's caret without replacing existing text, via CDP. Verify the result separately.",
  { ...actionShape, value: z.string() }, async args => interact(client, "type", actionTarget(args), args, args.session));
tool("wb_select", "Set native select option values and verify selection. Does not support custom dropdown widgets.",
  { ...actionShape, values: z.array(z.string()).max(100) }, async args => interact(client, "select", actionTarget(args), args, args.session));
tool("wb_check", "Set checkbox/radio state idempotently and verify it. Does not blindly toggle.",
  { ...actionShape, checked: z.boolean() }, async args => interact(client, "check", actionTarget(args), args, args.session));
tool("wb_drag", "Pointer drag between two unique elements using CDP. Requires both targets visible together; HTML5 DataTransfer is not synthesized.",
  { source: targetSchema, destination: targetSchema, steps: z.number().int().min(2).max(60).optional(), timeoutMs: actionShape.timeoutMs, expect: expectSchema.optional(), session: sessionOpt },
  async args => verifyExpected(await drag(client, args.source, args.destination, args, args.session), args.expect, args.timeoutMs, args.session));

tool(
  "wb_fill_form",
  "Fill multiple fields in one call (Claude-style multi-field form fill).",
  {
    fields: z
      .array(
        z.object({
          selector: z.string().min(1).optional().describe("@e ref or CSS; provide selector OR target"),
          target: targetSchema.optional(),
          value: z.union([z.string(), z.number(), z.boolean()]).describe("Value to fill"),
        }).refine(f => Boolean(f.selector) !== Boolean(f.target), "Provide selector OR target"),
      )
      .min(1)
      .max(100)
      .describe("Ordered list of fields to fill"),
    session: sessionOpt,
  },
  async ({ fields, session }) => fillForm(client, fields, session),
);

tool(
  "wb_press_key",
  "Press a key or combo on the focused element (e.g. Enter, Escape, Tab, Control+A). Like Claude press_key.",
  {
    key: z
      .string()
      .min(1)
      .describe("Key or combo: Enter, Escape, Tab, ArrowDown, Control+A, Meta+C, ..."),
    session: sessionOpt,
  },
  async ({ key, session }) => pressKey(client, key, session),
);

tool(
  "wb_scroll",
  "Scroll page or element into view. direction: up|down|left|right, or x/y deltas, or selector/@e into view.",
  {
    selector: z.string().optional().describe("@e ref or CSS to scrollIntoView"),
    container: z.string().optional().describe("Unique CSS container to scrollBy; defaults to document.scrollingElement"),
    direction: z.enum(["up", "down", "left", "right"]).optional(),
    amount: z.number().optional().describe("Pixels for direction scroll (default 600)"),
    x: z.number().optional().describe("Horizontal scrollBy delta"),
    y: z.number().optional().describe("Vertical scrollBy delta"),
    session: sessionOpt,
  },
  async ({ selector, container, direction, amount, x, y, session }) => {
    if (selector && container) throw new ToolError("Use selector for scrollIntoView OR container for scrollBy", { code: "scroll_args" });
    return scroll(client, { selector, container, direction, amount, x, y }, session);
  },
);

tool(
  "wb_evaluate",
  "Run JavaScript in the page. Prefer compact JSON.stringify returns. Wrap multi-call state in an IIFE.",
  {
    code: z.string().min(1),
    session: sessionOpt,
  },
  async ({ code, session }) => client.command("evaluate", { code }, { session }),
);

tool(
  "wb_cdp",
  "Raw Chrome DevTools Protocol method via chrome.debugger. Escape hatch for trusted input / deep diagnostics.",
  {
    method: z.string().min(1).describe("CDP method e.g. Input.dispatchMouseEvent"),
    params: z.record(z.unknown()).optional(),
    session: sessionOpt,
  },
  async ({ method, params, session }) =>
    client.command("cdp", { method, params: params ?? {} }, { session }),
);

// ── Capture ───────────────────────────────────────────────────

tool(
  "wb_screenshot",
  "Screenshot current tab (or selector), with bounded retries and image preview. Original file is preserved; oversized images get resized JPEG previews with dimensions.",
  {
    format: z.enum(["png", "jpeg"]).optional().describe("Default jpeg (faster/more reliable than png)"),
    quality: z.number().int().min(0).max(100).optional().describe("JPEG quality; default 55"),
    selector: z.string().optional().describe("Optional @e/CSS crop — use for large pages"),
    path: z.string().optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional().describe("Capture retry budget; default 60000 ms"),
    session: sessionOpt,
  },
  async ({ format, quality, selector, path, timeoutMs, session }) => {
    const args = {};
    if (format) args.format = format;
    if (quality != null) args.quality = quality;
    if (selector) args.selector = selector;
    if (path) args.path = path;
    if (timeoutMs != null) args.timeoutMs = timeoutMs;
    return screenshotSmart(client, args, session);
  },
  { preferImage: true },
);

tool(
  "wb_save_as_pdf",
  "Render current page to PDF; returns filesystem path. Long timeout; on failure returns problem+hint.",
  {
    paper_format: z.enum(["letter", "a4", "legal", "a3", "tabloid"]).optional(),
    landscape: z.boolean().optional(),
    scale: z.number().min(0.1).max(2).optional(),
    print_background: z.boolean().optional(),
    path: z.string().optional(),
    session: sessionOpt,
  },
  async ({ paper_format, landscape, scale, print_background, path, session }) => {
    const args = {};
    if (paper_format) args.paper_format = paper_format;
    if (landscape != null) args.landscape = landscape;
    if (scale != null) args.scale = scale;
    if (print_background != null) args.print_background = print_background;
    if (path) args.path = path;
    return savePdfSmart(client, args, session);
  },
);

// ── Network, console, upload ──────────────────────────────────

tool(
  "wb_network",
  "Capture/list network requests. cmd: start | stop | list | detail.",
  {
    cmd: z.enum(["start", "stop", "list", "detail"]),
    filter: z.string().optional(),
    requestId: z.string().optional(),
    session: sessionOpt,
  },
  async ({ cmd, filter, requestId, session }) => {
    const args = { cmd };
    if (filter) args.filter = filter;
    if (requestId) args.requestId = requestId;
    return client.command("network", args, { session });
  },
);

tool(
  "wb_console",
  "Capture page console / errors (Claude-style). cmd: start (install interceptor) | list | clear | stop.",
  {
    cmd: z.enum(["start", "list", "clear", "stop"]).describe("start before actions you want to observe"),
    session: sessionOpt,
  },
  async ({ cmd, session }) => consoleCmd(client, cmd, session),
);

tool(
  "wb_upload",
  "Set files on a file input element. files must be absolute local filesystem paths (not http/data URLs). Page must already show <input type=file>.",
  {
    selector: z.string().min(1),
    files: z.array(z.string()).min(1).describe("Absolute local filesystem paths only"),
    session: sessionOpt,
  },
  async ({ selector, files, session }) => {
    for (const f of files) {
      if (/^(https?:|data:|blob:)/i.test(f)) {
        throw new ToolError("upload files must be local filesystem paths, not URLs", {
          code: "upload_bad_path",
          detail: f,
          hint: "Pass absolute paths like C:\\\\Users\\\\...\\\\file.pdf. Open a real page with <input type=file> first (data: URLs are unreliable).",
        });
      }
      if (!existsSync(f)) {
        throw new ToolError(`Upload file does not exist: ${f}`, {
          code: "upload_missing_file",
          hint: "Check the absolute path on disk before wb_upload.",
        });
      }
      if (!isAbsolute(f)) throw new ToolError("Upload requires absolute paths", { code: "upload_bad_path", detail: f });
    }
    // Quick page diagnostics if element likely missing
    try {
      return await client.command("upload", { selector, files }, { session });
    } catch (err) {
      const msg = err?.message || String(err);
      if (/element not found/i.test(msg)) {
        throw new ToolError(`File input not found: ${selector}`, {
          code: "upload_no_input",
          detail: msg,
          hint: "wb_snapshot/find the file input first. Avoid data: pages; use http(s) or file:// fixture (fixtures/upload.html). Ensure input type=file is in the top frame.",
        });
      }
      throw err;
    }
  },
);

// Boot
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[kimi-webbridge-mcp] v${VERSION} profile=${profile.profile} tools=${profile.toolCount} session=${client.getSession()}`,
);
