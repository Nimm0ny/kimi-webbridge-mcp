# Optional workflows

## Multi-page research

1. One session for the whole task; `group_title` on first navigate
2. `newTab: true` per source
3. `wb_get_text` per page; `wb_find_tab` to switch
4. Close only if user asks (`wb_close_session`)

## Logged-in product

1. User already logged in (or finishes login/CAPTCHA manually)
2. `wb_find_tab` `active: true` if the tab is already open
3. snapshot/find -> fill/click -> `wb_wait` -> screenshot

## UI bug

1. `wb_console` start
2. Reproduce
3. `wb_console` list + `wb_network` if needed
