import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { findTabSmart } from "../src/tab-actions.js";
import { formatResult } from "../src/format.js";
import { OperationQueue } from "../src/operation-queue.js";
import { WebBridgeClient } from "../src/client.js";
import { screenshotSmart } from "../src/capture.js";
import sharp from "sharp";
import { randomBytes } from "node:crypto";

test("wrong tab selection never navigates", async () => {
  const calls = [];
  const client = { command: async action => { calls.push(action); return action === "list_tabs" ? { data: { tabs: [{ tabId: 1, url: "https://example.com/a" }] } } : { data: { url: "https://example.com/b" } }; } };
  await assert.rejects(findTabSmart(client, { url: "https://example.com/a" }), e => e.code === "tab_selection_mismatch");
  assert.deepEqual(calls, ["list_tabs", "find_tab"]);
});
test("duplicate URLs reject selection even with explicit ID", async () => {
  const calls = [];
  const client = { command: async action => { calls.push(action); return { data: { tabs: [1, 2].map(tabId => ({ tabId, url: "https://example.com/" })) } }; } };
  await assert.rejects(findTabSmart(client, { tabId: 1 }), e => e.code === "unsupported_capability");
  assert.deepEqual(calls, ["list_tabs"]);
});
test("nested screenshot embeds image, nested failures propagate", () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-test-"));
  try {
    const path = join(dir, "image.png");
    writeFileSync(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
    const result = formatResult({ ok: true, data: { path, mimeType: "image/png" } }, { preferImage: true });
    assert.equal(result.content[0].type, "image");
    assert.equal(formatResult({ data: { success: false } }).isError, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("queue serializes whole operations and recovers from rejection", async () => {
  const queue = new OperationQueue(), events = [];
  const first = queue.run(async () => { events.push(1); await new Promise(r => setTimeout(r, 30)); events.push(2); throw Error("fail"); });
  const second = queue.run(async () => { events.push(3); return 4; });
  await assert.rejects(first);
  assert.equal(await second, 4);
  assert.deepEqual(events, [1, 2, 3]);
});
test("status cache is used; command timeout is outcome_unknown without retry", async () => {
  let statusCalls = 0, posts = 0;
  const server = createServer((req, res) => {
    if (req.url === "/status") { statusCalls++; res.end(JSON.stringify({ running: true, extension_connected: true })); }
    else { posts++; if (posts <= 2) res.end(JSON.stringify({ ok: true })); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const client = new WebBridgeClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 1000 });
    await client.command("list_tabs"); await client.command("list_tabs");
    assert.equal(statusCalls, 1);
    await assert.rejects(client.command("click", {}, { timeoutMs: 50 }), e => e.code === "outcome_unknown");
    assert.equal(posts, 3);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test("screenshot fallback preserves PNG and embeds nested CDP result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-shot-test-"));
  const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } }).png().toBuffer();
  const calls = [];
  const client = { command: async (action, args, options) => {
    calls.push({ action, args, options });
    if (action === "evaluate") return { data: { value: JSON.stringify({ href: "https://example.com/" }) } };
    if (action === "screenshot") throw Error("capture failed");
    return { data: { data: bytes.toString("base64") } };
  } };
  try {
    const result = await screenshotSmart(client, { format: "png", path: join(dir, "shot.png"), timeoutMs: 1000 }, "test");
    assert.equal(result.data.format, "png");
    assert.equal(formatResult(result, { preferImage: true }).content[0].type, "image");
    assert.ok(calls.every(c => c.options.timeoutMs <= 1000));
    assert.equal(calls.at(-1).args.params.format, "png");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("oversized screenshot gets bounded preview without replacing original", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-preview-test-"));
  let previewPath;
  const path = join(dir, "large.png");
  const bytes = await sharp(randomBytes(1500 * 1000 * 3), { raw: { width: 1500, height: 1000, channels: 3 } }).png().toBuffer();
  writeFileSync(path, bytes);
  const client = { command: async action => action === "evaluate" ? { data: { value: '{"href":"https://example.com/"}' } } : { data: { path, mimeType: "image/png" } } };
  try {
    const result = await screenshotSmart(client, {}, "test");
    previewPath = result.data.preview.path;
    assert.equal(result.data.preview.originalWidth, 1500);
    const formatted = formatResult(result, { preferImage: true });
    assert.equal(formatted.content[0].type, "image");
    assert.ok(Buffer.from(formatted.content[0].data, "base64").length <= 400000);
    assert.equal(result.data.path, path);
  } finally { if (previewPath) rmSync(previewPath); rmSync(dir, { recursive: true, force: true }); }
});
