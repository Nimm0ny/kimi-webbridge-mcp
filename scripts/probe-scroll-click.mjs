import { WebBridgeClient } from "../src/client.js";
import { scroll, clickSmart, evaluateJson, sleep, unwrap } from "../src/page-actions.js";
import { searchSnapshot } from "../src/page-actions.js";

const c = new WebBridgeClient();
const S = "v12-probe";

await c.command(
  "navigate",
  { url: "https://www.bilibili.com/video/BV14WMF6KEek/", newTab: true, group_title: "v12-probe" },
  { session: S },
);
await sleep(2500);
console.log("scroll1", await scroll(c, { direction: "down", amount: 900 }, S));
console.log("scroll2", await scroll(c, { direction: "down", amount: 900 }, S));

await c.command("navigate", { url: "https://www.bilibili.com/", newTab: true }, { session: S });
await sleep(2000);
const snap = unwrap(await c.command("snapshot", {}, { session: S }));
const hits = searchSnapshot(snap?.tree ?? snap, { query: "动态", limit: 5 });
console.log("find 动态", hits);
const ref = hits.find((h) => h.ref)?.ref;
if (ref) {
  const tabsBefore = unwrap(await c.command("list_tabs", {}, { session: S }));
  console.log(
    "tabs before",
    (tabsBefore?.tabs || []).map((t) => t.url),
  );
  const cr = await clickSmart(c, ref, S, { followNewTab: true });
  console.log("clickSmart", JSON.stringify(cr, null, 2).slice(0, 800));
  const tabsAfter = unwrap(await c.command("list_tabs", {}, { session: S }));
  console.log(
    "tabs after",
    (tabsAfter?.tabs || []).map((t) => ({ url: t.url, active: t.active })),
  );
  const where = await evaluateJson(
    c,
    `(() => JSON.stringify({ href: location.href, title: document.title.slice(0,60) }))()`,
    S,
  );
  console.log("current page after follow", where);
} else {
  console.log("no ref for 动态");
}

await c.command("close_session", {}, { session: S }).catch(() => {});
