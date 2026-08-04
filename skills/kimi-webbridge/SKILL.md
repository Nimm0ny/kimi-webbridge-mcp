---
name: kimi-webbridge
description: |
  Control the user's REAL browser (existing logins/cookies) via kimi-webbridge MCP tools (wb_*).
  Use when the user wants to open pages, click, type, scrape, screenshot, fill forms, debug a live page,
  or interact with any website - including simple asks like "open this URL" or "click that button".
  Prefer this over curl, ad-hoc shell, playwright scripts, or chrome-devtools when the task needs the
  already-logged-in browser profile. Requires MCP server kimi-webbridge; never call the WebBridge HTTP API directly.
metadata:
  version: "1.1.4"
  mcp: kimi-webbridge
---

# Kimi WebBridge

Architecture (Claude-in-Chrome style): **this Skill = thin playbook**; **MCP = wb_* tools**.

## Rules

1. **MCP only** - `wb_*` tools. Never curl / temp JSON / daemon CLI for page actions.
2. **Real profile first** - WebBridge when login/cookies matter; chrome-devtools only for clean/perf if asked.
3. **One task = one session** - per-call `session` does not change default; use `wb_set_session` when needed.
4. **See before act** - `wb_find` / `wb_snapshot` then `@e` for click/fill.
5. **Close only if asked** - `wb_close_session` / `wb_close_tab` only on user request.
6. **Read error JSON** - failures return `problem` + `hint`; follow the hint before inventing workarounds.

## Workflow

```text
wb_status
  -> wb_navigate (newTab + group_title on first open)
  -> wb_find | wb_snapshot
  -> wb_click | wb_fill | wb_fill_form | wb_press_key | wb_scroll | wb_hover
  -> wb_get_text | wb_screenshot | wb_console | wb_network as needed
```

| Need | Tool |
|------|------|
| Health | `wb_status` |
| Open | `wb_navigate` |
| Switch tab | `wb_find_tab` (url fuzzy-match or `active:true`) |
| Structure | `wb_snapshot` / `wb_find` |
| Text | `wb_get_text` |
| Wait | `wb_wait` (on timeout, trust problem/hint) |
| Screenshot | `wb_screenshot` (default jpeg; auto-retry if slow) |
| Forms | `wb_fill` / `wb_fill_form` on stable pages (avoid flaky 503 demos) |
| Upload | `wb_upload` with **local absolute paths** on a real file input page |

## Failures (quick)

- **extension disconnected** - user enables Kimi WebBridge; no curl fallback.
- **@e missing** - fresh `wb_snapshot` / `wb_find`.
- **wait/screenshot timeout** - use hints; jpeg/selector crop; check page is not 503/error.
- **find_tab no match** - `wb_list_tabs` then exact url; or `wb_navigate` into this session.
- **upload element not found** - not `data:` pages; need visible `<input type=file>`.
- **click ignored (isTrusted)** - may need manual interaction; advanced `wb_cdp`.
- **login/CAPTCHA/QR** - open passport UI with MCP; user completes login in the real browser (never put passwords in chat).
- **SPA scrollY=0** - still call `wb_scroll` (MCP finds overflow roots); verify with evaluate if needed.
- **find_tab** - pass path-specific URLs (`/video/BVxx`); same host alone is not enough.

Help: https://www.kimi.com/zh-cn/features/webbridge

Optional: `references/workflow.md`.
