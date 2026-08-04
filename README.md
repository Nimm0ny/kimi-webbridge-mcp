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

- 真实浏览器 profile / 登录态（不导出 Cookie）
- 无 curl 脚本；约 28 个 `wb_*` 工具
- 含 find / get_text / press_key / scroll / wait / console 等便利能力
- 错误带 `problem` + `hint`；截图默认 jpeg、超时自动降质重试 / CDP 回退；`find_tab` 支持模糊 URL 与 active 恢复

> 独立开源适配层，与 Moonshot / Kimi / xAI 无隶属关系。需自行安装官方 WebBridge。

---

## 前置条件

1. Node.js 20+
2. Kimi WebBridge 已安装，扩展已启用  
   - 帮助：[中文](https://www.kimi.com/zh-cn/features/webbridge) · [English](https://www.kimi.com/features/webbridge)
3. `extension_connected: true`：

```powershell
& "$env:USERPROFILE\.kimi-webbridge\bin\kimi-webbridge.exe" start
```

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
tool_timeout_sec = 120
```

**Skill**（薄 playbook）：

```powershell
Copy-Item -Recurse -Force skills\kimi-webbridge "$env:USERPROFILE\.grok\skills\kimi-webbridge"
```

```bash
mkdir -p ~/.grok/skills && cp -R skills/kimi-webbridge ~/.grok/skills/
```

验证：`grok mcp doctor kimi-webbridge`（约 28 个工具）。Skill 在新会话中生效。

任意其它 MCP 客户端只需挂同一 `node .../src/index.js`，Skill 拷到该客户端的 skills 目录即可。

---

## 工具摘要

**核心：** `wb_status` · `wb_navigate` · `wb_snapshot` · `wb_click` · `wb_fill` · `wb_evaluate` · `wb_cdp` · `wb_screenshot` · `wb_network` · `wb_upload` · 标签管理  

**便利（对齐 Claude-in-Chrome 能力面）：** `wb_get_text` · `wb_find` · `wb_press_key` · `wb_scroll` · `wb_wait` · `wb_console` · `wb_hover` · `wb_dblclick` · `wb_fill_form` · `wb_go_back` · `wb_go_forward` · `wb_reload`

默认流程见 Skill；细节见 `skills/kimi-webbridge/references/workflow.md`。

---

## 环境变量

| 变量 | 默认 | 含义 |
|------|------|------|
| `WEBBRIDGE_URL` | `http://127.0.0.1:10086` | daemon |
| `WEBBRIDGE_SESSION` | `grok-webbridge` | 默认 session |
| `WEBBRIDGE_TIMEOUT_MS` | `120000` | 超时 |

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
npm start            # MCP stdio
npm run doctor       # daemon + extension + version + skill path
npm run smoke        # list-only (28 tools, no browser)
npm run smoke:e2e    # full browser e2e (needs extension; dev clone)
```

## 安全

- 只连本机 `:10086`
- Agent 可操作已登录站点，勿在不受信环境启用

## License

MIT
