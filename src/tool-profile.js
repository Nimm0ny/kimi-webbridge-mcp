/**
 * Tool surface profiles.
 * Default `compact` ≈ Claude-in-Chrome size/quality (stable, no tool bloat).
 * `full` keeps power-user extras (cdp, pdf, hover, form, sessions, …).
 *
 * Single source of truth for tool counts — import expectedToolCount() everywhere.
 */

export function getProfile() {
  return String(process.env.WEBBRIDGE_TOOL_PROFILE || "compact")
    .trim()
    .toLowerCase();
}

/** Core set aligned with Claude-in-Chrome style browser MCP. */
export const COMPACT_TOOLS = new Set([
  "wb_status",
  "wb_navigate",
  "wb_go_back",
  "wb_go_forward",
  "wb_reload",
  "wb_list_tabs",
  "wb_find_tab",
  "wb_close_tab",
  "wb_close_session",
  "wb_snapshot",
  "wb_get_text",
  "wb_find",
  "wb_wait",
  "wb_click",
  "wb_fill",
  "wb_press_key",
  "wb_scroll",
  "wb_evaluate",
  "wb_screenshot",
  "wb_network",
  "wb_console",
  "wb_upload",
]);

/** Extra tools only in full profile */
export const FULL_ONLY_TOOLS = new Set([
  "wb_set_session",
  "wb_dblclick",
  "wb_hover",
  "wb_fill_form",
  "wb_cdp",
  "wb_save_as_pdf",
]);

export function isFullProfile() {
  const p = getProfile();
  return p === "full" || p === "all";
}

export function isToolEnabled(name) {
  if (isFullProfile()) return true;
  return COMPACT_TOOLS.has(name);
}

export function expectedToolCount() {
  if (isFullProfile()) {
    return COMPACT_TOOLS.size + FULL_ONLY_TOOLS.size;
  }
  return COMPACT_TOOLS.size;
}

export function profileInfo() {
  const full = isFullProfile();
  return {
    profile: full ? "full" : "compact",
    toolCount: expectedToolCount(),
    compactCount: COMPACT_TOOLS.size,
    fullOnlyCount: FULL_ONLY_TOOLS.size,
    note: full
      ? "Full surface including cdp/pdf/hover/form extras."
      : "Compact Claude-in-Chrome style surface. Set WEBBRIDGE_TOOL_PROFILE=full for extras.",
  };
}

/** Whether click may borrow the browser's focused tab outside the session group. */
export function allowBorrowActiveTab() {
  const v = String(process.env.WEBBRIDGE_CLICK_BORROW_ACTIVE || "0").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
