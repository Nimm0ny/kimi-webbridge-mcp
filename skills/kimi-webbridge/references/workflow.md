# Optional workflows

## Multi-page research

1. One session for the whole task; `group_title` on first navigate
2. `newTab: true` per source
3. `wb_get_text` per page; `wb_find_tab` with URL from `wb_list_tabs` to switch
4. Close only if user asks (`wb_close_session`)

## Logged-in product

1. User already logged in (or finishes login/CAPTCHA manually)
2. `wb_find_tab` with `active: true` (MCP resolves url if extension requires it)
3. snapshot/find -> fill/click -> `wb_wait` -> `wb_screenshot`
4. On error JSON, apply `hint` before retrying

## Screenshot reliability

1. Prefer default jpeg (MCP default)
2. Huge pages: pass `selector` crop
3. Timeout: MCP auto-retries smaller jpeg; still failing -> tab visible, not chrome://

## Forms / upload

1. Prefer stable app pages or local fixtures over flaky public demos (503)
2. Upload: absolute disk paths only; page must expose `<input type=file>`

## UI bug

1. `wb_console` start
2. Reproduce
3. `wb_console` list + `wb_network` if needed
