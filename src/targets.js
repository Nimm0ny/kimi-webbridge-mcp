import { randomUUID } from "node:crypto";
import { ToolError } from "./errors.js";
import { unwrap, walkSnapshot, sleep } from "./page-actions.js";

const snapshots = new WeakMap();
const runtimeKey = `__wbTargets_${randomUUID()}`;

// Runs in the page's evaluate world. Handles retain actual nodes, so a re-render
// cannot silently redirect an operation to a different same-named element.
export function targetRuntime(key, request) {
  const state = globalThis[key] ||= { document, id: [...crypto.getRandomValues(new Uint32Array(4))].join("-"), nodes: new Map() };
  const fail = (code, detail) => ({ ok: false, code, detail });
  const text = s => String(s || "").replace(/\s+/g, " ").trim();
  function role(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      if (["button", "submit", "reset", "image"].includes(el.type)) return "button";
      if (["checkbox", "radio"].includes(el.type)) return el.type;
      if (el.type === "search") return "searchbox";
      if (["text", "email", "tel", "url", "password"].includes(el.type)) return "textbox";
      return "";
    }
    if (tag === "a") return el.hasAttribute("href") ? "link" : "";
    if (tag === "select") return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    return ({ button: "button", textarea: "textbox", img: "img", summary: "button" })[tag] || "";
  }
  function name(el) {
    const ids = el.getAttribute("aria-labelledby");
    if (ids) {
      const labelled = text(ids.split(/\s+/).map(id => el.getRootNode().getElementById?.(id)?.textContent || "").join(" "));
      if (labelled) return labelled;
    }
    if (el.hasAttribute("aria-label")) return text(el.getAttribute("aria-label"));
    if (el.labels?.length) return text([...el.labels].map(l => l.textContent).join(" "));
    if (el.tagName === "IMG") return text(el.alt);
    if (el.tagName === "INPUT") return role(el) === "button" ? text(el.value || el.alt) : text(el.placeholder || el.title);
    return text(el.innerText || el.textContent || el.title);
  }
  function query(root, selector) {
    const found = [...root.querySelectorAll(selector)];
    if (root.shadowRoot) found.push(...query(root.shadowRoot, selector));
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) found.push(...query(el.shadowRoot, selector));
    }
    return found;
  }
  function resolve(target) {
    let root = document;
    if (target.within) {
      const roots = query(root, target.within);
      if (roots.length !== 1) return fail(roots.length ? "ambiguous_target" : "element_not_found", { scope: target.within, count: roots.length });
      root = roots[0];
    }
    let elements = query(root, target.css || "*");
    if (target.role) elements = elements.filter(el => role(el) === target.role);
    if (target.name != null) elements = elements.filter(el => target.exact === false ? name(el).includes(text(target.name)) : name(el) === text(target.name));
    if (elements.length !== 1) return fail(elements.length ? "ambiguous_target" : "element_not_found", {
      count: elements.length, candidates: elements.slice(0, 8).map(el => ({ role: role(el), name: name(el), tag: el.tagName, id: el.id })),
    });
    return elements[0];
  }
  try {
    if (request.op === "bindMany") return request.items.map(item => targetRuntime(key, { ...item, op: "bind", documentId: request.documentId }));
    if (request.op === "releaseMany") { request.handles.forEach(handle => state.nodes.delete(handle)); return { ok: true }; }
    if (request.op === "context") return { ok: true, documentId: state.id, href: location.href };
    if (request.documentId && request.documentId !== state.id) return fail("stale_target", "Document changed; take a new snapshot.");
    if (request.op === "release") { state.nodes.delete(request.handle); return { ok: true }; }
    let el = request.handle ? state.nodes.get(request.handle) : resolve(request.target);
    if (el?.ok === false) return el;
    if (!el?.isConnected) return fail("stale_target", "Element detached; inspect the page again.");
    if (request.op === "bind") {
      state.nodes.set(request.newHandle, el);
      if (state.nodes.size > 1000) state.nodes.delete(state.nodes.keys().next().value);
      return { ok: true, handle: request.newHandle, documentId: state.id, role: role(el), name: name(el) };
    }
    if (request.op === "scroll") el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (request.op === "focus") {
      el.focus();
      let focused = document.activeElement;
      while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
      if (focused !== el) return fail("focus_failed");
      if (request.replace) {
        if (typeof el.select === "function") el.select();
        else if (el.isContentEditable) {
          const range = document.createRange(); range.selectNodeContents(el);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        } else return fail("not_editable");
      }
    }
    if (request.op === "select") {
      if (el.tagName !== "SELECT") return fail("unsupported_target", "Use select on a native select element.");
      const values = request.values;
      if (!el.multiple && values.length !== 1) return fail("invalid_selection");
      const opts = [...el.options];
      if (values.some(v => !opts.some(o => o.value === v && !o.disabled && !o.closest("optgroup[disabled]")))) return fail("option_not_found");
      opts.forEach(o => { o.selected = values.includes(o.value); });
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (request.op === "domClick") {
      // Selected before any input, never a retry after uncertain CDP dispatch.
      el.click();
      if (request.double && el.isConnected) {
        el.click();
        el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2, view: window }));
      }
      return { ok: true, dispatched: true };
    }
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible = r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.visibility !== "collapse";
    const x = (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2;
    const y = (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2;
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    let hitOwner = hit;
    while (hitOwner && hitOwner !== el && !el.contains(hitOwner)) hitOwner = hitOwner.getRootNode()?.host;
    const enabled = !el.matches(":disabled") && !el.closest('[aria-disabled="true"],[inert]');
    return {
      ok: true, documentId: state.id, role: role(el), name: name(el), tag: el.tagName,
      visible, enabled, pageVisibility: document.visibilityState, hovered: el.matches(":hover"),
      editable: (el.isContentEditable || el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && ["text", "search", "email", "tel", "url", "password", "number"].includes(el.type))) && !el.readOnly && enabled,
      receivesEvents: Boolean(hitOwner) && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight,
      x, y, rect: [r.x, r.y, r.width, r.height],
      value: el.isContentEditable ? el.textContent : el.value,
      checked: typeof el.checked === "boolean" ? el.checked : el.getAttribute("aria-checked"),
      values: el.tagName === "SELECT" ? [...el.selectedOptions].map(o => o.value) : undefined,
    };
  } catch (err) { return fail("target_error", err.message); }
}

export async function runTarget(client, request, session, timeoutMs) {
  const code = `JSON.stringify((${targetRuntime.toString()})(${JSON.stringify(runtimeKey)},${JSON.stringify(request)}))`;
  // Pass the remaining operation budget down to HTTP, not just the polling loop.
  const raw = unwrap(await client.command("evaluate", { code }, { session, timeoutMs }));
  const value = raw?.value !== undefined ? raw.value : raw;
  return typeof value === "string" ? JSON.parse(value) : value;
}

function checked(result) {
  if (!result?.ok) throw new ToolError("Target could not be resolved or operated", {
    code: result?.code || "target_error", detail: result?.detail,
    hint: "Inspect wb_snapshot; use a unique CSS selector or role/name with within. Do not guess among candidates.",
  });
  return result;
}

export async function snapshotWithTargets(client, session) {
  const before = checked(await runTarget(client, { op: "context" }, session));
  const raw = await client.command("snapshot", {}, { session });
  const snap = unwrap(raw);
  const context = checked(await runTarget(client, { op: "context" }, session));
  if (before.documentId !== context.documentId || before.href !== context.href) throw new ToolError("Page changed while taking snapshot", { code: "stale_snapshot" });
  const refs = new Map();
  walkSnapshot(snap?.tree ?? snap, node => { if (node.ref) refs.set(node.ref, { role: node.role, name: node.name }); });
  // Bind refs now, never reinterpret them against a later regenerated snapshot.
  const snapshotId = randomUUID();
  const entries = [...refs].slice(0, 300);
  for (const [ref] of [...refs].slice(300)) refs.set(ref, { error: "snapshot_ref_limit" });
  const bindings = await runTarget(client, { op: "bindMany", documentId: context.documentId,
    items: entries.map(([, meta]) => ({ target: meta.role && meta.name ? { ...meta, exact: true } : { css: ":not(*)" }, newHandle: randomUUID() })) }, session);
  entries.forEach(([ref], i) => { const bound = bindings[i]; refs.set(ref, bound?.ok ? bound : { error: bound?.code, detail: bound?.detail }); });
  let sessions = snapshots.get(client);
  if (!sessions) snapshots.set(client, sessions = new Map());
  const sessionKey = client.resolveSession(session);
  const previous = sessions.get(sessionKey);
  if (previous?.documentId === context.documentId) {
    await runTarget(client, { op: "releaseMany", handles: [...previous.refs.values()].map(item => item.handle).filter(Boolean) }, session);
  }
  sessions.set(sessionKey, { snapshotId, documentId: context.documentId, refs });
  return { ...snap, snapshotId, documentId: context.documentId,
    unresolvedRefs: [...refs].filter(([, value]) => value.error).map(([ref, value]) => ({ ref, code: value.error })),
    refPolicy: "bound_nodes; ambiguous refs require scoped CSS/role target" };
}

export async function bindTarget(client, input, session, timeoutMs) {
  const target = typeof input === "string" ? { css: input } : input;
  if (!target || (!target.css && !target.role && target.name == null && !target.ref)) throw new ToolError("Target is required", { code: "target_args" });
  const ref = target.ref || (target.css?.startsWith("@e") ? target.css : null);
  if (ref) {
    const snapshot = snapshots.get(client)?.get(client.resolveSession(session));
    if (!snapshot || (target.snapshotId && target.snapshotId !== snapshot.snapshotId)) throw new ToolError("Snapshot reference expired or missing", { code: "stale_snapshot", hint: "Call wb_snapshot or wb_find again." });
    const saved = snapshot.refs.get(ref);
    if (!saved || saved.error) throw new ToolError("Reference cannot be mapped uniquely", { code: saved?.error || "stale_target", detail: saved?.detail, hint: "Use a scoped CSS or role/name target." });
    checked(await runTarget(client, { op: "inspect", handle: saved.handle, documentId: saved.documentId }, session, timeoutMs));
    return { ...saved, retained: true };
  }
  return checked(await runTarget(client, { op: "bind", target, newHandle: randomUUID() }, session, timeoutMs));
}

export async function prepareTarget(client, input, session, { timeoutMs = 10000, editable = false, pointer = true, requireEnabled = true } = {}) {
  const deadline = Date.now() + timeoutMs;
  let bound, last, previous;
  while (Date.now() < deadline) {
    try {
      bound ||= await bindTarget(client, input, session, Math.max(1, deadline - Date.now()));
      last = checked(await runTarget(client, { op: "scroll", handle: bound.handle, documentId: bound.documentId }, session, Math.max(1, deadline - Date.now())));
      const stable = previous && last.rect.every((n, i) => Math.abs(n - previous.rect[i]) < 0.5);
      if (last.visible && (!requireEnabled || last.enabled) && (!editable || last.editable) && (!pointer || last.receivesEvents) && stable) return { ...bound, ...last };
      previous = last;
    } catch (err) {
      if (!["element_not_found", "stale_target"].includes(err.code)) throw err;
      // Stale refs must never be rebound; semantic/CSS locators may retry before input.
      if (bound?.retained || String(typeof input === "string" ? input : input?.ref || input?.css).startsWith("@e")) throw err;
      if (bound) await runTarget(client, { op: "release", handle: bound.handle }, session, Math.max(1, deadline - Date.now())).catch(() => {});
      bound = previous = null;
      last = { code: err.code };
    }
    await sleep(Math.min(60, Math.max(0, deadline - Date.now())));
  }
  if (bound && !bound.retained) await runTarget(client, { op: "release", handle: bound.handle }, session, 500).catch(() => {});
  throw new ToolError("Target did not become actionable", { code: "actionability_timeout", detail: last && { code: last.code, role: last.role, name: last.name, visible: last.visible, enabled: last.enabled, editable: last.editable, receivesEvents: last.receivesEvents, rect: last.rect }, hint: "Inspect visibility, overlays, disabled state and the target selector." });
}

export async function interact(client, action, input, options = {}, session) {
  const deadline = Date.now() + (options.timeoutMs ?? 10000);
  const remaining = () => Math.max(1, deadline - Date.now());
  const bound = await prepareTarget(client, input, session, { timeoutMs: remaining(), editable: action === "fill" || action === "type", pointer: action !== "select" });
  const request = op => ({ op, handle: bound.handle, documentId: bound.documentId });
  let dispatched = false;
  let mode = action === "select" ? "dom-select" : "cdp";
  const command = async (method, params) => {
    dispatched = true;
    return client.command("cdp", { method, params }, { session, timeoutMs: remaining() });
  };
  try {
    const mouse = (type, extra = {}) => command("Input.dispatchMouseEvent", { type, x: bound.x, y: bound.y, ...extra });
    if (action === "hover") await mouse("mouseMoved");
    else if (action === "fill" || action === "type") {
      checked(await runTarget(client, { ...request("focus"), replace: action === "fill" }, session, remaining()));
      if (options.value === "" && action === "fill") {
        await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
        await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      } else await command("Input.insertText", { text: options.value });
    } else if (action === "select") {
      dispatched = true;
      checked(await runTarget(client, { ...request("select"), values: options.values }, session, remaining()));
    } else {
      if (action === "check" && !["checkbox", "radio"].includes(bound.role)) throw new ToolError("Check requires checkbox/radio", { code: "unsupported_target" });
      const alreadyChecked = bound.checked === true || bound.checked === "true";
      if (action === "check" && bound.role === "radio" && !options.checked && alreadyChecked) throw new ToolError("Select another radio to uncheck it", { code: "unsupported_target" });
      if (action !== "check" || alreadyChecked !== options.checked) {
        const dom = options.inputMode === "dom" || ((options.inputMode ?? "auto") === "auto" && bound.pageVisibility === "hidden");
        if (bound.pageVisibility === "hidden" && !dom) throw new ToolError("Trusted pointer input requires a visible tab", { code: "tab_not_visible", hint: "Bring the tab to the foreground, or explicitly use inputMode=dom for DOM controls." });
        const button = options.button || "left";
        if (dom && button !== "left") throw new ToolError("Right/middle click requires visible CDP input", { code: "unsupported_input_mode" });
        if (dom) {
          mode = "dom";
          dispatched = true;
          checked(await runTarget(client, { ...request("domClick"), double: action === "dblclick" }, session, remaining()));
        } else {
        const buttons = button === "right" ? 2 : button === "middle" ? 4 : 1;
        await mouse("mouseMoved");
        const current = checked(await runTarget(client, request("inspect"), session, remaining()));
        if (!current.receivesEvents || current.rect.some((n, i) => Math.abs(n - bound.rect[i]) > 0.5)) throw new ToolError("Target moved or became covered after hover", { code: "target_changed", hint: "Inspect the new layout before retrying." });
        for (let count = 1; count <= (action === "dblclick" ? 2 : 1); count++) {
          try { await mouse("mousePressed", { button, buttons, clickCount: count }); }
          finally { await mouse("mouseReleased", { button, buttons: 0, clickCount: count }); }
        }
        }
      }
    }
    const needsValue = ["fill", "check", "select"].includes(action);
    let verified = false, observed;
    while (needsValue && Date.now() < deadline) {
      observed = checked(await runTarget(client, request("inspect"), session, remaining()));
      verified = action === "fill" ? observed.value === options.value : action === "check" ? (observed.checked === true || observed.checked === "true") === options.checked : JSON.stringify([...observed.values].sort()) === JSON.stringify([...new Set(options.values)].sort());
      if (verified) break;
      await sleep(Math.min(60, remaining()));
    }
    if (needsValue && !verified) throw new ToolError("Action result did not match requested state", { code: "verification_failed", detail: { action, outcome: "unknown" } });
    return { ok: true, action, mode, dispatched, verified, outcome: verified ? "verified" : "dispatched",
      note: mode === "dom" ? "DOM input selected before dispatch; events are synthetic. Use inputMode=cdp on a visible tab for trusted pointer input." : undefined,
      target: { role: bound.role, name: bound.name, documentId: bound.documentId } };
  } catch (err) {
    if (dispatched && !(err instanceof ToolError)) throw new ToolError("Input failed after dispatch began", { code: "outcome_unknown", detail: { action, error: err.message }, hint: "Inspect the page before retrying." });
    throw err;
  } finally {
    if (!bound.retained) await runTarget(client, { op: "release", handle: bound.handle }, session, 500).catch(() => {});
  }
}

export async function drag(client, source, destination, options = {}, session) {
  const deadline = Date.now() + (options.timeoutMs ?? 10000);
  const remaining = () => Math.max(1, deadline - Date.now());
  const from = await prepareTarget(client, source, session, { timeoutMs: remaining() });
  let to, pressed = false;
  let lastPoint;
  const mouse = (type, point, extra = {}) => client.command("cdp", {
    method: "Input.dispatchMouseEvent", params: { type, x: point.x, y: point.y, ...extra },
  }, { session, timeoutMs: remaining() });
  try {
    to = await prepareTarget(client, destination, session, { timeoutMs: remaining() });
    if (from.pageVisibility !== "visible" || to.pageVisibility !== "visible") throw new ToolError("Pointer drag requires a visible tab", { code: "tab_not_visible" });
    const current = checked(await runTarget(client, { op: "inspect", handle: from.handle, documentId: from.documentId }, session, remaining()));
    if (!current.visible || !current.receivesEvents) throw new ToolError("Drag endpoints must be visible together", { code: "drag_not_visible" });
    lastPoint = current;
    await mouse("mouseMoved", current);
    pressed = true;
    await mouse("mousePressed", current, { button: "left", buttons: 1, clickCount: 1 });
    const steps = options.steps ?? 12;
    for (let i = 1; i <= steps; i++) {
      if (Date.now() >= deadline) throw new Error("Drag timeout");
      lastPoint = { x: current.x + (to.x - current.x) * i / steps, y: current.y + (to.y - current.y) * i / steps };
      await mouse("mouseMoved", lastPoint, { button: "left", buttons: 1 });
    }
    return { ok: true, action: "drag", mode: "cdp", verified: false, outcome: "dispatched" };
  } catch (err) {
    if (pressed) throw new ToolError("Drag outcome unknown", { code: "outcome_unknown", detail: err.message, hint: "Inspect both endpoints before retrying." });
    throw err;
  } finally {
    try {
      if (pressed) await mouse("mouseReleased", lastPoint, { button: "left", buttons: 0, clickCount: 1 });
    } finally {
      for (const bound of [from, to]) if (bound && !bound.retained) await runTarget(client, { op: "release", handle: bound.handle }, session, 500).catch(() => {});
    }
  }
}
