---
name: kimi-webbridge
description: |
  Control the user's REAL browser (existing logins/cookies) via kimi-webbridge MCP tools (wb_*).
  Use when the user wants to open pages, click, type, scrape, screenshot, fill forms, debug a live page,
  or interact with any website - including simple asks like "open this URL" or "click that button".
  Prefer this over curl, ad-hoc shell, playwright scripts, or chrome-devtools when the task needs the
  already-logged-in browser profile. Requires MCP server kimi-webbridge; never call the WebBridge HTTP API directly.
metadata:
  version: "1.2.1"
  mcp: kimi-webbridge
---

# Kimi WebBridge

**Skill = thin playbook. MCP = tools.** Default profile is **compact** (Claude-in-Chrome sized). Prefer accuracy over calling many tools.

## Rules

1. **MCP only** - `wb_*`. Never curl / temp JSON / daemon CLI.
2. **Few tools** - status → navigate → find/snapshot → click/fill → text/screenshot. Do not spam optional tools.
3. **See before act** - `wb_find` / `wb_snapshot`, then `@e` for click/fill.
4. **Session** - optional `session` arg per call; one task one session name.
5. **Close only if asked** - `wb_close_tab` or `wb_close_session` when user wants tabs cleared.
6. **Read `problem` + `hint`** on errors before inventing workarounds.
7. **Login/CAPTCHA/QR** - open UI with MCP; user completes login in the real browser (never put passwords in chat).
8. **`wb_evaluate` is powerful** - use sparingly; never for stealing secrets/cookies.

## Workflow

```text
wb_status
  -> wb_navigate (newTab + group_title on first open)
  -> wb_find | wb_snapshot
  -> wb_click | wb_fill   (@e; click follows session new tabs)
  -> wb_get_text | wb_screenshot | wb_wait as needed
```

| Need | Tool |
|------|------|
| Health | `wb_status` (check tool_profile / tool_count) |
| Open | `wb_navigate` |
| Tabs | `wb_list_tabs` / `wb_find_tab` (path-aware) / `wb_close_tab` / `wb_close_session` |
| Structure | `wb_snapshot` / `wb_find` |
| Text | `wb_get_text` |
| Wait | `wb_wait` |
| Click / type | `wb_click`, `wb_fill`, `wb_press_key` |
| Scroll | `wb_scroll` |
| Capture | `wb_screenshot` (jpeg default) |
| Debug | `wb_console`, `wb_network`, `wb_evaluate` |
| Upload | `wb_upload` (local absolute paths) |

## Notes

- **New tab after click**: `wb_click` follows new tabs **in the session group**. Tabs opened outside the group need `list_tabs`/`navigate` by URL (borrow-active is off by default).
- **find_tab**: full path URLs (`/video/BVxx`), not bare host.
- **Extras** (cdp/pdf/hover/form): only if MCP started with `WEBBRIDGE_TOOL_PROFILE=full`.

Help: https://www.kimi.com/zh-cn/features/webbridge
