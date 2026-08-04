#!/usr/bin/env node
import { WebBridgeClient, daemonBinaryPath } from "./client.js";
import { existsSync } from "node:fs";

const client = new WebBridgeClient();

console.log("kimi-webbridge-mcp doctor");
console.log("binary:", daemonBinaryPath(), existsSync(daemonBinaryPath()) ? "OK" : "MISSING");

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
