import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { ToolError } from "./errors.js";

const require = createRequire(import.meta.url);
const PKG_VERSION = require("../package.json").version;

const STATUS_CACHE_TTL_MS = Number(process.env.WEBBRIDGE_STATUS_CACHE_MS || 1500);

function assertLocalBaseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid WEBBRIDGE_URL: ${url}`);
  }
  const host = (parsed.hostname || "").toLowerCase();
  const allowed = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (!allowed) {
    throw new Error(
      `WEBBRIDGE_URL must point at localhost (got host "${parsed.hostname}"). ` +
        `Only http://127.0.0.1:<port> / localhost / ::1 are allowed for safety.`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`WEBBRIDGE_URL must be http(s), got ${parsed.protocol}`);
  }
  return url.replace(/\/$/, "");
}

const DEFAULT_BASE = assertLocalBaseUrl(
  process.env.WEBBRIDGE_URL?.replace(/\/$/, "") || "http://127.0.0.1:10086",
);
const DEFAULT_TIMEOUT_MS = Number(process.env.WEBBRIDGE_TIMEOUT_MS || 120_000);

function daemonBinary() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  const win = process.platform === "win32";
  return join(home, ".kimi-webbridge", "bin", win ? "kimi-webbridge.exe" : "kimi-webbridge");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class WebBridgeClient {
  #statusCache = null;
  #statusCacheAt = 0;

  constructor({ baseUrl = DEFAULT_BASE, timeoutMs = DEFAULT_TIMEOUT_MS, session } = {}) {
    this.baseUrl = assertLocalBaseUrl(baseUrl);
    this.timeoutMs = timeoutMs;
    this.session = session || process.env.WEBBRIDGE_SESSION || "grok-webbridge";
  }

  setSession(session) {
    if (session && typeof session === "string" && session.trim()) {
      this.session = session.trim();
    }
    return this.session;
  }

  getSession() {
    return this.session;
  }

  /** Resolve per-call session without mutating the default. */
  resolveSession(session) {
    if (session && typeof session === "string" && session.trim()) return session.trim();
    return this.session;
  }

  invalidateStatusCache() {
    this.#statusCache = null;
    this.#statusCacheAt = 0;
  }

  async status({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.#statusCache && now - this.#statusCacheAt < STATUS_CACHE_TTL_MS) {
      return this.#statusCache;
    }
    const s = await this.#get("/status");
    this.#statusCache = s;
    this.#statusCacheAt = Date.now();
    return s;
  }

  async ensureDaemon({ startIfNeeded = true } = {}) {
    try {
      const s = await this.status();
      return { ok: true, started: false, status: s };
    } catch (err) {
      if (!startIfNeeded) throw err;
    }

    this.invalidateStatusCache();
    const bin = daemonBinary();
    if (!existsSync(bin)) {
      throw new Error(
        `kimi-webbridge binary not found at ${bin}. Install from https://www.kimi.com/features/webbridge`,
      );
    }

    await new Promise((resolve, reject) => {
      const child = spawn(bin, ["start"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout?.on("data", (d) => {
        out += d.toString();
      });
      child.stderr?.on("data", (d) => {
        out += d.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0 || /already|started|running/i.test(out)) resolve(out);
        else reject(new Error(`daemon start failed (code ${code}): ${out || "no output"}`));
      });
    });

    for (let i = 0; i < 20; i++) {
      await sleep(200);
      try {
        const s = await this.status({ force: true });
        return { ok: true, started: true, status: s };
      } catch {
        // retry
      }
    }
    throw new Error("daemon start timed out - is port 10086 blocked?");
  }

  async command(action, args = {}, { session, requireExtension = true, timeoutMs } = {}) {
    const deadline = Date.now() + (Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs);
    const ensured = await this.ensureDaemon();
    if (requireExtension) {
      // Reuse status from ensure when fresh; otherwise one cached/forced check
      let s = ensured.status;
      if (!s || Date.now() - this.#statusCacheAt > STATUS_CACHE_TTL_MS) {
        s = await this.status({ force: false });
      }
      if (!s.extension_connected) {
        // One forced recheck in case extension just connected
        s = await this.status({ force: true });
      }
      if (!s.extension_connected) {
        throw new Error(
          "WebBridge daemon is running but the browser extension is NOT connected. " +
            "Open Chrome/Edge with the Kimi WebBridge extension enabled, then retry. " +
            "Help: https://www.kimi.com/zh-cn/features/webbridge",
        );
      }
    }

    const body = {
      action,
      args: args ?? {},
      session: this.resolveSession(session),
    };

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ToolError("Connection preparation exhausted the command budget", {
      code: "preflight_timeout", detail: { action, outcome: "not_sent" }, hint: "Check wb_status before retrying.",
    });
    return this.#post("/command", body, remaining);
  }

  async #get(path) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.min(this.timeoutMs, 10_000));
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { signal: ctrl.signal });
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }
      if (!res.ok) {
        throw new Error(`GET ${path} → HTTP ${res.status}: ${text.slice(0, 500)}`);
      }
      return data;
    } catch (err) {
      this.invalidateStatusCache();
      if (err?.name === "AbortError") throw new Error(`GET ${path} timed out`);
      if (err?.cause?.code === "ECONNREFUSED" || /fetch failed|ECONNREFUSED/i.test(String(err))) {
        throw new Error(`WebBridge daemon not reachable at ${this.baseUrl}${path}`);
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  async #post(path, body, timeoutMs) {
    const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), limit);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }
      if (!res.ok) {
        const msg =
          data?.error || data?.message || data?.raw || text.slice(0, 800) || `HTTP ${res.status}`;
        throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      }
      if (data && data.success === false) {
        const msg = data.error || data.message || JSON.stringify(data);
        throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      }
      // Daemon soft-fail shapes: { ok:false, error } or nested data.ok:false
      if (data && data.ok === false) {
        const e = data.error || data.message || data;
        throw new Error(typeof e === "string" ? e : e?.message || JSON.stringify(e));
      }
      if (data?.data && (data.data.ok === false || data.data.success === false)) {
        const e = data.data.error || data.data.message || data.data;
        throw new Error(typeof e === "string" ? e : e?.message || JSON.stringify(e));
      }
      return data;
    } catch (err) {
      if (err?.name === "AbortError") {
        throw new ToolError(`Command timed out after ${limit}ms`, {
          code: "outcome_unknown", detail: { action: body?.action, outcome: "unknown" },
          hint: "The bridge may still execute the command. Inspect the page before retrying; do not repeat submissions automatically.",
        });
      }
      if (err?.cause?.code === "ECONNREFUSED" || /fetch failed|ECONNREFUSED/i.test(String(err?.message))) {
        this.invalidateStatusCache();
        throw new Error(`WebBridge daemon not reachable at ${this.baseUrl}`);
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }
}

export function daemonBinaryPath() {
  return daemonBinary();
}

export function packageVersion() {
  return PKG_VERSION;
}

export { expectedToolCount, getProfile, profileInfo } from "./tool-profile.js";

export function readIdentity() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  const p = join(home, ".kimi-webbridge", "identity.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
