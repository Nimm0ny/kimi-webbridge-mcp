/**
 * Higher-level page actions built on WebBridge evaluate / cdp / snapshot.
 * Aligns kimi-webbridge-mcp with Claude-in-Chrome style convenience tools.
 */

export function unwrap(result) {
  if (result && typeof result === "object" && "data" in result && result.data !== undefined) {
    return result.data;
  }
  return result;
}

export async function evaluateRaw(client, code, session) {
  return unwrap(await client.command("evaluate", { code }, { session }));
}

/** Evaluate and JSON.parse string results when possible. */
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

export function walkSnapshot(nodes, visit) {
  if (!nodes) return;
  const list = Array.isArray(nodes) ? nodes : [nodes];
  for (const node of list) {
    if (!node || typeof node !== "object") continue;
    visit(node);
    if (node.children?.length) walkSnapshot(node.children, visit);
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
    if (roleFilter && nodeRole.toLowerCase() !== roleFilter) return;
    if (q) {
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
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
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
  Space: { key: " ", code: "Space", keyCode: 32 },
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
      ...mods,
    };
  }
  return { key: keyPart, code: keyPart, keyCode: 0, ...mods };
}

export async function pressKey(client, keyStr, session) {
  const info = parseKeyCombo(keyStr);
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
    return JSON.stringify({ ok: true, key: ${JSON.stringify(info.key)}, target: t.tagName });
  })()`;
  return evaluateJson(client, code, session);
}

// ── Scroll ────────────────────────────────────────────────────

export async function scroll(client, { selector, direction, amount, x, y }, session) {
  // @e: resolve via snapshot meta → DOM heuristic
  if (selector && selector.startsWith("@e")) {
    const snap = unwrap(await client.command("snapshot", {}, { session }));
    const meta = findRefMeta(snap?.tree ?? snap, selector);
    if (!meta) return { ok: false, error: `ref ${selector} not in snapshot` };
    const code = `(() => {
      const name = ${JSON.stringify(meta.name)};
      const candidates = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role],[tabindex],summary,label,h1,h2,h3,p,div,span,li"));
      let el = name
        ? candidates.find((n) => (n.innerText || n.textContent || n.getAttribute("aria-label") || "").trim() === name.trim())
          || candidates.find((n) => (n.innerText || n.textContent || "").includes(name.trim()))
        : null;
      if (!el) return JSON.stringify({ ok: false, error: "could not map ref to DOM", ref: ${JSON.stringify(selector)} });
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      return JSON.stringify({ ok: true, mode: "intoView", selector: ${JSON.stringify(selector)}, tag: el.tagName });
    })()`;
    return evaluateJson(client, code, session);
  }

  const code = `(() => {
    const sel = ${JSON.stringify(selector || null)};
    const direction = ${JSON.stringify(direction || null)};
    const amount = ${Number(amount ?? 600)};
    const x = ${x == null ? "null" : Number(x)};
    const y = ${y == null ? "null" : Number(y)};
    if (sel) {
      const el = document.querySelector(sel);
      if (!el) return JSON.stringify({ ok: false, error: "element not found: " + sel });
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      return JSON.stringify({ ok: true, mode: "intoView", selector: sel });
    }
    if (x != null || y != null) {
      window.scrollBy(x || 0, y || 0);
      return JSON.stringify({ ok: true, mode: "by", x: x || 0, y: y || 0, scrollY: window.scrollY });
    }
    const map = { up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0] };
    const delta = map[direction] || [0, amount];
    window.scrollBy(delta[0], delta[1]);
    return JSON.stringify({
      ok: true,
      mode: "direction",
      direction: direction || "down",
      amount,
      scrollY: window.scrollY,
    });
  })()`;
  return evaluateJson(client, code, session);
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
        return JSON.stringify({ ok: true, found: "ready", readyState: document.readyState });
      }
      return JSON.stringify({ ok: false, readyState: document.readyState, title: document.title });
    })()`;
    last = await evaluateJson(client, code, session);
    if (last && last.ok) {
      return { ...last, waitedMs: Date.now() - started };
    }
    await sleep(interval);
  }
  return { ok: false, error: "timeout", timeoutMs, waitedMs: Date.now() - started, last };
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
    return JSON.stringify({ title, url, text, length: text.length, truncated });
  })()`;
  return evaluateJson(client, code, session);
}

// ── Navigation helpers ────────────────────────────────────────

export async function goBack(client, session) {
  return evaluateJson(
    client,
    `(() => { history.back(); return JSON.stringify({ ok: true, action: "back", href: location.href }); })()`,
    session,
  );
}

export async function goForward(client, session) {
  return evaluateJson(
    client,
    `(() => { history.forward(); return JSON.stringify({ ok: true, action: "forward", href: location.href }); })()`,
    session,
  );
}

export async function reload(client, { hard = false } = {}, session) {
  if (hard) {
    try {
      await cdp(client, "Page.reload", { ignoreCache: true }, session);
      return { ok: true, action: "reload", hard: true };
    } catch {
      // fall through to location.reload
    }
  }
  return evaluateJson(
    client,
    `(() => { location.reload(); return JSON.stringify({ ok: true, action: "reload", hard: false }); })()`,
    session,
  );
}

// ── Hover / dblclick ──────────────────────────────────────────

async function dispatchHoverOnMatched(client, meta, selector, session) {
  const code = `(() => {
    const name = ${JSON.stringify(meta?.name || "")};
    const sel = ${JSON.stringify(selector)};
    let el = null;
    if (!sel.startsWith("@e")) {
      el = document.querySelector(sel);
    } else if (name) {
      const candidates = Array.from(document.querySelectorAll(
        "a,button,input,textarea,select,[role],[tabindex],summary,label,[onclick]"
      ));
      el = candidates.find((n) => (n.innerText || n.textContent || n.getAttribute("aria-label") || n.value || "").trim() === name.trim())
        || candidates.find((n) => (n.innerText || n.textContent || "").includes(name.trim()));
    }
    if (!el) return JSON.stringify({ ok: false, error: "element not found for hover", selector: sel, name });
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    for (const type of ["mouseover", "mouseenter", "mousemove"]) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, view: window }));
    }
    return JSON.stringify({ ok: true, selector: sel, tag: el.tagName, x, y });
  })()`;
  return evaluateJson(client, code, session);
}

export async function hoverSmart(client, selector, session) {
  if (selector.startsWith("@e")) {
    const snap = unwrap(await client.command("snapshot", {}, { session }));
    const meta = findRefMeta(snap?.tree ?? snap, selector);
    if (!meta) {
      return { ok: false, error: `ref ${selector} not found in snapshot; call wb_snapshot first` };
    }
    return dispatchHoverOnMatched(client, meta, selector, session);
  }
  return dispatchHoverOnMatched(client, null, selector, session);
}

export async function dblclick(client, selector, session) {
  const first = unwrap(await client.command("click", { selector }, { session }));
  await sleep(50);
  const second = unwrap(await client.command("click", { selector }, { session }));
  return { ok: true, mode: "double-click", selector, first, second };
}

// ── Console capture ───────────────────────────────────────────

const CONSOLE_INSTALL = `(() => {
  if (window.__wbConsoleInstalled) {
    return JSON.stringify({ ok: true, already: true, count: window.__wbConsoleBuf.length });
  }
  window.__wbConsoleBuf = [];
  window.__wbConsoleInstalled = true;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[level].bind(console);
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
      return orig(...args);
    };
  }
  window.addEventListener("error", (e) => {
    window.__wbConsoleBuf.push({
      level: "pageerror",
      time: Date.now(),
      args: [String(e.message), String(e.filename || ""), e.lineno || 0],
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    window.__wbConsoleBuf.push({
      level: "unhandledrejection",
      time: Date.now(),
      args: [String(e.reason)],
    });
  });
  return JSON.stringify({ ok: true, already: false, count: 0 });
})()`;

export async function consoleCmd(client, cmd, session) {
  if (cmd === "start") return evaluateJson(client, CONSOLE_INSTALL, session);
  if (cmd === "list") {
    return evaluateJson(
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
  }
  if (cmd === "clear") {
    return evaluateJson(
      client,
      `(() => {
        if (!window.__wbConsoleInstalled) return JSON.stringify({ ok: true, cleared: false, installed: false });
        window.__wbConsoleBuf = [];
        return JSON.stringify({ ok: true, cleared: true });
      })()`,
      session,
    );
  }
  if (cmd === "stop") {
    return evaluateJson(
      client,
      `(() => {
        const count = window.__wbConsoleBuf ? window.__wbConsoleBuf.length : 0;
        return JSON.stringify({
          ok: true,
          stopped: true,
          note: "interceptor remains for page lifetime; use clear to empty buffer",
          count,
        });
      })()`,
      session,
    );
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
  return {
    ok: results.every((r) => r.ok),
    filled: results.filter((r) => r.ok).length,
    total: results.length,
    results,
  };
}
