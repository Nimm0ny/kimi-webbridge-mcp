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
  consoleCmd,
  dblclick,
  fillForm,
  getPageText,
  goBack,
  goForward,
  hoverSmart,
  pressKey,
  reload,
  scroll,
  searchSnapshot,
  unwrap,
  waitFor,
} from "./page-actions.js";
import { findTabSmart } from "./tab-actions.js";
import { ToolError } from "./errors.js";
import { existsSync } from "node:fs";

const VERSION = packageVersion();
const client = new WebBridgeClient();

const server = new McpServer(
  {
    name: "kimi-webbridge",
    version: VERSION,
  },
  {
    instructions: [
      "Kimi WebBridge controls the user's REAL browser (existing logins/cookies) via a local daemon + Chrome/Edge extension.",
      "Workflow: wb_status → wb_navigate (or wb_find_tab) → wb_snapshot or wb_find → wb_click/wb_fill using @e refs.",
      "Claude-in-Chrome style helpers: wb_get_text, wb_find, wb_press_key, wb_scroll, wb_wait, wb_console, wb_go_back, wb_go_forward, wb_reload, wb_hover, wb_dblclick, wb_fill_form.",
      "wb_screenshot defaults to jpeg for reliability; on timeout it auto-retries smaller jpeg. Prefer selector crop for huge pages.",
      "wb_find_tab fuzzy-matches session URLs; active:true works even when the extension requires a url (resolves via list_tabs).",
      "Prefer wb_snapshot/wb_find + @eN refs over CSS/JS. Use wb_evaluate/wb_cdp only as escape hatches — never for stealing secrets/cookies.",
      "Errors return JSON with problem + hint lines — read them before retrying.",
      "Session = tab group. Per-call session does NOT change the default (use wb_set_session).",
      "wb_close_session only when the user asks to close agent tabs.",
      "If extension disconnected: enable Kimi WebBridge in the browser.",
    ].join("\n"),
  },
);

function tool(name, description, shape, handler, { preferImage = false } = {}) {
  server.tool(name, description, shape, async (args) => {
    try {
      // session is per-call only — do NOT mutate client default
      const result = await handler(args ?? {});
      return formatResult(result, { preferImage });
    } catch (err) {
      return formatToolError(err, { tool: name });
    }
  });
}

const sessionOpt = z
  .string()
  .optional()
  .describe("Per-call session override (does not change default; use wb_set_session for that)");

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
      daemon_started_now: ensured.started,
      default_session: client.getSession(),
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
  "Select a tab as current. URL match is fuzzy within the session (trailing slash/query tolerant). active:true borrows the focused session tab when possible.",
  {
    url: z.string().optional().describe("URL of a session-owned tab (exact or fuzzy)"),
    active: z.boolean().optional().describe("Prefer the active/focused tab in this session"),
    session: sessionOpt,
  },
  async ({ url, active, session }) => findTabSmart(client, { url, active, session }),
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
  async ({ session }) => client.command("snapshot", {}, { session }),
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
      throw new Error("Provide query and/or role");
    }
    const snap = unwrap(await client.command("snapshot", {}, { session }));
    const tree = snap?.tree ?? snap;
    const matches = searchSnapshot(tree, { query, role, limit: limit ?? 20 });
    return {
      ok: true,
      url: snap?.url,
      title: snap?.title,
      count: matches.length,
      matches,
      hint: matches.some((m) => m.ref)
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
    timeoutMs: z.number().int().min(100).max(120000).optional().describe("Timeout ms (default 15000)"),
    intervalMs: z.number().int().min(50).max(5000).optional().describe("Poll interval ms (default 400)"),
    session: sessionOpt,
  },
  async ({ text, selector, timeoutMs, intervalMs, session }) =>
    waitFor(client, { text, selector, timeoutMs, intervalMs }, session),
);

// ── Interact ──────────────────────────────────────────────────

tool(
  "wb_click",
  "Click an element. selector is @e ref from snapshot/find (preferred) or CSS.",
  {
    selector: z.string().min(1).describe("@e ref e.g. @e12 or CSS selector"),
    session: sessionOpt,
  },
  async ({ selector, session }) => client.command("click", { selector }, { session }),
);

tool(
  "wb_dblclick",
  "Double-click an element (@e or CSS). Dispatches real dblclick DOM events (not two separate clicks).",
  {
    selector: z.string().min(1),
    session: sessionOpt,
  },
  async ({ selector, session }) => dblclick(client, selector, session),
);

tool(
  "wb_hover",
  "Hover/mouseover an element (@e or CSS). Useful for menus and tooltips.",
  {
    selector: z.string().min(1),
    session: sessionOpt,
  },
  async ({ selector, session }) => hoverSmart(client, selector, session),
);

tool(
  "wb_fill",
  "Clear-and-fill input/textarea/contenteditable. selector = @e or CSS.",
  {
    selector: z.string().min(1),
    value: z.string().describe("Text to insert (replaces existing)"),
    session: sessionOpt,
  },
  async ({ selector, value, session }) => client.command("fill", { selector, value }, { session }),
);

tool(
  "wb_fill_form",
  "Fill multiple fields in one call (Claude-style multi-field form fill).",
  {
    fields: z
      .array(
        z.object({
          selector: z.string().min(1).describe("@e ref or CSS"),
          value: z.union([z.string(), z.number(), z.boolean()]).describe("Value to fill"),
        }),
      )
      .min(1)
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
    direction: z.enum(["up", "down", "left", "right"]).optional(),
    amount: z.number().optional().describe("Pixels for direction scroll (default 600)"),
    x: z.number().optional().describe("Horizontal scrollBy delta"),
    y: z.number().optional().describe("Vertical scrollBy delta"),
    session: sessionOpt,
  },
  async ({ selector, direction, amount, x, y, session }) =>
    scroll(client, { selector, direction, amount, x, y }, session),
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
  "Screenshot current tab (or selector). Default format=jpeg for reliability; auto-retries smaller jpeg on timeout. Returns path; embeds image when under size cap. Errors include problem+hint.",
  {
    format: z.enum(["png", "jpeg"]).optional().describe("Default jpeg (faster/more reliable than png)"),
    quality: z.number().int().min(0).max(100).optional().describe("JPEG quality; default 65"),
    selector: z.string().optional().describe("Optional @e/CSS crop — use for large pages"),
    path: z.string().optional(),
    session: sessionOpt,
  },
  async ({ format, quality, selector, path, session }) => {
    const args = {};
    if (format) args.format = format;
    if (quality != null) args.quality = quality;
    if (selector) args.selector = selector;
    if (path) args.path = path;
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
  `[kimi-webbridge-mcp] v${VERSION} ready session=${client.getSession()} url=${process.env.WEBBRIDGE_URL || "http://127.0.0.1:10086"} tools=28 hardened=screenshot,find_tab,errors`,
);
