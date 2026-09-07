import { ToolError } from "./errors.js";
import { unwrap } from "./page-actions.js";

// URL is a compatibility transport, never a license to navigate another tab.
export async function findTabSmart(client, { url, active, tabId, session } = {}) {
  const data = unwrap(await client.command("list_tabs", {}, { session }));
  const tabs = data?.tabs || data?.data?.tabs || [];
  let matches = tabs.filter(t => (tabId == null || t.tabId === tabId) && (!url || t.url === url));
  if (active) matches = matches.filter(t => t.active);
  if (tabId == null && !url && !active) matches = [];
  if (matches.length !== 1) {
    throw new ToolError("Select exactly one session tab", {
      code: matches.length > 1 ? "ambiguous_tab" : "tab_not_found",
      detail: { candidates: matches.length ? matches : tabs },
      hint: "Pass tabId or an exact URL from wb_list_tabs. Selection never navigates.",
    });
  }
  const chosen = matches[0];
  // Upstream only promises URL selection, not native ID routing.
  if (tabs.filter(t => t.url === chosen.url).length !== 1) {
    throw new ToolError("Bridge cannot select duplicate-URL tabs by ID", {
      code: "unsupported_capability", detail: { capability: "native_tab_id_selection", candidates: matches },
      hint: "Requires daemon/extension support for explicit tab targeting.",
    });
  }
  const result = await client.command("find_tab", { url: chosen.url }, { session });
  const got = unwrap(result);
  if (got?.url !== chosen.url || (got?.tabId != null && got.tabId !== chosen.tabId)) {
    throw new ToolError("Bridge selected a different or unverifiable tab", {
      code: "tab_selection_mismatch", detail: { expected: chosen, actual: got },
      hint: "Inspect wb_list_tabs before further actions. No fallback navigation was performed.",
    });
  }
  return { ...result, selectedTabId: chosen.tabId, verified: true };
}
