import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const t = new StdioClientTransport({
  command: "node",
  args: [join(root, "..", "src", "index.js")],
});
const c = new Client({ name: "bili-retest", version: "1.0.0" });
await c.connect(t);
const S = "bilibili-logged-in-retest";

async function call(name, args = {}) {
  const start = Date.now();
  const r = await c.callTool(
    { name, arguments: { session: S, ...args } },
    undefined,
    { timeout: 180000 },
  );
  const text = r.content?.find((x) => x.type === "text")?.text || "";
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    /* */
  }
  console.log(`\n== ${name} ${r.isError ? "ERR" : "OK"} ${Date.now() - start}ms ==`);
  console.log(text.slice(0, 700));
  return { r, j, text };
}

const results = [];
function rec(name, ok, note) {
  results.push({ name, ok, note });
}

try {
  let x = await call("wb_status");
  rec("status", x.j?.ready && x.j?.extension_connected, `ver=${x.j?.mcp_version}`);

  x = await call("wb_navigate", {
    url: "https://www.bilibili.com/",
    newTab: true,
    group_title: "B站已登录复测",
  });
  rec("navigate_home", !x.r.isError, x.j?.data?.url);

  x = await call("wb_wait", { text: "首页", timeoutMs: 12000 });
  rec("wait_home", !x.r.isError, x.j?.found);

  x = await call("wb_evaluate", {
    code: `(() => {
      const hasLoginCta = /立即登录|登录后你可以/.test(document.body.innerText || "");
      const avatar = document.querySelector("img.bili-avatar-img, .header-avatar-wrap img, .v-popover-wrap .bili-avatar img");
      return JSON.stringify({
        href: location.href,
        hasLoginCta,
        likelyLoggedIn: !hasLoginCta && !!avatar,
        hasAvatar: !!avatar,
        avatarSrc: avatar ? String(avatar.src).slice(0, 120) : null,
        headerHas动态: (document.body.innerText || "").includes("动态"),
        headerHas历史: (document.body.innerText || "").includes("历史"),
        headerHas收藏: (document.body.innerText || "").includes("收藏"),
      });
    })()`,
  });
  const login = (() => {
    try {
      return JSON.parse(x.j?.data?.value || x.j?.value || "{}");
    } catch {
      return {};
    }
  })();
  rec("login_detect", !!login.likelyLoggedIn, JSON.stringify(login));

  x = await call("wb_find", { query: "动态", limit: 10 });
  rec("find_动态", (x.j?.count || 0) > 0, `count=${x.j?.count}`);

  x = await call("wb_find", { query: "历史", limit: 8 });
  rec("find_历史", (x.j?.count || 0) > 0, `count=${x.j?.count}`);

  // Click 动态 via text if no ref
  x = await call("wb_evaluate", {
    code: `(() => {
      const all = [...document.querySelectorAll("a,span,div")];
      const el = all.find((e) => (e.innerText || "").trim() === "动态" && e.closest("a,button,[role=link],[role=button],.v-popover-wrap,li"));
      const target = el?.closest("a") || el;
      if (!target) return JSON.stringify({ error: "no 动态" });
      target.click();
      return JSON.stringify({ ok: true, tag: target.tagName, href: target.href || null });
    })()`,
  });
  rec("click_动态", !x.r.isError, String(x.j?.data?.value || "").slice(0, 120));

  await new Promise((r) => setTimeout(r, 2500));
  x = await call("wb_wait", { text: "动态", timeoutMs: 12000 });
  rec("wait_动态页", !x.r.isError, x.j?.found);

  x = await call("wb_evaluate", {
    code: `(() => JSON.stringify({ href: location.href, title: document.title.slice(0,80) }))()`,
  });
  rec("on_动态", /t\\.bilibili|动态/.test(String(x.j?.data?.value || x.text)), String(x.j?.data?.value || "").slice(0, 150));

  x = await call("wb_screenshot", { format: "jpeg", quality: 45 });
  rec("screenshot_动态", !x.r.isError, x.j?.data?.path || x.j?.path);

  // 历史
  x = await call("wb_navigate", { url: "https://www.bilibili.com/account/history", newTab: true });
  rec("navigate_历史", !x.r.isError, x.j?.data?.url);
  await new Promise((r) => setTimeout(r, 2000));
  x = await call("wb_get_text", { maxChars: 500 });
  rec("get_text_历史", !x.r.isError, `len=${x.j?.length} title=${x.j?.title}`);

  x = await call("wb_scroll", { direction: "down", amount: 600 });
  rec("scroll_历史", !x.r.isError && (x.j?.moved !== false || x.j?.scrollTopAfter > 0 || x.j?.ok), JSON.stringify(x.j).slice(0, 150));

  // 收藏
  x = await call("wb_navigate", { url: "https://www.bilibili.com/", newTab: false });
  await new Promise((r) => setTimeout(r, 1500));
  x = await call("wb_evaluate", {
    code: `(() => {
      const el = [...document.querySelectorAll("a,span")].find((e) => (e.innerText||"").trim() === "收藏");
      const a = el?.closest("a") || el;
      if (!a) return JSON.stringify({ error: "no 收藏" });
      a.click();
      return JSON.stringify({ ok: true, href: a.href || null });
    })()`,
  });
  rec("click_收藏", !x.r.isError, String(x.j?.data?.value || "").slice(0, 120));
  await new Promise((r) => setTimeout(r, 2500));
  x = await call("wb_evaluate", {
    code: `(() => JSON.stringify({ href: location.href, title: document.title.slice(0,60) }))()`,
  });
  rec("on_收藏", /fav|收藏|space/.test(String(x.j?.data?.value || x.text)), String(x.j?.data?.value || "").slice(0, 150));

  // search + video while logged in
  x = await call("wb_navigate", {
    url: "https://search.bilibili.com/all?keyword=claude",
    newTab: true,
  });
  rec("search", !x.r.isError, x.j?.data?.url);
  await new Promise((r) => setTimeout(r, 2000));
  x = await call("wb_wait", { text: "综合", timeoutMs: 12000 });
  rec("search_wait", !x.r.isError, x.j?.found);

  x = await call("wb_evaluate", {
    code: `(() => {
      const a = [...document.querySelectorAll("a")].find((x) => /\\/video\\/BV/.test(x.href) && (x.innerText||"").trim().length > 8);
      if (!a) return JSON.stringify({ error: "no video" });
      const href = a.href.split("?")[0];
      return JSON.stringify({ href, text: (a.innerText||"").trim().slice(0,50) });
    })()`,
  });
  let videoUrl = null;
  try {
    videoUrl = JSON.parse(x.j?.data?.value || "{}").href;
  } catch {
    /* */
  }
  rec("pick_video", !!videoUrl, videoUrl);

  if (videoUrl) {
    x = await call("wb_navigate", { url: videoUrl });
    rec("open_video", !x.r.isError, videoUrl);
    await new Promise((r) => setTimeout(r, 2500));
    x = await call("wb_get_text", { maxChars: 400 });
    rec("video_text", !x.r.isError, x.j?.title);
    x = await call("wb_evaluate", {
      code: `(() => {
        const v = document.querySelector("video");
        if (v) { v.muted = true; try { v.play(); } catch(e) {} }
        return JSON.stringify({ hasVideo: !!v, paused: v ? v.paused : null, t: v ? v.currentTime : null });
      })()`,
    });
    rec("video_play", !x.r.isError, String(x.j?.data?.value || "").slice(0, 120));
    x = await call("wb_screenshot", { format: "jpeg", quality: 40 });
    rec("video_shot", !x.r.isError, "ok");
    x = await call("wb_scroll", { direction: "down", amount: 900 });
    rec("video_scroll", !x.r.isError, JSON.stringify(x.j).slice(0, 160));
  }

  // find_tab precision
  x = await call("wb_list_tabs");
  const tabs = x.j?.data?.tabs || x.j?.tabs || [];
  rec("list_tabs", tabs.length >= 1, `n=${tabs.length}`);
  if (videoUrl) {
    x = await call("wb_find_tab", { url: videoUrl.split("?")[0] });
    rec("find_tab_video", !x.r.isError, x.j?.data?.url || x.j?.url || x.text.slice(0, 100));
  }
  x = await call("wb_find_tab", { active: true });
  rec("find_tab_active", !x.r.isError, x.j?.data?.url || x.j?._meta?.resolvedUrl || "ok");

  x = await call("wb_network", { cmd: "start" });
  rec("net_start", !x.r.isError, "ok");
  x = await call("wb_console", { cmd: "start" });
  rec("console_start", !x.r.isError, "ok");
  x = await call("wb_press_key", { key: "Escape" });
  rec("press_esc", !x.r.isError, x.j?.mode);
  x = await call("wb_network", { cmd: "list" });
  rec("net_list", !x.r.isError, `count=${x.j?.data?.count ?? "?"}`);
  x = await call("wb_console", { cmd: "list" });
  rec("console_list", !x.r.isError, `msgs=${x.j?.count}`);

  // cleanup
  x = await call("wb_close_session");
  rec("close_session", !x.r.isError, "ok");
} finally {
  await c.close();
}

console.log("\n========== SUMMARY ==========");
let pass = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name} — ${r.note}`);
  if (r.ok) pass++;
}
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
