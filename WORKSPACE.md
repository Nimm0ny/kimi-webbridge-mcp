# Workspace

Dedicated directory for kimi-webbridge-mcp development.

- Repo: https://github.com/Nimm0ny/kimi-webbridge-mcp
- Grok MCP entry: `D:\py_pj\kimi-webbridge-mcp\src\index.js`
- Skill source: `skills/kimi-webbridge` (copy to `~\.grok\skills\` after edits)
- Default tool profile: **compact** (28 tools; full: 32). Full extras need `WEBBRIDGE_TOOL_PROFILE=full`.

```powershell
cd D:\py_pj\kimi-webbridge-mcp
npm run doctor
npm run smoke
npm test
# After skill edits:
Copy-Item -Recurse -Force skills\kimi-webbridge\* $env:USERPROFILE\.grok\skills\kimi-webbridge\
```

Legacy path `%USERPROFILE%\.kimi-webbridge\mcp` is no longer the Grok target; prefer this folder for all tuning.

After code changes, **reload Grok MCP** and check `wb_status` for `mcp_version`, `tool_profile`, `tool_count`.
