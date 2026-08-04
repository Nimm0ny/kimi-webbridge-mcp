#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  WebBridgeClient,
  daemonBinaryPath,
  packageVersion,
} from "./client.js";
import { expectedToolCount, getProfile, profileInfo } from "./tool-profile.js";

const client = new WebBridgeClient();
const version = packageVersion();
const info = profileInfo();

console.log("kimi-webbridge-mcp doctor");
console.log("mcp_version:", version);
console.log("tool_profile:", info.profile);
console.log("expected_tools:", expectedToolCount());
console.log("compact_tools:", info.compactCount, "full_only:", info.fullOnlyCount);
console.log("binary:", daemonBinaryPath(), existsSync(daemonBinaryPath()) ? "OK" : "MISSING");
console.log(
  "click_borrow_active:",
  String(process.env.WEBBRIDGE_CLICK_BORROW_ACTIVE || "0"),
  "(set 1 only if sites open tabs outside the agent group)",
);

const skillPath = join(homedir(), ".grok", "skills", "kimi-webbridge", "SKILL.md");
console.log("grok_skill:", skillPath, existsSync(skillPath) ? "OK" : "MISSING (optional)");

try {
  const ensured = await client.ensureDaemon();
  console.log("daemon:", ensured.started ? "started" : "already running");
  console.log("status:", JSON.stringify(ensured.status, null, 2));
  if (!ensured.status?.extension_connected) {
    console.log("\nWARNING: extension not connected.");
    console.log("Open Chrome/Edge with Kimi WebBridge extension enabled.");
    console.log("https://www.kimi.com/zh-cn/features/webbridge");
    process.exitCode = 2;
  } else {
    console.log("\nOK: extension connected.");
  }
  console.log("\n" + info.note);
} catch (err) {
  console.error("FAILED:", err.message);
  process.exitCode = 1;
}
