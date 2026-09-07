---
name: kimi-webbridge
description: |
  Control the user's REAL browser (existing logins/cookies) via kimi-webbridge MCP tools (wb_*).
  Use when the user wants to open pages, click, type, scrape, screenshot, fill forms, debug a live page,
  or interact with any website - including simple asks like "open this URL" or "click that button".
  Prefer this over curl, ad-hoc shell, playwright scripts, or chrome-devtools when the task needs the
  already-logged-in browser profile. Requires MCP server kimi-webbridge; never call the WebBridge HTTP API directly.
  CRITICAL — Agent must ACTIVELY establish the bridge each task: call wb_status FIRST (MCP ensureDaemon
  starts local daemon on :10086 if needed). Do NOT wait for the user to "connect the extension" as the
  default step — extension is usually already installed; Agent's wb_status/wb_navigate is the connect path.
  Proceed when ready=true (running + extension_connected). Only if still offline after Agent retries, ask user
  whether the browser is open.
metadata:
  version: "1.3.0"
  mcp: kimi-webbridge
---

# Kimi WebBridge

**Skill = thin playbook. MCP = tools.** Default profile is **compact** (Claude-in-Chrome sized). Prefer accuracy over calling many tools.

## 0. Agent 主动建链（硬前置 · 实测）

**建链主体是 Agent，不是用户去点扩展。**  
用户侧扩展一般**早已装好**；MCP 挂上 ≠ 本任务已连通。Agent 必须在业务前 **主动** 调工具把链路拉起来。

### 链路分层

```text
Agent  wb_*
   →  MCP (kimi-webbridge)          ensureDaemon / command
   →  本机 daemon :10086            kimi-webbridge start（按需）
   →  浏览器扩展（通常已安装）       extension_connected
   →  真实浏览器标签 / 登录态
```

| 层 | 谁拉起 | 标志 |
|----|--------|------|
| MCP 工具面 | 宿主已配好 | 能调 `wb_*` |
| **daemon** | **Agent 调 `wb_status` → MCP `ensureDaemon`**（未跑则 `kimi-webbridge start`） | `running=true`；`daemon_started_now` 可 true |
| **扩展 ↔ daemon** | daemon 起来后扩展自动挂上（扩展已装好时） | `extension_connected=true` |
| **任务 session / 标签组** | **Agent** `wb_navigate`（`group_title` + 可选 `session`） | 可 `wb_list_tabs` |
| **站点登录** | 用户曾登录 / 本任务遇登录页再请用户 | 业务页非 login |

### Agent 强制流程（每次要控浏览器时）

```text
1) wb_status                    # 主动建链入口：会 ensureDaemon
2) 若 ready=true：
     → wb_navigate（首开传 group_title；业务 session 固定）
     → 后续 find/snapshot/click…
3) 若 ready=false 或 extension_connected=false：
     → 先 **Agent 侧重试**（勿立刻甩锅用户）：
         - 再调 1～3 次 wb_status（daemon 刚 start 时扩展可能晚几秒连上）
         - 仍 false：可 shell `kimi-webbridge status` / `kimi-webbridge start` 后复检 status
     → 仅多次失败才问用户：浏览器是否已打开（扩展是否在日常 profile 启用）
4) 禁止：未 wb_status 就假设可用；禁止默认话术「请你去点扩展连接」代替 Agent 建链
```

### 实测备忘（2026-08-11）

| 步骤 | 结果 |
|------|------|
| 仅 MCP 列出 / 未调工具 | **未**视为已连接 |
| `wb_status` | MCP `ensureDaemon`；可 `daemon_started_now=true`；目标 `ready=true` |
| `ready` 且 `extension_connected` | 扩展已装场景下，daemon 起后通常为 true |
| `wb_navigate` + `group_title` + `session` | 打开业务页 / 建立标签组（例：OA 探针成功） |
| 扩展未装或浏览器未开 | status 持续 `extension_connected=false` → 再请用户处理 |

实现锚点（MCP）：`ensureDaemon()` 在 `client.js`；`wb_status` 在 `index.js` 内先 `ensureDaemon` 再返回 `ready`。

### `wb_status` 字段

| 字段 | 含义 |
|------|------|
| `running` | daemon 是否在跑 |
| `daemon_started_now` | **本次** `wb_status` 是否刚拉起 daemon（Agent 建链痕迹） |
| `extension_connected` | 扩展是否已挂到 daemon |
| `ready` | `running && extension_connected` — 业务门槛 |
| `hint` | Ready 或未连时的提示 |
| `default_session` | 默认 session 名 |
| `tool_profile` / `tool_count` | compact vs full |

### 常见误判（禁止）

| 误判 | 正确 |
|------|------|
| 「用户去连扩展」才是建链 | **Agent 调 `wb_status` 才是建链**；扩展是前置安装 |
| MCP 已连接 → 本任务可用 | 仍须本任务首次 `wb_status` |
| `daemon_started_now=true` 且扩展暂 false → 立刻放弃 | **重试 status** 几秒，等扩展挂上 |
| 用 curl 打 :10086 代替 MCP | **禁止**；页面动作只用 `wb_*` |
| 站点未登录当成 WebBridge 未连 | 建链成功后 navigate 到登录页 → 再请用户登录 |

Help: https://www.kimi.com/zh-cn/features/webbridge

## Rules

1. **Agent 先建链** - 见 §0；业务 `wb_*` 前必须 `wb_status` 且 `ready`（或重试后 ready）。
2. **MCP only** - 页面动作只用 `wb_*`。不要 curl / 手写打 daemon HTTP。`kimi-webbridge start|status` 仅作建链排障，不替代 `wb_navigate` 等。
3. **Few tools** - status → navigate → find/snapshot → click/fill → text/screenshot.
4. **See before act** - `wb_find` / `wb_snapshot`，再 `@e` click/fill。
5. **Session** - 一任务一 `session`；首导航带 `group_title`。
6. **Close only if asked** - `wb_close_tab` / `wb_close_session` 仅用户要求时。
7. **Read `problem` + `hint`** - 先按 hint；扩展类错误先 **Agent 重试 status/start**，再问用户。
8. **Login/CAPTCHA/QR** - 建链后打开页；登录由用户在真实浏览器完成（勿在聊天里要密码）。
9. **`wb_evaluate` 慎用** - 勿窃取 secrets/cookies。

## Workflow

```text
wb_status                         # Agent 主动建链（ensureDaemon）
  -> (未 ready: 重试 status / start → 仍失败才问用户浏览器)
  -> wb_navigate (group_title；session)
  -> wb_find | wb_snapshot
  -> wb_click | wb_fill
  -> wb_get_text | wb_screenshot | wb_wait
```

| Need | Tool |
|------|------|
| **建链 / 健康** | **`wb_status`（任务首次必调；MCP 内 ensureDaemon）** |
| Open | `wb_navigate` |
| Tabs | `wb_list_tabs` / `wb_find_tab` / `wb_close_tab` / `wb_close_session` |
| Structure | `wb_snapshot` / `wb_find` |
| Text | `wb_get_text` |
| Wait | `wb_wait` |
| Click / type | `wb_click`, `wb_fill`, `wb_press_key` |
| Scroll | `wb_scroll` |
| Capture | `wb_screenshot` (jpeg default) |
| Debug | `wb_console`, `wb_network`, `wb_evaluate` |
| Upload | `wb_upload` (local absolute paths) |

## Notes

- **New tab after click**: 只有唯一 openerTabId 关联的新标签才自动跟随，否则查看 newTabCandidates 后显式选择。
- **find_tab**: 使用列表中的精确 URL 或 tabId（通过唯一 URL 兼容选择）。重复 URL/选错页会报错，不会通过导航兜底。
- **Extras**（cdp/pdf/form/set_session）: `WEBBRIDGE_TOOL_PROFILE=full`。
- **OA / 运维**: 先 §0 建链 → `wb_navigate` OA → 登录态不足再请用户登录；`tools/fetch_oa_readonly.py` 等同理依赖已连上的 WebBridge。

## 1.3 严格操作流程

- selector 与 target 二选一；target 支持 css 或 role/name/within。不要在 ambiguous_target 时猜候选。
- wb_snapshot/wb_find 后推荐使用 target.ref + snapshotId；旧引用失效则重新观察。
- click/check/dblclick 的 inputMode=auto 在可见页用 CDP、后台页用 DOM；mode 会如实返回。要求可信输入时显式 inputMode=cdp，并让目标标签可见。
- wb_fill/wb_check/wb_select 自动验证状态；click 等传 expect 或随后观察页面，不能把 verified=false 当任务成功。
- outcome_unknown 表示可能已执行；先检查页面，再决定是否重试，避免重复提交。
- wb_scroll 的 container 指定滚动容器；moved=null 表示仅发出滚轮，尚未验证位移。
- compact 28 工具，含 hover/dblclick/type/select/check/drag；full 32 工具。跨域 iframe、窗口管理、下载事件及原生 ID 路由尚未实现，查看 wb_status.capabilities。
