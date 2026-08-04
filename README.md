# kimi-webbridge-mcp

把已安装的 **[Kimi WebBridge](https://www.kimi.com/features/webbridge)**（本地 daemon + 浏览器扩展）暴露成标准 **MCP** 工具，供 **Grok Build / Claude Code / Cursor** 等客户端直接调用。

- 控制**用户真实浏览器**（复用登录态 / Cookie，不导出 Cookie）
- 无需每次写 `curl` 脚本
- 含 Claude-in-Chrome 风格便利工具：`get_text` / `find` / `press_key` / `scroll` / `wait` / `console` 等

```text
MCP Client (Grok / Claude / Cursor)
        │ stdio MCP
        ▼
kimi-webbridge-mcp  (本仓库)
        │ HTTP  http://127.0.0.1:10086
        ▼
kimi-webbridge daemon
        │ WebSocket
        ▼
Chrome / Edge 扩展 → 真实页面
```

> 本项目是独立开源适配层，与 Moonshot / Kimi / xAI **无隶属关系**。使用前需自行安装官方 WebBridge 扩展与 daemon。

---

## 前置条件（每位同事都要）

1. **Node.js 20+**
2. **Kimi WebBridge 已安装并运行**
   - 二进制：`~/.kimi-webbridge/bin/kimi-webbridge`（Windows: `%USERPROFILE%\.kimi-webbridge\bin\kimi-webbridge.exe`）
   - 浏览器扩展已启用（Chrome 或 Edge）
   - 帮助： [中文](https://www.kimi.com/zh-cn/features/webbridge) · [English](https://www.kimi.com/features/webbridge)
3. 确认连通：

```powershell
# Windows
& "$env:USERPROFILE\.kimi-webbridge\bin\kimi-webbridge.exe" start
# 应看到 extension_connected: true
```

```bash
# macOS / Linux
~/.kimi-webbridge/bin/kimi-webbridge start
curl -s http://127.0.0.1:10086/status
```

---

## 安装本 MCP

```bash
git clone https://github.com/Nimm0ny/kimi-webbridge-mcp.git
cd kimi-webbridge-mcp
npm install
npm run doctor
```

`doctor` 通过（`extension_connected: true`）后再接入客户端。

---

## 接入 Grok Build

编辑 `~/.grok/config.toml`（把路径换成你的 clone 绝对路径）：

```toml
[mcp_servers.kimi-webbridge]
command = "node"
args = ["D:\\path\\to\\kimi-webbridge-mcp\\src\\index.js"]
enabled = true
startup_timeout_sec = 15
tool_timeout_sec = 120
```

验证：

```bash
grok mcp doctor kimi-webbridge
```

正常应发现 **约 28 个** `wb_*` 工具。改代码后需重启 Grok 会话或在 `/mcps` 刷新。

---

## 接入 Claude Code

```bash
claude mcp add kimi-webbridge -- node /absolute/path/to/kimi-webbridge-mcp/src/index.js
```

或写入 Claude / Cursor 的 MCP JSON：

```json
{
  "mcpServers": {
    "kimi-webbridge": {
      "command": "node",
      "args": ["/absolute/path/to/kimi-webbridge-mcp/src/index.js"]
    }
  }
}
```

---

## 工具一览

### 核心

| Tool | 作用 |
|------|------|
| `wb_status` | daemon + 扩展是否就绪 |
| `wb_set_session` | 设置任务 session（标签组） |
| `wb_navigate` | 打开 URL |
| `wb_find_tab` / `wb_list_tabs` / `wb_close_*` | 标签管理 |
| `wb_snapshot` | a11y 树 + `@e` 引用 |
| `wb_click` / `wb_fill` | 点击 / 填表 |
| `wb_evaluate` / `wb_cdp` | 页面 JS / 原始 CDP |
| `wb_screenshot` / `wb_save_as_pdf` | 截图 / PDF |
| `wb_network` / `wb_upload` | 网络 / 上传 |

### Claude-in-Chrome 风格

| Tool | 作用 |
|------|------|
| `wb_get_text` | 抽取可见正文 |
| `wb_find` | 按文案/role 搜 `@e` |
| `wb_press_key` | 按键 / 快捷键 |
| `wb_scroll` | 滚动 |
| `wb_wait` | 等文本/选择器 |
| `wb_console` | start/list 控制台 |
| `wb_go_back` / `wb_go_forward` / `wb_reload` | 后退/前进/刷新 |
| `wb_hover` / `wb_dblclick` | 悬停 / 双击 |
| `wb_fill_form` | 批量填表 |

推荐流程：

```text
wb_status → wb_navigate → wb_find / wb_snapshot → wb_click / wb_fill
```

---

## 环境变量

| 变量 | 默认 | 含义 |
|------|------|------|
| `WEBBRIDGE_URL` | `http://127.0.0.1:10086` | daemon 地址 |
| `WEBBRIDGE_SESSION` | `grok-webbridge` | 默认 session 名 |
| `WEBBRIDGE_TIMEOUT_MS` | `120000` | 单次命令超时 |

可选写入 MCP `env`：

```toml
[mcp_servers.kimi-webbridge.env]
WEBBRIDGE_SESSION = "team-shared-task"
```

---

## 与 chrome-devtools-mcp

| | kimi-webbridge-mcp | chrome-devtools-mcp |
|--|--------------------|---------------------|
| 浏览器 | 用户日常 profile | 常为独立自动化实例 |
| 登录态 | 自动复用 | 需另配 |
| 适用 | 已登录站点、真实操作 | 性能 trace、干净环境 |

可同时启用。

---

## 开发

```bash
npm start          # 启动 MCP (stdio)
npm run doctor     # 检查 daemon / 扩展
npm run smoke      # 端到端冒烟（需扩展已连接）
```

---

## 安全说明

- 仅连接本机 `127.0.0.1:10086`，不向外发送 Cookie。
- Agent 能操作你浏览器里**已登录**的站点，请勿在不受信任环境启用。
- 不要把含密钥的页面截图发到公开渠道。

---

## License

MIT
