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
- **默认 compact 28 个工具，full 32 个工具**
- `WEBBRIDGE_TOOL_PROFILE=full` 开启 cdp / pdf / fill_form / set_session
- 严格定位 + 自动等待 + 状态验证；支持 Shadow DOM、右键、拖拽、勾选和下拉选择
- 截图默认 JPEG quality 55，保留原文件并自动生成小图预览；操作结果区分 `dispatched` / `verified`

> 独立开源适配层，与 Moonshot / Kimi / xAI 无隶属关系。需自行安装官方 WebBridge。

---

## 前置条件

1. Node.js 20.9+
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
# wb_status 应显示 tool_profile=compact 与 tool_count=28
```

---

## 工具摘要

### Compact（默认）

`wb_status` · `wb_navigate` · `wb_go_back` · `wb_go_forward` · `wb_reload` · `wb_list_tabs` · `wb_find_tab` · `wb_close_tab` · `wb_close_session` · `wb_snapshot` · `wb_get_text` · `wb_find` · `wb_wait` · `wb_click` · `wb_fill` · `wb_press_key` · `wb_scroll` · `wb_evaluate` · `wb_screenshot` · `wb_network` · `wb_console` · `wb_upload` · `wb_hover` · `wb_dblclick` · `wb_type` · `wb_select` · `wb_check` · `wb_drag`

### Full only

`wb_set_session` · `wb_fill_form` · `wb_cdp` · `wb_save_as_pdf`

精确数量以 `npm run smoke` / `wb_status.tool_count` 为准（由 `src/tool-profile.js` 单一源计算）。

---

## 环境变量

| 变量 | 默认 | 含义 |
|------|------|------|
| `WEBBRIDGE_URL` | `http://127.0.0.1:10086` | daemon（**仅允许 localhost**） |
| `WEBBRIDGE_SESSION` | `grok-webbridge` | 默认 session |
| `WEBBRIDGE_TIMEOUT_MS` | `120000` | 单次 command 超时 |
| `WEBBRIDGE_TOOL_PROFILE` | `compact` | `compact` \| `full` |
| `WEBBRIDGE_CLICK_BORROW_ACTIVE` | 已废弃 | 自动借用当前标签已移除；只跟随有明确 opener 关系的新标签 |
| `WEBBRIDGE_SCREENSHOT_ATTEMPT_MS` | `45000` | 截图单次尝试超时 |
| `WEBBRIDGE_MAX_EMBED_BYTES` | `400000` | 图片嵌入上限；超限截图生成 JPEG 预览并标注原始/预览尺寸 |
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
npm test            # 独立无头 Chrome 回归测试 + 单元测试
npm run smoke:e2e    # 真实 MCP → daemon → 扩展，本地 fixture，自动清理专用测试 session
```

## 安全

- 只连本机 `:10086`（非 localhost 的 `WEBBRIDGE_URL` 会被拒绝）
- Agent 可操作**已登录**站点；勿在不受信任务中启用
- **compact 含 `wb_evaluate`**（页面 JS，可触及页面可见状态；勿用于窃取密钥）
- **full 含 `wb_cdp`**：权限更大，仅在需要时开启
- 登录 / 验证码 / 扫码：在真实浏览器由用户完成，不要把密码写进对话

## License

MIT

## 1.3 操作契约与示例

旧的 selector 参数仍可用；也可以传 target（两者只能选一个）：

```json
{
  "target": { "role": "button", "name": "保存", "exact": true, "within": "#profile-dialog" },
  "followNewTab": false,
  "expect": { "text": "保存成功" },
  "timeoutMs": 10000
}
```

- **定位**：CSS、常见 role/name、within 容器支持打开的 Shadow DOM。匹配多个节点时返回 ambiguous_target 和候选；名称解析覆盖 aria-labelledby / aria-label / label，但不是完整 ARIA 算法。
- **引用**：wb_snapshot / wb_find 返回 snapshotId。推荐 target={ref:"@e1",snapshotId:"…"}；引用绑定实际 DOM 节点，脱离文档/导航后失效。裸 @e 使用该 session 最近一次快照。重复名称或不支持的角色可能无法绑定，改用带范围的 CSS。
- **等待**：输入前检查唯一性、可见性、可用性、位置稳定和遮挡；wb_wait 默认 visible，可选 hidden/attached/detached/enabled，多条件使用 AND。
- **输入方式**：click/check/dblclick 的 inputMode=auto（默认）在可见标签使用 CDP，后台标签使用 DOM。返回 mode 明确说明真实执行方式。inputMode=cdp 不会自动退回 DOM；后台标签返回 tab_not_visible。DOM 事件不是可信输入。右键/中键和 pointer drag 需要可见标签。
- **验证**：fill/check/select 自动读回状态；click/hover/dblclick/drag 可传 expect（text/selector/url/state）。verified=false 只表示已发送动作。timeoutMs 控制单次操作阶段，expect 和 followTimeoutMs 是后续独立阶段；HTTP 超时返回 outcome_unknown，禁止直接重试提交。
- **滚动**：selector 表示滚入视野；container 表示对指定 CSS 容器滚动；默认滚动 document.scrollingElement。滚轮兜底无法确认虚拟列表移动时返回 moved=null、verified=false。
- **标签**：wb_find_tab 支持 tabId → 唯一 URL 的兼容选择和严格 URL 校验；上游仍按 URL 选择，重复 URL 明确拒绝。同域不同路径若被桥接选错，返回 tab_selection_mismatch，绝不导航覆盖页面。
- **新标签**：只自动跟随唯一且 openerTabId 对得上的新增标签。当前桥接若不提供 openerTabId，返回候选让 Agent 显式选择，不猜最后一个标签。
- **并发**：同一 MCP 进程内完整工具操作串行，避免 session 切换与输入交错。不同 MCP 进程及用户手动操作不受该队列保护。
- **批量表单**：遇到第一个失败即停止，报告 completed/failed 的 results 和 skipped 数量；不会自动回滚已填字段。
- **截图**：保留用户请求的 PNG/JPEG 文件格式，返回 MCP image。大图预览可转 JPEG；preview 字段给出尺寸。截图重试总预算默认 60 秒，前置连接启动和本地预览编码可能另耗时间。

## 能力边界

wb_status.capabilities 区分 MCP 已实现能力和桥接依赖。本版未实现跨域 iframe 路由、闭合 Shadow DOM、浏览器窗口管理、下载事件订阅、原生按 tabId 路由或截图坐标输入。wb_drag 是 CDP 指针拖拽，不模拟 HTML5 DataTransfer。上述能力需要后续扩展/daemon 协议工作，不能只增加工具名。

## 回归测试

`npm test` 默认使用已安装的 Chrome 启动独立无头实例，不读取日常 profile。可设置 WB_TEST_BROWSER=msedge 使用 Edge；只跑不依赖浏览器的测试可用 `npm run test:unit`。无浏览器的 CI 可先运行 `npx playwright install chromium`，并设置 WB_TEST_BROWSER=chromium。

`npm run smoke:e2e` 在 127.0.0.1 临时提供 fixtures/actions.html，经 MCP stdio 调用真实桥接。任何 isError、验证失败或缺失图片内容块都会使测试失败。每次使用唯一 session，finally 关闭它并停止临时服务器。

本机验证：daemon v1.11.5 / extension 2.0.1 报版本不一致，但上述表单、后台 DOM 点击和图片回传链路通过；这不代表所有上游能力都兼容。可信双击/指针拖拽由独立可见页面的无头浏览器测试覆盖。
