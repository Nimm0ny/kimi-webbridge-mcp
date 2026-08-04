/**
 * Tool surface profiles.
 * Default `compact` ≈ Claude-in-Chrome size/quality (stable, no tool bloat).
 * `full` keeps power-user extras (cdp, pdf, hover, form, sessions, …).
 */
export function getProfile() {
  return String(process.env.WEBBRIDGE_TOOL_PROFILE || "compact")
    .trim()
    .toLowerCase();
}

/** @deprecated use getProfile() — kept for boot logs */
export const PROFILE = getProfile();

/** Core set aligned with Claude-in-Chrome style browser MCP (~20). */
export const COMPACT_TOOLS = new Set([
  "wb_status",
  "wb_navigate",
  "wb_go_back",
  "wb_reload",
  "wb_list_tabs",
  "wb_find_tab",
  "wb_close_tab",
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
  "wb_go_forward",
  "wb_close_session",
  "wb_dblclick",
  "wb_hover",
  "wb_fill_form",
  "wb_cdp",
  "wb_save_as_pdf",
]);

export function isToolEnabled(name) {
  const p = getProfile();
  if (p === "full" || p === "all") return true;
  return COMPACT_TOOLS.has(name);
}

export function expectedToolCount() {
  const p = getProfile();
  if (p === "full" || p === "all") {
    return COMPACT_TOOLS.size + FULL_ONLY_TOOLS.size;
  }
  return COMPACT_TOOLS.size;
}

export function profileInfo() {
  const p = getProfile();
  const full = p === "full" || p === "all";
  return {
    profile: full ? "full" : "compact",
    toolCount: expectedToolCount(),
    note: full
      ? "Full surface including cdp/pdf/hover/form/session extras."
      : "Compact Claude-in-Chrome style surface. Set WEBBRIDGE_TOOL_PROFILE=full for extras.",
  };
}
