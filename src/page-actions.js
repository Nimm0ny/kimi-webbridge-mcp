/**
 * Higher-level page actions on evaluate / cdp / snapshot.
 * Failures throw Error so MCP returns isError (no silent ok:false success).
 */

import { ToolError } from "./errors.js";
import { interact, prepareTarget, runTarget } from "./targets.js";
// ToolError used by scroll CDP fallback

export function unwrap(result) {
  if (result && typeof result === "object" && "data" in result && result.data !== undefined) {
    return result.data;
  }
  return result;
}

export function assertOk(result, label = "action") {
  if (result && typeof result === "object" && result.ok === false) {
    throw new Error(result.error || result.message || `${label} failed: ${JSON.stringify(result)}`);
  }
  return result;
}

export async function evaluateRaw(client, code, session, timeoutMs) {
  return unwrap(await client.command("evaluate", { code }, { session, timeoutMs }));
}

export async function evaluateJson(client, code, session, timeoutMs) {
  const data = await evaluateRaw(client, code, session, timeoutMs);
  const value = data?.value !== undefined ? data.value : data;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export async function cdp(client, method, params = {}, session) {
  return unwrap(await client.command("cdp", { method, params }, { session }));
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Snapshot search ───────────────────────────────────────────

/**
 * Walk a11y trees that may contain nested bare arrays (Bilibili/WebBridge quirks),
 * not only { children: [] } nodes.
 */
export function walkSnapshot(nodes, visit) {
  if (nodes == null) return;
  if (Array.isArray(nodes)) {
    for (const item of nodes) walkSnapshot(item, visit);
    return;
  }
  if (typeof nodes !== "object") return;
  // Skip plain arrays already handled; visit real a11y nodes
  if (nodes.role != null || nodes.name != null || nodes.ref != null) {
    visit(nodes);
  }
  if (nodes.children != null) walkSnapshot(nodes.children, visit);
  // Some dumps nest extra array-valued fields
  for (const [k, v] of Object.entries(nodes)) {
    if (k === "children" || k === "name" || k === "role" || k === "ref") continue;
    if (Array.isArray(v)) walkSnapshot(v, visit);
  }
}

export function searchSnapshot(tree, { query, role, limit = 20 }) {
  const q = (query || "").trim().toLowerCase();
  const roleFilter = (role || "").trim().toLowerCase();
  const matches = [];

  walkSnapshot(tree, (node) => {
    if (matches.length >= limit) return;
    const name = String(node.name ?? "");
    const nodeRole = String(node.role ?? "");
    const ref = node.ref || null;
    if (!name && !ref && !nodeRole) return;
    if (roleFilter && nodeRole.toLowerCase() !== roleFilter) return;
    if (q) {
      // Case-fold for ASCII; Chinese matched as-is via includes on lowercased hay (中文 unchanged)
      const hay = `${name} ${nodeRole} ${ref || ""}`.toLowerCase();
      if (!hay.includes(q)) return;
    }
    matches.push({
      ref: ref || null,
      role: nodeRole || null,
      name: name || null,
      interactive: Boolean(ref),
    });
  });

  matches.sort((a, b) => Number(b.interactive) - Number(a.interactive));
  return matches.slice(0, limit);
}

export function findRefMeta(tree, ref) {
  let target = null;
  walkSnapshot(tree, (node) => {
    if (node.ref === ref) target = node;
  });
  if (!target) return null;
  return { ref, name: target.name || "", role: target.role || "" };
}

// ── Keyboard ──────────────────────────────────────────────────

const KEY_TABLE = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Esc: { key: "Escape", code: "Escape", keyCode: 27 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

function parseKeyCombo(keyStr) {
  const parts = String(keyStr).split("+").map((p) => p.trim());
  const keyPart = parts[parts.length - 1];
  const mods = {
    alt: parts.some((p) => /^alt$/i.test(p)),
    ctrl: parts.some((p) => /^(ctrl|control)$/i.test(p)),
    meta: parts.some((p) => /^(meta|cmd|command)$/i.test(p)),
    shift: parts.some((p) => /^shift$/i.test(p)),
  };
  const mapped = KEY_TABLE[keyPart] || KEY_TABLE[keyPart.charAt(0).toUpperCase() + keyPart.slice(1)];
  if (mapped) return { ...mapped, ...mods };
  if (keyPart.length === 1) {
    return {
      key: keyPart,
      code: /^[a-zA-Z]$/.test(keyPart) ? `Key${keyPart.toUpperCase()}` : keyPart,
      keyCode: keyPart.toUpperCase().charCodeAt(0),
      text: keyPart,
      ...mods,
    };
  }
  return { key: keyPart, code: keyPart, keyCode: 0, ...mods };
}

export async function pressKey(client, keyStr, session) {
  const info = parseKeyCombo(keyStr);
  // Prefer CDP trusted key events
  try {
    const modifiers =
      (info.alt ? 1 : 0) | (info.ctrl ? 2 : 0) | (info.meta ? 4 : 0) | (info.shift ? 8 : 0);
    const base = {
      windowsVirtualKeyCode: info.keyCode,
      code: info.code,
      key: info.key,
      modifiers,
    };
    await cdp(client, "Input.dispatchKeyEvent", { type: "keyDown", ...base, text: (info.ctrl || info.meta || info.alt) ? undefined : info.text }, session);
    await cdp(client, "Input.dispatchKeyEvent", { type: "keyUp", ...base }, session);
    return { ok: true, key: info.key, mode: "cdp" };
  } catch (err) {
    throw new ToolError("Keyboard input failed; no synthetic fallback was sent", {
      code: "outcome_unknown", detail: err.message,
      hint: "Inspect focus and page state before retrying the key.",
    });
  }
}

// ── Scroll ────────────────────────────────────────────────────

export async function scroll(client, { selector, container, direction, amount, x, y }, session) {
  if (selector) {
    const bound = await prepareTarget(client, selector, session, { pointer: false, requireEnabled: false });
    if (!bound.retained) await runTarget(client, { op: "release", handle: bound.handle }, session);
    return { ok: true, mode: "intoView", verified: true, visible: bound.visible, target: { role: bound.role, name: bound.name } };
  }
  const amt = Number(amount ?? 600);
  const dx = x != null ? Number(x) : direction === "left" ? -amt : direction === "right" ? amt : 0;
  const dy = y != null ? Number(y) : direction === "up" ? -amt : direction === "down" || !direction ? amt : 0;
  const result = await evaluateJson(client, `(() => {
    const selector = ${JSON.stringify(container || null)};
    const roots = selector ? [...document.querySelectorAll(selector)] : [document.scrollingElement];
    if (roots.length !== 1 || !roots[0]) return JSON.stringify({ok:false, error:"Scroll container must match exactly one element"});
    const root = roots[0];
    const before = { x:root.scrollLeft, y:root.scrollTop };
    root.scrollBy({left:${dx}, top:${dy}, behavior:"instant"});
    const after = { x:root.scrollLeft, y:root.scrollTop };
    return JSON.stringify({ok:true, moved:before.x!==after.x || before.y!==after.y, before, after, mode:"dom-scroll", verified:true, viewport:{w:innerWidth,h:innerHeight}});
  })()`, session);
  assertOk(result, "scroll");
  if (result.moved || container) return result;
  // Wheel fallback can drive virtual lists. Dispatch is not proof of movement.
  await cdp(client, "Input.dispatchMouseEvent", {type:"mouseWheel", x:result.viewport.w/2, y:result.viewport.h/2, deltaX:dx, deltaY:dy}, session);
  return {ok:true, mode:"cdp-wheel", moved:null, verified:false, outcome:"dispatched", dx, dy, dom:result};
}

// ── Click with optional new-tab follow ────────────────────────

export async function clickSmart(client, selector, session, { followNewTab = true, followTimeoutMs = 1500, timeoutMs = 10000, button = "left", inputMode = "auto" } = {}) {
  let beforeTabs = [], sourceTabId, observationError;
  if (followNewTab) {
    try {
      const listed = unwrap(await client.command("list_tabs", {}, { session }));
      beforeTabs = listed?.tabs || [];
      const page = await evaluateJson(client, 'JSON.stringify({href:location.href})', session);
      const sources = beforeTabs.filter(t => t.url === page?.href);
      if (sources.length === 1) sourceTabId = sources[0].tabId;
    } catch (err) { observationError = err.message; }
  }
  const click = await interact(client, "click", selector, { timeoutMs, button, inputMode }, session);
  if (!followNewTab || sourceTabId == null) return { ...click, followedNewTab: false, observationError,
    hint: sourceTabId == null && followNewTab ? "Source tab identity unavailable; inspect wb_list_tabs." : undefined };
  const beforeIds = new Set(beforeTabs.map(t => t.tabId));
  const deadline = Date.now() + followTimeoutMs;
  let created = [];
  while (Date.now() < deadline) {
    await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
    try {
      const listed = unwrap(await client.command("list_tabs", {}, { session, timeoutMs: Math.max(1, deadline - Date.now()) }));
      created = (listed?.tabs || []).filter(t => !beforeIds.has(t.tabId));
      const related = created.filter(t => t.openerTabId === sourceTabId && /^https?:/i.test(t.url || ""));
      if (related.length === 1 && created.length === 1) {
        const { findTabSmart } = await import("./tab-actions.js");
        const selected = await findTabSmart(client, { tabId: related[0].tabId, session });
        return { ...click, followedNewTab: true, newTab: related[0], selection: selected };
      }
    } catch (err) { observationError = err.message; break; }
  }
  return { ...click, followedNewTab: false, newTabCandidates: created, observationError,
    hint: created.length ? "No unique opener relationship established; select explicitly with wb_find_tab." : "No related new tab observed within followTimeoutMs." };
}

// ── Wait ──────────────────────────────────────────────────────

export async function waitFor(client, { text, selector, url, state = "visible", timeoutMs = 15000, intervalMs = 400 }, session) {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  const interval = Math.max(10, intervalMs);
  let last = null;
  const started = Date.now();

  while (Date.now() < deadline) {
    const code = `(() => {
      const text = ${JSON.stringify(text ?? null)};
      const selector = ${JSON.stringify(selector ?? null)};
      const url = ${JSON.stringify(url ?? null)};
      const state = ${JSON.stringify(state)};
      let selectorOk = true;
      if (selector) {
        const elements = [...document.querySelectorAll(selector)];
        const visible = el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0 && r.height>0 && s.visibility!=="hidden" && s.visibility!=="collapse"; };
        selectorOk = state === "hidden" ? elements.every(el => !visible(el)) : state === "detached" ? elements.length === 0 : elements.length === 1 && (state === "attached" || visible(elements[0])) && (state !== "enabled" || (!elements[0].matches(":disabled") && !elements[0].closest('[aria-disabled="true"],[inert]')));
      }
      const textOk = text == null || (document.body?.innerText || "").includes(text);
      const urlOk = url == null || location.href === url;
      const ready = text != null || selector || url != null || ["complete","interactive"].includes(document.readyState);
      return JSON.stringify({ok:Boolean(selectorOk && textOk && urlOk && ready), href:location.href, readyState:document.readyState});
    })()`;
    const raw = unwrap(await client.command("evaluate", { code }, { session, timeoutMs: Math.max(1, deadline - Date.now()) }));
    const value = raw?.value !== undefined ? raw.value : raw;
    last = typeof value === "string" ? JSON.parse(value) : value;
    if (last && last.ok) {
      return { ...last, waitedMs: Date.now() - started };
    }
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
  }

  const httpish = /503|502|500|404|unavailable|error/i.test(
    `${last?.title || ""} ${last?.bodyPreview || ""}`,
  );
  throw new ToolError(
    `Wait timed out after ${timeoutMs}ms` +
      (text ? ` for text ${JSON.stringify(text)}` : "") +
      (selector ? ` for selector ${JSON.stringify(selector)}` : ""),
    {
      code: "wait_timeout",
      detail: last,
      hint: httpish
        ? "Page looks like an HTTP error (e.g. 503). Use a stable URL or local fixture (fixtures/form.html via file://), not flaky third-party demos."
        : "Re-check selector/text with wb_snapshot/wb_get_text; increase timeoutMs; ensure navigate finished.",
    },
  );
}

// ── Text ───────────────────────────────────────────────────────

export async function getPageText(client, { maxChars = 50000 } = {}, session) {
  const code = `(() => {
    const max = ${Number(maxChars)};
    const title = document.title || "";
    const url = location.href;
    let text = document.body ? (document.body.innerText || "") : "";
    text = text.replace(/\\n{3,}/g, "\\n\\n").trim();
    const truncated = text.length > max;
    if (truncated) text = text.slice(0, max);
    return JSON.stringify({ ok: true, title, url, text, length: text.length, truncated });
  })()`;
  return assertOk(await evaluateJson(client, code, session), "get_text");
}

// ── Navigation helpers ────────────────────────────────────────

export async function goBack(client, session) {
  const before = await evaluateJson(
    client,
    `(() => JSON.stringify({ href: location.href }))()`,
    session,
  );
  await evaluateJson(
    client,
    `(() => { history.back(); return JSON.stringify({ ok: true }); })()`,
    session,
  );
  const started = Date.now();
  while (Date.now() - started < 3000) {
    await sleep(150);
    const after = await evaluateJson(
      client,
      `(() => JSON.stringify({ href: location.href, readyState: document.readyState }))()`,
      session,
    );
    if (after?.href && after.href !== before?.href) {
      return { ok: true, action: "back", verified: true, outcome: "verified", from: before?.href, href: after.href, readyState: after.readyState };
    }
  }
  const finalHref = await evaluateJson(
    client,
    `(() => JSON.stringify({ href: location.href, readyState: document.readyState }))()`,
    session,
  );
  return {
    ok: true,
    action: "back",
    verified: false,
    outcome: "dispatched",
    from: before?.href,
    href: finalHref?.href,
    readyState: finalHref?.readyState,
    note: "href may be unchanged if history has no previous entry; navigation is async",
  };
}

export async function goForward(client, session) {
  const before = await evaluateJson(
    client,
    `(() => JSON.stringify({ href: location.href }))()`,
    session,
  );
  await evaluateJson(
    client,
    `(() => { history.forward(); return JSON.stringify({ ok: true }); })()`,
    session,
  );
  const started = Date.now();
  while (Date.now() - started < 3000) {
    await sleep(150);
    const after = await evaluateJson(
      client,
      `(() => JSON.stringify({ href: location.href, readyState: document.readyState }))()`,
      session,
    );
    if (after?.href && after.href !== before?.href) {
      return { ok: true, action: "forward", verified: true, outcome: "verified", from: before?.href, href: after.href, readyState: after.readyState };
    }
  }
  const finalHref = await evaluateJson(
    client,
    `(() => JSON.stringify({ href: location.href, readyState: document.readyState }))()`,
    session,
  );
  return {
    ok: true,
    action: "forward",
    verified: false,
    outcome: "dispatched",
    from: before?.href,
    href: finalHref?.href,
    readyState: finalHref?.readyState,
    note: "href may be unchanged if history has no next entry; navigation is async",
  };
}

export async function reload(client, { hard = false } = {}, session) {
  if (hard) {
    try {
      await cdp(client, "Page.reload", { ignoreCache: true }, session);
      await sleep(200);
      return { ok: true, action: "reload", hard: true, mode: "cdp", verified: false, outcome: "dispatched" };
    } catch (err) {
      throw new ToolError("Reload outcome unknown", { code: "outcome_unknown", detail: err.message, hint: "Inspect the page before retrying; no second reload was sent." });
    }
  }
  // Fire-and-note: location.reload unloads the page; evaluate may abort
  try {
    await evaluateJson(
      client,
      `(() => { location.reload(); return JSON.stringify({ ok: true }); })()`,
      session,
    );
  } catch {
    // expected on navigation
  }
  await sleep(300);
  return { ok: true, action: "reload", hard: Boolean(hard), mode: "location", verified: false, outcome: "dispatched" };
}

// ── Hover / dblclick ──────────────────────────────────────────

export async function hoverSmart(client, selector, session) {
  return interact(client, "hover", selector, {}, session);
}

export async function dblclick(client, selector, session) {
  return interact(client, "dblclick", selector, {}, session);
}

// ── Console capture ───────────────────────────────────────────

const CONSOLE_INSTALL = `(() => {
  if (window.__wbConsoleInstalled) {
    return JSON.stringify({ ok: true, already: true, count: (window.__wbConsoleBuf || []).length });
  }
  window.__wbConsoleBuf = [];
  window.__wbConsoleOrig = {};
  window.__wbConsoleInstalled = true;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    window.__wbConsoleOrig[level] = console[level].bind(console);
    console[level] = (...args) => {
      try {
        window.__wbConsoleBuf.push({
          level,
          time: Date.now(),
          args: args.map((a) => {
            try {
              return typeof a === "string" ? a : JSON.stringify(a);
            } catch {
              return String(a);
            }
          }),
        });
        if (window.__wbConsoleBuf.length > 500) window.__wbConsoleBuf.shift();
      } catch (_) {}
      return window.__wbConsoleOrig[level](...args);
    };
  }
  window.__wbConsoleOnError = (e) => {
    window.__wbConsoleBuf.push({
      level: "pageerror",
      time: Date.now(),
      args: [String(e.message), String(e.filename || ""), e.lineno || 0],
    });
  };
  window.__wbConsoleOnRej = (e) => {
    window.__wbConsoleBuf.push({
      level: "unhandledrejection",
      time: Date.now(),
      args: [String(e.reason)],
    });
  };
  window.addEventListener("error", window.__wbConsoleOnError);
  window.addEventListener("unhandledrejection", window.__wbConsoleOnRej);
  return JSON.stringify({ ok: true, already: false, count: 0 });
})()`;

const CONSOLE_STOP = `(() => {
  if (!window.__wbConsoleInstalled) {
    return JSON.stringify({ ok: true, stopped: false, installed: false });
  }
  if (window.__wbConsoleOrig) {
    for (const level of Object.keys(window.__wbConsoleOrig)) {
      console[level] = window.__wbConsoleOrig[level];
    }
  }
  if (window.__wbConsoleOnError) window.removeEventListener("error", window.__wbConsoleOnError);
  if (window.__wbConsoleOnRej) window.removeEventListener("unhandledrejection", window.__wbConsoleOnRej);
  const count = window.__wbConsoleBuf ? window.__wbConsoleBuf.length : 0;
  delete window.__wbConsoleOrig;
  delete window.__wbConsoleOnError;
  delete window.__wbConsoleOnRej;
  window.__wbConsoleInstalled = false;
  return JSON.stringify({ ok: true, stopped: true, restored: true, bufferRetained: count });
})()`;

export async function consoleCmd(client, cmd, session) {
  if (cmd === "start") return assertOk(await evaluateJson(client, CONSOLE_INSTALL, session), "console.start");
  if (cmd === "list") {
    const r = await evaluateJson(
      client,
      `(() => {
        if (!window.__wbConsoleInstalled) {
          return JSON.stringify({ ok: true, installed: false, messages: [], hint: "call wb_console cmd=start first" });
        }
        return JSON.stringify({
          ok: true,
          installed: true,
          messages: window.__wbConsoleBuf.slice(),
          count: window.__wbConsoleBuf.length,
        });
      })()`,
      session,
    );
    return assertOk(r, "console.list");
  }
  if (cmd === "clear") {
    return assertOk(
      await evaluateJson(
        client,
        `(() => {
          if (!window.__wbConsoleBuf) return JSON.stringify({ ok: true, cleared: false, installed: false });
          window.__wbConsoleBuf = [];
          return JSON.stringify({ ok: true, cleared: true });
        })()`,
        session,
      ),
      "console.clear",
    );
  }
  if (cmd === "stop") {
    return assertOk(await evaluateJson(client, CONSOLE_STOP, session), "console.stop");
  }
  throw new Error(`Unknown console cmd: ${cmd}`);
}

// ── Fill form ─────────────────────────────────────────────────

export async function fillForm(client, fields, session) {
  const results = [];
  for (const field of fields) {
    try {
      const r = unwrap(
        await interact(client, "fill", field.target || field.selector, { value: String(field.value) }, session),
      );
      results.push({ selector: field.selector, ok: true, result: r });
    } catch (err) {
      results.push({ selector: field.selector, ok: false, error: err.message || String(err) });
      break;
    }
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new ToolError(
      `wb_fill_form: ${failed.length}/${results.length} fields failed`,
      {
        code: "fill_form_partial",
        detail: { filled: results.length - failed.length, total: fields.length, skipped: fields.length - results.length, results },
        hint: "Re-snapshot for @e refs; fill failed fields individually with wb_fill; check Vue/controlled inputs.",
      },
    );
  }
  return {
    ok: true,
    filled: results.length,
    total: results.length,
    results,
  };
}
