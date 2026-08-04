import { ToolError, asToolError } from "./errors.js";
import { unwrap } from "./page-actions.js";

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    let path = x.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    x.pathname = path || "/";
    return x.href;
  } catch {
    return String(u || "")
      .trim()
      .replace(/\/$/, "");
  }
}

function scoreTab(tab, want) {
  if (!tab?.url || !want) return -1;
  const na = normalizeUrl(tab.url);
  const nb = normalizeUrl(want);
  if (na === nb) return 100;
  try {
    const t = new URL(tab.url);
    const w = new URL(want.startsWith("http") ? want : `https://${want}`);
    const th = t.hostname.replace(/^www\./, "");
    const wh = w.hostname.replace(/^www\./, "");
    if (th !== wh) return -1;
    const tp = t.pathname.replace(/\/$/, "") || "/";
    const wp = w.pathname.replace(/\/$/, "") || "/";
    if (tp === wp) return 95;
    // Path prefix only when the longer path extends the shorter (video id etc.)
    if (tp.startsWith(wp + "/") || wp.startsWith(tp + "/")) return 88;
    // Same host but different path: do NOT treat as match (Bilibili home vs /video/BV...)
    if (wp !== "/" && tp !== wp) return -1;
    // want is bare host or /
    if (wp === "/" || wp === "") return 60;
  } catch {
    if (na.startsWith(nb) || nb.startsWith(na)) return 80;
  }
  return -1;
}

function errText(err) {
  const m = err?.message || String(err);
  try {
    const j = JSON.parse(m);
    return j?.message || j?.error?.message || m;
  } catch {
    return m;
  }
}

async function listSessionTabs(client, session) {
  const raw = unwrap(await client.command("list_tabs", {}, { session }));
  return raw?.tabs || raw?.data?.tabs || [];
}

/**
 * Robust find_tab with fuzzy URL + active:true recovery when extension requires url.
 */
export async function findTabSmart(client, { url, active, session } = {}) {
  // --- active borrow ---
  if (active) {
    // 1) Native active:true (+ optional url)
    try {
      const args = { active: true };
      if (url) args.url = url;
      return await client.command("find_tab", args, { session });
    } catch (err) {
      const msg = errText(err);
      const tabs = await listSessionTabs(client, session);

      // Prefer true active tab, else single tab, else first
      const pick =
        tabs.find((t) => t.active) ||
        (tabs.length === 1 ? tabs[0] : null) ||
        tabs[0];

      if (pick?.url) {
        try {
          return {
            ...(await client.command("find_tab", { url: pick.url, active: true }, { session })),
            _meta: {
              recoveredFrom: "active_requires_url",
              resolvedUrl: pick.url,
              daemonMessage: msg,
            },
          };
        } catch {
          return {
            ...(await client.command("find_tab", { url: pick.url }, { session })),
            _meta: {
              recoveredFrom: "active_fallback_url_only",
              resolvedUrl: pick.url,
              daemonMessage: msg,
            },
          };
        }
      }

      // If caller also gave url, try fuzzy that
      if (url && tabs.length) {
        return findByUrl(client, url, tabs, session, msg);
      }

      throw new ToolError("Cannot resolve active tab", {
        code: "find_tab_active_failed",
        detail: { daemon: msg, sessionTabs: tabs },
        hint: "Open a page with wb_navigate in this session first, or pass url. Extension may require url alongside active:true.",
      });
    }
  }

  if (!url) {
    throw new ToolError("find_tab needs url or active:true", {
      code: "find_tab_args",
      hint: 'Pass { url: "https://..." } or { active: true }.',
    });
  }

  try {
    return await client.command("find_tab", { url }, { session });
  } catch (err) {
    const msg = errText(err);
    const tabs = await listSessionTabs(client, session);
    return findByUrl(client, url, tabs, session, msg);
  }
}

async function findByUrl(client, url, tabs, session, daemonMsg) {
  if (!tabs.length) {
    throw new ToolError("No matching tab and session has zero tabs", {
      code: "find_tab_empty_session",
      detail: daemonMsg,
      hint: "wb_navigate into this session first (same session name). newTab:true keeps multiple pages.",
    });
  }

  let best = null;
  let bestScore = -1;
  for (const tab of tabs) {
    const s = scoreTab(tab, url);
    if (s > bestScore) {
      bestScore = s;
      best = tab;
    }
  }

  if (best && bestScore >= 70) {
    const r = await client.command("find_tab", { url: best.url }, { session });
    return {
      ...r,
      matchedVia: "fuzzy",
      requestedUrl: url,
      resolvedUrl: best.url,
      matchScore: bestScore,
    };
  }

  throw new ToolError(`No tab matching ${url} in this session`, {
    code: "find_tab_no_match",
    detail: {
      daemon: daemonMsg,
      sessionTabs: tabs.map((t) => ({ url: t.url, title: t.title, active: t.active })),
    },
    hint: "Use exact url from wb_list_tabs. If you navigated without newTab, the previous URL was replaced — open with newTab:true to keep both.",
  });
}
