# kimi-webbridge-mcp

把 **[Kimi WebBridge](https://www.kimi.com/features/webbridge)**（daemon + 浏览器扩展）接到 Agent，采用与 **Claude in Chrome 相同的架构分层**（不是去接入 Claude 产品）：

| 层 | 本仓库 | 作用 |
|----|--------|------|
| **Skill**（薄） | `skills/kimi-webbridge/SKILL.md` | 何时用、工作流、禁止 curl |
| **MCP** | `src/index.js` | 真正执行：`wb_*` 工具 |

```text
Grok Build（或其它 MCP 客户端）
   ├── Skill   路由 + 用法约定
   └── MCP     kimi-webbridge  →  :10086 daemon  →  扩展  →  真实浏览器
```

- 真实浏览器 profile / 登录态（**不导出 Cookie**）
- **默认 compact ≈ 22 个工具**（Claude-in-Chrome 体量，少而稳）
- `WEBBRIDGE_TOOL_PROFILE=full` 才开启 cdp / pdf / hover / fill_form 等扩展
- 错误带 `problem` + `hint`；截图 jpeg 默认 quality 55 + 重试；`click` 跟随 session 新标签；`scroll` 支持 SPA/视频页

> 独立开源适配层，与 Moonshot / Kimi / xAI 无隶属关系。需自行安装官方 WebBridge。

---

## 前置条件

1. Node.js 20+
2. Kimi WebBridge 已安装，浏览器扩展一般已启用（装一次即可）  
   - 帮助：[中文](https://www.kimi.com/zh-cn/features/webbridge) · [English](https://www.kimi.com/features/webbridge)
3. **Agent 主动建链**（扩展通常已装好，**不要**默认让用户去点扩展）：

```text
wb_status  →  MCP ensureDaemon（daemon 未跑则自动 start :10086）
           →  ready=true 后再 wb_navigate / 业务工具
```

排障也可手动：

```powershell
& "$env:USERPROFILE\.kimi-webbridge\bin\kimi-webbridge.exe" start
& "$env:USERPROFILE\.kimi-webbridge\bin\kimi-webbridge.exe" status
```

详见 Skill `skills/kimi-webbridge/SKILL.md` §0。

---

## 安装（MCP + Skill）

```bash
git clone https://github.com/Nimm0ny/kimi-webbridge-mcp.git
cd kimi-webbridge-mcp
npm install
npm run doctor
```

### Grok Build

**MCP** — `~/.grok/config.toml`（路径改成你的 clone）：

```toml
[mcp_servers.kimi-webbridge]
command = "node"
args = ["D:\\path\\to\\kimi-webbridge-mcp\\src\\index.js"]
enabled = true
startup_timeout_sec = 15
tool_timeout_sec = 180

[mcp_servers.kimi-webbridge.env]
WEBBRIDGE_TOOL_PROFILE = "compact"
# Optional: only if sites open tabs outside the agent group
# WEBBRIDGE_CLICK_BORROW_ACTIVE = "1"
```

**Skill**（薄 playbook）：

```powershell
Copy-Item -Recurse -Force skills\kimi-webbridge "$env:USERPROFILE\.grok\skills\kimi-webbridge"
```

验证：

```bash
grok mcp doctor kimi-webbridge
# 或
npm run doctor
# wb_status 应显示 tool_profile=compact 与 tool_count≈22
```

---

## 工具摘要

### Compact（默认）

`wb_status` · `wb_navigate` · `wb_go_back` · `wb_go_forward` · `wb_reload` · `wb_list_tabs` · `wb_find_tab` · `wb_close_tab` · `wb_close_session` · `wb_snapshot` · `wb_get_text` · `wb_find` · `wb_wait` · `wb_click` · `wb_fill` · `wb_press_key` · `wb_scroll` · `wb_evaluate` · `wb_screenshot` · `wb_network` · `wb_console` · `wb_upload`

### Full only

`wb_set_session` · `wb_dblclick` · `wb_hover` · `wb_fill_form` · `wb_cdp` · `wb_save_as_pdf`

精确数量以 `npm run smoke` / `wb_status.tool_count` 为准（由 `src/tool-profile.js` 单一源计算）。

---

## 环境变量

| 变量 | 默认 | 含义 |
|------|------|------|
| `WEBBRIDGE_URL` | `http://127.0.0.1:10086` | daemon（**仅允许 localhost**） |
| `WEBBRIDGE_SESSION` | `grok-webbridge` | 默认 session |
| `WEBBRIDGE_TIMEOUT_MS` | `120000` | 单次 command 超时 |
| `WEBBRIDGE_TOOL_PROFILE` | `compact` | `compact` \| `full` |
| `WEBBRIDGE_CLICK_BORROW_ACTIVE` | `0` | `1` 时 click 可借用浏览器当前 active tab（跨 session 组；默认关） |
| `WEBBRIDGE_SCREENSHOT_ATTEMPT_MS` | `45000` | 截图单次尝试超时 |
| `WEBBRIDGE_MAX_EMBED_BYTES` | `400000` | 截图 base64 嵌入上限 |
| `WEBBRIDGE_STATUS_CACHE_MS` | `1500` | status 缓存 TTL |

---

## 与 chrome-devtools-mcp

| | 本项目 | chrome-devtools |
|--|--------|-----------------|
| 浏览器 | 日常 profile | 常为独立实例 |
| 登录态 | 复用 | 另配 |
| 角色 | 真实站点操作 | 性能 / 干净环境 |

---

## 开发

```bash
npm start            # MCP stdio (compact)
npm run doctor       # daemon + extension + profile + tool count
npm run smoke        # list-only compact tools
# full list-only:
#   PowerShell: $env:WEBBRIDGE_TOOL_PROFILE='full'; npm run smoke
npm run smoke:e2e    # browser smoke with full profile (dev clone)
```

## 安全

- 只连本机 `:10086`（非 localhost 的 `WEBBRIDGE_URL` 会被拒绝）
- Agent 可操作**已登录**站点；勿在不受信任务中启用
- **compact 含 `wb_evaluate`**（页面 JS，可触及页面可见状态；勿用于窃取密钥）
- **full 含 `wb_cdp`**：权限更大，仅在需要时开启
- 登录 / 验证码 / 扫码：在真实浏览器由用户完成，不要把密码写进对话

## License

MIT
