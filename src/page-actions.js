/**
 * Higher-level page actions on evaluate / cdp / snapshot.
 * Failures throw Error so MCP returns isError (no silent ok:false success).
 */

import { ToolError } from "./errors.js";
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

export async function evaluateRaw(client, code, session) {
  return unwrap(await client.command("evaluate", { code }, { session }));
}

export async function evaluateJson(client, code, session) {
  const data = await evaluateRaw(client, code, session);
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

/** DOM finder script body: exact name+role first, then exact name, then startsWith — never loose includes-only first. */
function domResolveScript(meta, selector) {
  return `(() => {
    const name = ${JSON.stringify(meta?.name || "")}.trim();
    const role = ${JSON.stringify(meta?.role || "")}.trim().toLowerCase();
    const sel = ${JSON.stringify(selector)};
    const roleTags = {
      link: ["a"],
      button: ["button", "input", "summary"],
      textbox: ["input", "textarea"],
      searchbox: ["input"],
      checkbox: ["input"],
      radio: ["input"],
      combobox: ["select", "input"],
      listbox: ["select"],
      heading: ["h1", "h2", "h3", "h4", "h5", "h6"],
      img: ["img"],
      image: ["img"],
    };
    // Prefer interactive candidates when role is interactive
    const interactiveSel = "a,button,input,textarea,select,summary,label,[role],[tabindex],[onclick]";
    const broadSel = interactiveSel + ",h1,h2,h3,h4,h5,h6,p,li,div,span";
    const preferInteractive = ["link", "button", "textbox", "searchbox", "checkbox", "radio", "combobox"].includes(role);
    const candidates = Array.from(document.querySelectorAll(preferInteractive ? interactiveSel : broadSel));
    function labelOf(n) {
      return (n.getAttribute("aria-label") || n.innerText || n.textContent || n.value || n.alt || "").replace(/\\s+/g, " ").trim();
    }
    function roleMatch(n) {
      if (!role) return true;
      const ar = (n.getAttribute("role") || "").toLowerCase();
      if (ar === role) return true;
      const tags = roleTags[role];
      if (tags && tags.includes(n.tagName.toLowerCase())) {
        if (role === "link") return n.tagName.toLowerCase() === "a" && n.hasAttribute("href");
        return true;
      }
      return false;
    }
    let el = null;
    if (!sel.startsWith("@e")) {
      el = document.querySelector(sel);
    } else {
      if (name && role) {
        el = candidates.find((n) => labelOf(n) === name && roleMatch(n));
      }
      if (!el && name) {
        const exact = candidates.filter((n) => labelOf(n) === name && roleMatch(n));
        if (exact.length === 1) el = exact[0];
        else if (exact.length > 1 && preferInteractive) el = exact[0];
      }
      if (!el && name) {
        const exactAny = candidates.filter((n) => labelOf(n) === name);
        if (exactAny.length === 1) el = exactAny[0];
      }
      if (!el && name && name.length >= 2) {
        const hits = candidates.filter((n) => roleMatch(n) && labelOf(n).includes(name));
        if (hits.length === 1) el = hits[0];
        else if (hits.length > 1) {
          // Prefer shortest label (tightest match) among role-matched
          hits.sort((a, b) => labelOf(a).length - labelOf(b).length);
          el = hits[0];
        }
      }
    }
    return el;
  })()`;
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
    await cdp(client, "Input.dispatchKeyEvent", { type: "keyDown", ...base, text: info.text }, session);
    await cdp(client, "Input.dispatchKeyEvent", { type: "keyUp", ...base }, session);
    return { ok: true, key: info.key, mode: "cdp" };
  } catch (cdpErr) {
    const code = `(() => {
      const t = document.activeElement || document.body;
      const opts = {
        key: ${JSON.stringify(info.key)},
        code: ${JSON.stringify(info.code)},
        keyCode: ${info.keyCode},
        which: ${info.keyCode},
        bubbles: true,
        cancelable: true,
        altKey: ${info.alt},
        ctrlKey: ${info.ctrl},
        metaKey: ${info.meta},
        shiftKey: ${info.shift},
      };
      for (const type of ["keydown", "keypress", "keyup"]) {
        t.dispatchEvent(new KeyboardEvent(type, opts));
      }
      if (${JSON.stringify(info.key)} === "Enter" && t.form && typeof t.form.requestSubmit === "function") {
        try { t.form.requestSubmit(); } catch (_) {}
      }
      return JSON.stringify({ ok: true, key: ${JSON.stringify(info.key)}, target: t.tagName, mode: "dom", cdpError: ${JSON.stringify(String(cdpErr.message || cdpErr))} });
    })()`;
    return assertOk(await evaluateJson(client, code, session), "press_key");
  }
}

// ── Scroll ────────────────────────────────────────────────────

export async function scroll(client, { selector, direction, amount, x, y }, session) {
  if (selector && selector.startsWith("@e")) {
    const snap = unwrap(await client.command("snapshot", {}, { session }));
    const meta = findRefMeta(snap?.tree ?? snap, selector);
    if (!meta) throw new Error(`ref ${selector} not in snapshot; call wb_snapshot first`);
    const code = `(() => {
      const el = ${domResolveScript(meta, selector)};
      if (!el) return JSON.stringify({ ok: false, error: "could not map ref to unique DOM node", ref: ${JSON.stringify(selector)}, name: ${JSON.stringify(meta.name)}, role: ${JSON.stringify(meta.role)} });
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      return JSON.stringify({ ok: true, mode: "intoView", selector: ${JSON.stringify(selector)}, tag: el.tagName });
    })()`;
    return assertOk(await evaluateJson(client, code, session), "scroll");
  }

  const amt = Number(amount ?? 600);
  const dx = x != null ? Number(x) : direction === "left" ? -amt : direction === "right" ? amt : 0;
  const dy = y != null ? Number(y) : direction === "up" ? -amt : direction === "down" || !direction ? amt : 0;

  // 1) Multi-root DOM scroll (SPAs often don't move window.scrollY)
  const domResult = await evaluateJson(
    client,
    `(() => {
      const sel = ${JSON.stringify(selector || null)};
      const dx = ${dx};
      const dy = ${dy};
      if (sel) {
        const el = document.querySelector(sel);
        if (!el) return JSON.stringify({ ok: false, error: "element not found: " + sel });
        el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        return JSON.stringify({ ok: true, mode: "intoView", selector: sel, moved: true });
      }
      function collectRoots() {
        const list = [];
        const push = (el) => { if (el && !list.includes(el)) list.push(el); };
        push(document.scrollingElement);
        push(document.documentElement);
        push(document.body);
        for (const el of document.querySelectorAll("div,main,section,article,aside")) {
          try {
            const st = getComputedStyle(el);
            const oy = st.overflowY, ox = st.overflowX;
            const can = /auto|scroll|overlay/.test(oy) || /auto|scroll|overlay/.test(ox);
            const dy0 = el.scrollHeight - el.clientHeight;
            const dx0 = el.scrollWidth - el.clientWidth;
            if (can && (dy0 > 40 || dx0 > 40) && el.clientHeight > 80) list.push(el);
          } catch (_) {}
        }
        return list;
      }
      const roots = collectRoots();
      const attempts = [];
      let moved = false;
      for (const root of roots.slice(0, 25)) {
        const beforeY = root.scrollTop;
        const beforeX = root.scrollLeft;
        try {
          if (typeof root.scrollBy === "function") root.scrollBy({ left: dx, top: dy, behavior: "instant" });
          else { root.scrollTop = beforeY + dy; root.scrollLeft = beforeX + dx; }
        } catch (_) {
          root.scrollTop = beforeY + dy;
          root.scrollLeft = beforeX + dx;
        }
        const afterY = root.scrollTop;
        const afterX = root.scrollLeft;
        const did = afterY !== beforeY || afterX !== beforeX;
        attempts.push({
          root: root.tagName + (root.id ? "#" + root.id : ""),
          beforeY, afterY, did,
        });
        if (did) {
          moved = true;
          return JSON.stringify({
            ok: true, mode: "dom-root", moved: true, dx, dy,
            scrollTopBefore: beforeY, scrollTopAfter: afterY,
            root: root.tagName + (root.id ? "#" + root.id : ""),
          });
        }
      }
      window.scrollBy(dx, dy);
      return JSON.stringify({
        ok: true, mode: "window-fallback", moved: (window.scrollY || 0) !== 0, dx, dy,
        scrollY: window.scrollY, attempts: attempts.slice(0, 8),
      });
    })()`,
    session,
  );

  if (domResult?.moved) return assertOk(domResult, "scroll");

  // 2) CDP mouse wheel (works when page uses non-scrollTop virtual lists / listeners)
  try {
    const vp = await evaluateJson(
      client,
      `(() => JSON.stringify({ w: window.innerWidth||800, h: window.innerHeight||600 }))()`,
      session,
    );
    const cx = Math.floor((vp?.w || 800) / 2);
    const cy = Math.floor((vp?.h || 600) / 2);
    await cdp(
      client,
      "Input.dispatchMouseEvent",
      {
        type: "mouseWheel",
        x: cx,
        y: cy,
        deltaX: dx,
        deltaY: dy,
        modifiers: 0,
      },
      session,
    );
    await sleep(80);
    return {
      ok: true,
      mode: "cdp-wheel",
      moved: true,
      dx,
      dy,
      note: "DOM scrollTop did not change; used CDP mouseWheel",
      dom: domResult,
    };
  } catch (err) {
    if (domResult?.ok) return { ...domResult, moved: false, warning: "scroll may not have moved", cdpError: err.message };
    throw new ToolError("Scroll failed on this page layout", {
      code: "scroll_failed",
      detail: { dom: domResult, cdp: err.message },
      hint: "Try selector/@e scrollIntoView, or PageDown via wb_press_key. Some players intercept wheel.",
    });
  }
}

// ── Click with optional new-tab follow ────────────────────────

export async function clickSmart(client, selector, session, { followNewTab = true } = {}) {
  let beforeIds = new Set();
  let beforeById = new Map();
  let beforeHref = null;
  if (followNewTab) {
    try {
      const listed = unwrap(await client.command("list_tabs", {}, { session }));
      const beforeTabs = listed?.tabs || listed?.data?.tabs || [];
      beforeIds = new Set(beforeTabs.map((t) => t.tabId));
      beforeById = new Map(beforeTabs.map((t) => [t.tabId, t.url]));
    } catch {
      /* still click */
    }
    try {
      beforeHref = (
        await evaluateJson(
          client,
          `(() => JSON.stringify({ href: location.href }))()`,
          session,
        )
      )?.href;
    } catch {
      /* */
    }
  }

  const clickResult = unwrap(await client.command("click", { selector }, { session }));

  if (!followNewTab) {
    return { ok: true, click: clickResult, followedNewTab: false };
  }

  // Bilibili etc. may open tabs slightly async
  for (const waitMs of [400, 700, 1000]) {
    await sleep(waitMs);
    try {
      const listed = unwrap(await client.command("list_tabs", {}, { session }));
      const afterTabs = listed?.tabs || listed?.data?.tabs || [];
      const created = afterTabs.filter((t) => t.tabId != null && !beforeIds.has(t.tabId));
      const httpCreated = created.filter((t) => /^https?:/i.test(t.url || ""));
      const target = httpCreated[httpCreated.length - 1] || created[created.length - 1];
      if (target?.url && !/^about:|chrome:|edge:/i.test(target.url)) {
        const { findTabSmart } = await import("./tab-actions.js");
        const switched = await findTabSmart(client, { url: target.url, session });
        return {
          ok: true,
          click: clickResult,
          followedNewTab: true,
          newTab: { tabId: target.tabId, url: target.url, title: target.title },
          findTab: switched,
        };
      }
      // Same tabId but URL navigated (SPA or full navigation)
      for (const t of afterTabs) {
        const prev = beforeById.get(t.tabId);
        if (prev && t.url && t.url !== prev && /^https?:/i.test(t.url)) {
          const { findTabSmart } = await import("./tab-actions.js");
          await findTabSmart(client, { url: t.url, session });
          return {
            ok: true,
            click: clickResult,
            followedNewTab: false,
            navigatedSameTab: true,
            url: t.url,
          };
        }
      }
      const now = await evaluateJson(
        client,
        `(() => JSON.stringify({ href: location.href }))()`,
        session,
      );
      if (beforeHref && now?.href && now.href !== beforeHref) {
        return {
          ok: true,
          click: clickResult,
          followedNewTab: false,
          navigatedSameTab: true,
          url: now.href,
        };
      }
    } catch (err) {
      if (waitMs >= 1000) {
        return {
          ok: true,
          click: clickResult,
          followedNewTab: false,
          followError: err.message,
          hint: "Click ok; use wb_list_tabs + wb_find_tab if a new tab opened.",
        };
      }
    }
  }

  // New tab may be outside session group (Bilibili often does this) — borrow browser active tab
  try {
    const { findTabSmart } = await import("./tab-actions.js");
    const borrowed = await findTabSmart(client, { active: true, session });
    const url =
      borrowed?.data?.url ||
      borrowed?.url ||
      borrowed?.resolvedUrl ||
      null;
    if (url && beforeHref && url.split("?")[0] !== beforeHref.split("?")[0]) {
      return {
        ok: true,
        click: clickResult,
        followedNewTab: true,
        borrowedActive: true,
        url,
        findTab: borrowed,
      };
    }
  } catch {
    /* ignore */
  }

  return { ok: true, click: clickResult, followedNewTab: false };
}

// ── Wait ──────────────────────────────────────────────────────

export async function waitFor(client, { text, selector, timeoutMs = 15000, intervalMs = 400 }, session) {
  const deadline = Date.now() + Math.max(500, timeoutMs);
  const interval = Math.max(100, intervalMs);
  let last = null;
  const started = Date.now();

  while (Date.now() < deadline) {
    const code = `(() => {
      const text = ${JSON.stringify(text || null)};
      const selector = ${JSON.stringify(selector || null)};
      if (selector) {
        const el = document.querySelector(selector);
        if (el) return JSON.stringify({ ok: true, found: "selector", selector });
      }
      if (text) {
        const body = document.body ? (document.body.innerText || "") : "";
        if (body.includes(text)) return JSON.stringify({ ok: true, found: "text", text });
      }
      if (!text && !selector) {
        if (document.readyState === "complete" || document.readyState === "interactive") {
          return JSON.stringify({ ok: true, found: "ready", readyState: document.readyState });
        }
      }
      const body = document.body ? (document.body.innerText || "").slice(0, 200) : "";
      return JSON.stringify({
        ok: false,
        readyState: document.readyState,
        title: document.title,
        href: location.href,
        bodyPreview: body,
      });
    })()`;
    last = await evaluateJson(client, code, session);
    if (last && last.ok) {
      return { ...last, waitedMs: Date.now() - started };
    }
    await sleep(interval);
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
      return { ok: true, action: "back", from: before?.href, href: after.href, readyState: after.readyState };
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
      return { ok: true, action: "forward", from: before?.href, href: after.href, readyState: after.readyState };
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
      return { ok: true, action: "reload", hard: true, mode: "cdp" };
    } catch {
      // fall through
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
  return { ok: true, action: "reload", hard: Boolean(hard), mode: "location" };
}

// ── Hover / dblclick ──────────────────────────────────────────

export async function hoverSmart(client, selector, session) {
  let meta = null;
  if (selector.startsWith("@e")) {
    const snap = unwrap(await client.command("snapshot", {}, { session }));
    meta = findRefMeta(snap?.tree ?? snap, selector);
    if (!meta) throw new Error(`ref ${selector} not found in snapshot; call wb_snapshot first`);
  }

  const code = `(() => {
    const el = ${selector.startsWith("@e") ? domResolveScript(meta, selector) : `document.querySelector(${JSON.stringify(selector)})`};
    if (!el) return JSON.stringify({ ok: false, error: "element not found for hover", selector: ${JSON.stringify(selector)}, name: ${JSON.stringify(meta?.name || "")}, role: ${JSON.stringify(meta?.role || "")} });
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    for (const type of ["mouseover", "mouseenter", "mousemove"]) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, view: window }));
    }
    return JSON.stringify({ ok: true, selector: ${JSON.stringify(selector)}, tag: el.tagName, x, y });
  })()`;
  return assertOk(await evaluateJson(client, code, session), "hover");
}

export async function dblclick(client, selector, session) {
  // Prefer real dblclick via evaluate after resolving; for @e use daemon click path for resolution then DOM dblclick
  if (selector.startsWith("@e")) {
    // Focus/resolve via single click is risky (navigation). Use snapshot meta + DOM dblclick.
    const snap = unwrap(await client.command("snapshot", {}, { session }));
    const meta = findRefMeta(snap?.tree ?? snap, selector);
    if (!meta) throw new Error(`ref ${selector} not in snapshot`);
    const code = `(() => {
      const el = ${domResolveScript(meta, selector)};
      if (!el) return JSON.stringify({ ok: false, error: "could not map ref for dblclick", ref: ${JSON.stringify(selector)} });
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, detail: 2 };
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", { ...opts, detail: 1 }));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
      el.dispatchEvent(new MouseEvent("dblclick", opts));
      return JSON.stringify({ ok: true, mode: "dom-dblclick", selector: ${JSON.stringify(selector)}, tag: el.tagName });
    })()`;
    return assertOk(await evaluateJson(client, code, session), "dblclick");
  }

  const code = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ ok: false, error: "element not found", selector: ${JSON.stringify(selector)} });
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, detail: 2 };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", { ...opts, detail: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    el.dispatchEvent(new MouseEvent("dblclick", opts));
    return JSON.stringify({ ok: true, mode: "dom-dblclick", selector: ${JSON.stringify(selector)}, tag: el.tagName });
  })()`;
  return assertOk(await evaluateJson(client, code, session), "dblclick");
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
        await client.command("fill", { selector: field.selector, value: String(field.value) }, { session }),
      );
      results.push({ selector: field.selector, ok: true, result: r });
    } catch (err) {
      results.push({ selector: field.selector, ok: false, error: err.message || String(err) });
    }
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      JSON.stringify({
        ok: false,
        filled: results.length - failed.length,
        total: results.length,
        results,
      }),
    );
  }
  return {
    ok: true,
    filled: results.length,
    total: results.length,
    results,
  };
}
