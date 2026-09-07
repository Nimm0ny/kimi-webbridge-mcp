# Optional workflows

## Agent 主动建链（所有流程之前）

**建链是 Agent 的职责。** 扩展通常已安装；不要默认让用户去点扩展。

```text
wb_status
  → MCP ensureDaemon（daemon 未跑则 start）
  → ready=true  →  wb_navigate / 业务
  → ready=false → Agent 重试 status（1～3 次）；仍失败再问「浏览器是否打开」
```

| 现象 | Agent 处理 |
|------|------------|
| 未调过 `wb_status` | **先调**，不要假设可用 |
| `daemon_started_now=true` 且扩展暂 false | **重试** `wb_status`，等扩展挂上 |
| `running=true` + `extension_connected=true` | 建链完成，可 navigate |
| 多次仍 extension false | 再请用户确认浏览器/扩展 profile |
| 中途 command 报 extension | 回 `wb_status` 重建链，勿改 curl |

详见 `SKILL.md` §0。

## Multi-page research

1. One session for the whole task; `group_title` on first navigate
2. `newTab: true` per source
3. `wb_get_text` per page; `wb_find_tab` with URL from `wb_list_tabs` to switch
4. Close with `wb_close_tab` or `wb_close_session` only if the user asks

## Logged-in product

1. User already logged in (or finishes login/CAPTCHA manually)
2. `wb_find_tab` with `active: true` when the tab is already in the session, or pass full `url`
3. snapshot/find -> fill/click -> `wb_wait` -> `wb_screenshot`
4. On error JSON, apply `hint` before retrying

## Screenshot reliability

1. Prefer default jpeg (quality 55)
2. Huge pages: pass `selector` crop
3. Timeout: MCP auto-retries smaller jpeg then CDP fallback

## Forms / upload

1. Prefer stable app pages or local fixtures over flaky public demos (503)
2. Upload: absolute disk paths only; page must expose `<input type=file>`

## UI bug

1. `wb_console` start
2. Reproduce
3. `wb_console` list + `wb_network` if needed

## Full-profile only

Tools like `wb_cdp`, `wb_set_session`, `wb_fill_form`, `wb_save_as_pdf` require `WEBBRIDGE_TOOL_PROFILE=full`.

## 1.3 严格操作流程

- selector 与 target 二选一；target 支持 css 或 role/name/within。不要在 ambiguous_target 时猜候选。
- wb_snapshot/wb_find 后推荐使用 target.ref + snapshotId；旧引用失效则重新观察。
- click/check/dblclick 的 inputMode=auto 在可见页用 CDP、后台页用 DOM；mode 会如实返回。要求可信输入时显式 inputMode=cdp，并让目标标签可见。
- wb_fill/wb_check/wb_select 自动验证状态；click 等传 expect 或随后观察页面，不能把 verified=false 当任务成功。
- outcome_unknown 表示可能已执行；先检查页面，再决定是否重试，避免重复提交。
- wb_scroll 的 container 指定滚动容器；moved=null 表示仅发出滚轮，尚未验证位移。
- compact 28 工具，含 hover/dblclick/type/select/check/drag；full 32 工具。跨域 iframe、窗口管理、下载事件及原生 ID 路由尚未实现，查看 wb_status.capabilities。
