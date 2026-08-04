#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  WebBridgeClient,
  daemonBinaryPath,
  expectedToolCount,
  packageVersion,
} from "./client.js";

const client = new WebBridgeClient();
const version = packageVersion();
const tools = expectedToolCount();

console.log("kimi-webbridge-mcp doctor");
console.log("mcp_version:", version);
console.log("expected_tools:", tools);
console.log("binary:", daemonBinaryPath(), existsSync(daemonBinaryPath()) ? "OK" : "MISSING");

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
} catch (err) {
  console.error("FAILED:", err.message);
  process.exitCode = 1;
}
