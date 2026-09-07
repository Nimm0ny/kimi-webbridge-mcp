import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { interact, snapshotWithTargets, drag } from "../src/targets.js";
import { pressKey, scroll, waitFor, fillForm, clickSmart } from "../src/page-actions.js";

let browser, context, page, cdpSession, client, commands;
before(async () => { browser = await chromium.launch({ channel: process.env.WB_TEST_BROWSER || "chrome", headless: true }); });
after(async () => { await browser?.close(); });
beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  page = await context.newPage();
  cdpSession = await context.newCDPSession(page);
  commands = [];
  client = {
    resolveSession: s => s || "test",
    command: async (action, args) => {
      commands.push({ action, args });
      if (action === "evaluate") return { data: { value: await page.evaluate(args.code) } };
      if (action === "cdp") return { data: await cdpSession.send(args.method, args.params) };
      if (action === "snapshot") return { data: { tree: [{ ref: "@e1", role: "button", name: "Save" }] } };
      if (action === "list_tabs") return { data: { tabs: [{ tabId: 1, url: page.url() }] } };
      throw new Error(`Unexpected action ${action}`);
    },
  };
});
afterEach(async () => { await context?.close(); });

test("duplicate names fail without clicking; scoped semantic target clicks correct button", async () => {
  await page.setContent('<div id="a"><button>Save</button></div><div id="b"><button onclick="this.textContent=\'Saved\'">Save</button></div>');
  await assert.rejects(interact(client, "click", { role: "button", name: "Save" }, {}, "test"), e => e.code === "ambiguous_target");
  assert.equal(commands.filter(c => c.action === "cdp").length, 0);
  await interact(client, "click", { role: "button", name: "Save", within: "#b" }, {}, "test");
  assert.equal(await page.locator("#a button").innerText(), "Save");
  assert.equal(await page.locator("#b button").innerText(), "Saved");
});

test("overlay blocks pointer input; delayed enable waits", async () => {
  await page.setContent('<button id="b" disabled>Save</button><div id="cover" style="position:fixed;inset:0;background:white"></div>');
  await assert.rejects(interact(client, "click", "#b", { timeoutMs: 180 }, "test"), e => e.code === "actionability_timeout");
  assert.equal(commands.filter(c => c.action === "cdp").length, 0);
  await page.evaluate(() => setTimeout(() => { document.querySelector("#cover").remove(); document.querySelector("#b").disabled = false; }, 100));
  await interact(client, "click", "#b", { timeoutMs: 1500 }, "test");
});

test("CDP hover changes CSS hover; double click events are trusted", async () => {
  await page.setContent('<style>#b:hover { background:rgb(255,0,0) }</style><button id="b" ondblclick="this.dataset.trusted=event.isTrusted">Save</button>');
  await interact(client, "hover", "#b", {}, "test");
  assert.equal(await page.locator("#b").evaluate(el => getComputedStyle(el).backgroundColor), "rgb(255, 0, 0)");
  await interact(client, "dblclick", "#b", {}, "test");
  assert.equal(await page.locator("#b").getAttribute("data-trusted"), "true");
});

test("fill and empty fill use browser input and verify values", async () => {
  await page.setContent('<label for="i">姓名</label><input id="i" value="old" oninput="this.dataset.trusted=event.isTrusted">');
  const result = await interact(client, "fill", { role: "textbox", name: "姓名" }, { value: "中文 abc" }, "test");
  assert.equal(result.verified, true);
  assert.equal(await page.locator("#i").inputValue(), "中文 abc");
  assert.equal(await page.locator("#i").getAttribute("data-trusted"), "true");
  await interact(client, "fill", "#i", { value: "" }, "test");
  assert.equal(await page.locator("#i").inputValue(), "");
});

test("checkbox is idempotent; select verifies native options", async () => {
  await page.setContent('<input id="c" type="checkbox" onclick="this.dataset.n=Number(this.dataset.n||0)+1"><select id="s"><option value="a">A</option><option value="b">B</option></select>');
  await interact(client, "check", "#c", { checked: true }, "test");
  await interact(client, "check", "#c", { checked: true }, "test");
  assert.equal(await page.locator("#c").getAttribute("data-n"), "1");
  const result = await interact(client, "select", "#s", { values: ["b"] }, "test");
  assert.equal(result.verified, true);
  assert.equal(await page.locator("#s").inputValue(), "b");
});

test("refs retain nodes and fail after same-name replacement or navigation", async () => {
  await page.setContent('<button id="b">Save</button>');
  const snap = await snapshotWithTargets(client, "test");
  await page.evaluate(() => document.querySelector("#b").outerHTML = '<button id="other">Save</button>');
  await assert.rejects(interact(client, "click", { ref: "@e1", snapshotId: snap.snapshotId }, {}, "test"), e => e.code === "stale_target");
  await page.goto("data:text/html,<button>Save</button>");
  await assert.rejects(interact(client, "click", "@e1", {}, "test"), e => e.code === "stale_target");
  assert.equal(commands.filter(c => c.action === "cdp").length, 0);
});

test("open shadow DOM target resolves and receives trusted input", async () => {
  await page.setContent('<div id="host"></div>');
  await page.evaluate(() => { document.querySelector("#host").attachShadow({ mode: "open" }).innerHTML = '<button onclick="this.textContent=\'Done\'">Save</button>'; });
  await interact(client, "click", { role: "button", name: "Save" }, {}, "test");
  assert.equal(await page.locator("#host button").innerText(), "Done");
});

test("wait uses visibility and AND conditions", async () => {
  await page.setContent('<div id="hidden" style="display:none">Ready</div><p>Visible</p>');
  await assert.rejects(waitFor(client, { selector: "#hidden", timeoutMs: 120 }, "test"), e => e.code === "wait_timeout");
  await waitFor(client, { selector: "#hidden", state: "hidden", text: "Visible", timeoutMs: 300 }, "test");
  await assert.rejects(waitFor(client, { selector: "p", text: "Missing", timeoutMs: 120 }, "test"), e => e.code === "wait_timeout");
});

test("scroll at page bottom reports unverified wheel instead of invented movement", async () => {
  await page.setContent('<div style="height:3000px">Long page</div>');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const result = await scroll(client, { direction: "down", amount: 100 }, "test");
  assert.equal(result.moved, null);
  assert.equal(result.verified, false);
});

test("Control+A has no text payload and keyboard failure never submits a form", async () => {
  await page.setContent('<form onsubmit="event.preventDefault();this.dataset.submitted=1"><input id="i" value="abc"></form>');
  await page.locator("#i").focus();
  await pressKey(client, "Control+A", "test");
  assert.equal(commands.find(c => c.args?.method === "Input.dispatchKeyEvent").args.params.text, undefined);
  const failed = { command: async action => { if (action === "cdp") throw new Error("unsupported"); throw new Error("Unexpected DOM fallback"); } };
  await assert.rejects(pressKey(failed, "Enter", "test"), e => e.code === "outcome_unknown");
  assert.equal(await page.locator("form").getAttribute("data-submitted"), null);
});

test("fill_form stops after failure and reports skipped fields", async () => {
  await page.setContent('<input id="a"><input class="dup"><input class="dup"><input id="c">');
  await assert.rejects(fillForm(client, [{ selector: "#a", value: "one" }, { selector: ".dup", value: "two" }, { selector: "#c", value: "three" }], "test"), e => e.code === "fill_form_partial" && e.detail.skipped === 1);
  assert.equal(await page.locator("#a").inputValue(), "one");
  assert.equal(await page.locator("#c").inputValue(), "");
});

test("pointer drag delivers held-button movement and releases", async () => {
  await page.setContent('<button id="from">Drag</button><button id="to" style="margin-left:100px">Drop</button>');
  await page.evaluate(() => { globalThis.moves = []; document.addEventListener("mousemove", e => moves.push(e.buttons)); });
  await drag(client, { css: "#from" }, { css: "#to" }, {}, "test");
  assert.ok((await page.evaluate(() => moves)).includes(1));
  assert.equal(commands.filter(c => c.args?.method === "Input.dispatchMouseEvent").at(-1).args.params.type, "mouseReleased");
});

test("new tab without opener evidence is returned as candidate, never auto-selected", async () => {
  await page.setContent('<button id="b">Save</button>');
  const original = client.command;
  let lists = 0;
  client.command = async (action, args) => {
    if (action === "list_tabs") return { data: { tabs: [{ tabId: 1, url: page.url() }, ...(lists++ ? [{ tabId: 2, url: "https://example.org/" }] : [])] } };
    return original(action, args);
  };
  const result = await clickSmart(client, "#b", "test", { followTimeoutMs: 150 });
  assert.equal(result.followedNewTab, false);
  assert.equal(result.newTabCandidates.length, 1);
  assert.equal(commands.filter(c => c.action === "find_tab").length, 0);
});

test("explicit DOM mode reports synthetic input; strict CDP refuses hidden tabs before dispatch", async () => {
  await page.setContent('<button id="b" onclick="this.dataset.trusted=event.isTrusted">Save</button>');
  await page.evaluate(() => Object.defineProperty(document, "visibilityState", { get: () => "hidden" }));
  await assert.rejects(interact(client, "click", "#b", { inputMode: "cdp" }, "test"), e => e.code === "tab_not_visible");
  assert.equal(commands.filter(c => c.action === "cdp").length, 0);
  const result = await interact(client, "click", "#b", {}, "test");
  assert.equal(result.mode, "dom");
  assert.equal(await page.locator("#b").getAttribute("data-trusted"), "false");
});

test("explicit scroll container moves without scrolling the document", async () => {
  await page.setContent('<div id="c" style="height:100px;overflow:auto"><div style="height:1000px">Content</div></div><div style="height:2000px"></div>');
  const result = await scroll(client, { container: "#c", direction: "down", amount: 150 }, "test");
  assert.equal(result.moved, true);
  assert.equal(result.after.y, 150);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
});
