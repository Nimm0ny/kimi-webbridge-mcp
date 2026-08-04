---
name: kimi-webbridge
description: |
  Control the user's REAL browser (existing logins/cookies) via kimi-webbridge MCP tools (wb_*).
  Use when the user wants to open pages, click, type, scrape, screenshot, fill forms, debug a live page,
  or interact with any website - including simple asks like "open this URL" or "click that button".
  Prefer this over curl, ad-hoc shell, playwright scripts, or chrome-devtools when the task needs the
  already-logged-in browser profile. Requires MCP server kimi-webbridge; never call the WebBridge HTTP API directly.
metadata:
  version: "1.1.2"
  mcp: kimi-webbridge
---

# Kimi WebBridge

Architecture (same split as Claude-in-Chrome): **this Skill = playbook**; **MCP `kimi-webbridge` = tools**.

## Rules

1. **MCP only** - use `wb_*` tools. Never `curl`, temp JSON files, or the `kimi-webbridge` binary for page actions.
2. **Real profile first** - prefer WebBridge over chrome-devtools when login/cookies matter. Use chrome-devtools only for isolated perf / clean-browser work if the user asks.
3. **One task = one session** - task-shaped name (`checkout-debug`). Per-call `session` does not change the default; use `wb_set_session` only when needed.
4. **See before act** - `wb_find` or `wb_snapshot` before click/fill; prefer `@e` refs.
5. **Close only if asked** - `wb_close_session` / `wb_close_tab` only when the user wants tabs closed.

## Workflow

```text
wb_status
  -> wb_navigate          (newTab + group_title on first open)
  -> wb_find | wb_snapshot
  -> wb_click | wb_fill | wb_fill_form | wb_press_key | wb_scroll | wb_hover
  -> wb_get_text | wb_screenshot | wb_console | wb_network as needed
```

| Need | Tool |
|------|------|
| Health | `wb_status` |
| Open URL | `wb_navigate` |
| Use user's current tab | `wb_find_tab` with `active: true` |
| Structure / refs | `wb_snapshot`, `wb_find` |
| Long article text | `wb_get_text` |
| Wait for UI | `wb_wait` |
| Multi-field form | `wb_fill_form` |
| Keys | `wb_press_key` (Enter, Escape, Control+A, ...) |
| Console | `wb_console` start then list |
| Escape hatch | `wb_evaluate`, `wb_cdp` |

## Failures

- **Not ready / extension disconnected** - tell the user to enable Kimi WebBridge in the browser; do not invent curl workarounds.
- **@e missing** - re-run `wb_snapshot` / `wb_find`.
- **Synthetic click ignored** - say the site may need manual input; optional advanced `wb_cdp`.

Help: https://www.kimi.com/zh-cn/features/webbridge

Optional deeper notes: `references/workflow.md` in this skill folder.
