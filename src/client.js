import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_BASE = process.env.WEBBRIDGE_URL?.replace(/\/$/, "") || "http://127.0.0.1:10086";
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
  constructor({ baseUrl = DEFAULT_BASE, timeoutMs = DEFAULT_TIMEOUT_MS, session } = {}) {
    this.baseUrl = baseUrl;
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

  async status() {
    return this.#get("/status");
  }

  async ensureDaemon({ startIfNeeded = true } = {}) {
    try {
      const s = await this.status();
      return { ok: true, started: false, status: s };
    } catch (err) {
      if (!startIfNeeded) throw err;
    }

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
        const s = await this.status();
        return { ok: true, started: true, status: s };
      } catch {
        // retry
      }
    }
    throw new Error("daemon start timed out — is port 10086 blocked?");
  }

  async command(action, args = {}, { session, requireExtension = true } = {}) {
    await this.ensureDaemon();
    if (requireExtension) {
      const s = await this.status();
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
      session: session || this.session,
    };

    return this.#post("/command", body);
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
      if (err?.name === "AbortError") throw new Error(`GET ${path} timed out`);
      if (err?.cause?.code === "ECONNREFUSED" || /fetch failed|ECONNREFUSED/i.test(String(err))) {
        throw new Error(`WebBridge daemon not reachable at ${this.baseUrl}${path}`);
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  async #post(path, body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
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
      // Daemon may return 200 with success:false
      if (data && data.success === false) {
        const msg = data.error || data.message || JSON.stringify(data);
        throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      }
      return data;
    } catch (err) {
      if (err?.name === "AbortError") throw new Error(`POST ${path} timed out after ${this.timeoutMs}ms`);
      if (err?.cause?.code === "ECONNREFUSED" || /fetch failed|ECONNREFUSED/i.test(String(err?.message))) {
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
