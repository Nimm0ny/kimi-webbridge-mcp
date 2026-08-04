import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolError, asToolError } from "./errors.js";
import { cdp, evaluateJson, sleep } from "./page-actions.js";

/** Per-attempt daemon/HTTP timeout (keep under typical MCP client 60–120s budgets). */
const ATTEMPT_MS = Number(process.env.WEBBRIDGE_SCREENSHOT_ATTEMPT_MS || 45_000);
const PDF_TIMEOUT_MS = Number(process.env.WEBBRIDGE_PDF_TIMEOUT_MS || 90_000);

/**
 * Hardened screenshot:
 * 1) jpeg default (fast)
 * 2) short settle, no long wait
 * 3) one daemon retry at lower quality
 * 4) CDP Page.captureScreenshot fallback (often more reliable)
 * Errors always include problem + hint.
 */
export async function screenshotSmart(client, opts = {}, session) {
  const { format: fmtIn, quality: qualityIn, selector, path: outPath } = opts;

  // Prefer jpeg — png full-page is the main timeout culprit
  let format = fmtIn || "jpeg";
  // Keep in sync with wb_screenshot schema description (default 55)
  let quality = qualityIn ?? (format === "jpeg" ? 55 : undefined);

  let page = null;
  try {
    page = await evaluateJson(
      client,
      `(() => JSON.stringify({
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        visible: document.visibilityState
      }))()`,
      session,
    );
  } catch {
    /* ignore */
  }

  if (page?.href && /^(chrome|edge|about|devtools):/i.test(page.href)) {
    throw new ToolError("Cannot screenshot browser-internal page", {
      code: "screenshot_internal_page",
      detail: page,
      hint: "Navigate to an http(s) page first with wb_navigate.",
    });
  }

  // Brief settle only
  await sleep(80);

  const daemonShot = async (format, quality, attempt) => {
    const args = { format };
    if (quality != null) args.quality = quality;
    if (selector) args.selector = selector;
    if (outPath) args.path = outPath;
    return client.command("screenshot", args, {
      session,
      timeoutMs: ATTEMPT_MS,
    });
  };

  const errors = [];

  // Attempt 1: requested / default jpeg
  try {
    const r = await daemonShot(format, quality, 1);
    return annotate(r, { format, quality, page, mode: "daemon", attempt: 1 });
  } catch (err) {
    errors.push(String(err.problem || err.message));
  }

  // Attempt 2: smaller jpeg (skip if selector-only failure without timeout)
  try {
    const r = await daemonShot("jpeg", 40, 2);
    return annotate(r, {
      format: "jpeg",
      quality: 40,
      page,
      mode: "daemon-retry",
      attempt: 2,
      prior: errors,
    });
  } catch (err) {
    errors.push(String(err.problem || err.message));
  }

  // Attempt 3: CDP fallback (viewport; selector ignored)
  if (!selector) {
    try {
      const cdpResult = await cdpCaptureJpeg(client, session, outPath, 45);
      return annotate(cdpResult, {
        format: "jpeg",
        quality: 45,
        page,
        mode: "cdp-fallback",
        attempt: 3,
        prior: errors,
        note: "Daemon screenshot timed out; used CDP Page.captureScreenshot (viewport).",
      });
    } catch (err) {
      errors.push(`cdp: ${err.message}`);
    }
  }

  throw new ToolError("Screenshot failed after daemon retry and CDP fallback", {
    code: "screenshot_exhausted",
    detail: { page, errors, selector: selector || null },
    hint: "Ensure the Edge tab is visible (not sleeping). Prefer format=jpeg quality=40–60. Crop with selector only when the element is on-screen. Avoid full-page png on huge sites. Check wb_status.extension_connected.",
  });
}

async function cdpCaptureJpeg(client, session, outPath, quality) {
  try {
    await cdp(client, "Page.enable", {}, session);
  } catch {
    /* may already be enabled */
  }
  const raw = await cdp(
    client,
    "Page.captureScreenshot",
    { format: "jpeg", quality: quality ?? 45, fromSurface: true },
    session,
  );
  // CDP response shapes vary: { data } or nested
  const b64 =
    raw?.data ||
    raw?.result?.data ||
    raw?.value?.data ||
    (typeof raw === "object" && raw !== null
      ? Object.values(raw).find((v) => typeof v === "string" && v.length > 200)
      : null);
  if (!b64 || typeof b64 !== "string") {
    throw new Error(`CDP capture returned no image data: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const dir = join(tmpdir(), "kimi-webbridge-screenshots");
  mkdirSync(dir, { recursive: true });
  const path =
    outPath ||
    join(dir, `cdp_${Date.now()}.jpg`);
  writeFileSync(path, Buffer.from(b64, "base64"));
  return {
    ok: true,
    data: {
      format: "jpeg",
      path,
      sizeBytes: Buffer.from(b64, "base64").length,
      mimeType: "image/jpeg",
    },
  };
}

function annotate(raw, meta) {
  if (raw && typeof raw === "object") {
    if (raw.data && typeof raw.data === "object") {
      return { ...raw, data: { ...raw.data, capture: meta } };
    }
    return { ...raw, capture: meta };
  }
  return raw;
}

export async function savePdfSmart(client, opts = {}, session) {
  try {
    return await client.command("save_as_pdf", opts, {
      session,
      timeoutMs: PDF_TIMEOUT_MS,
    });
  } catch (err) {
    throw asToolError(err, {
      problem: /timed out/i.test(err.message) ? "PDF export timed out" : "PDF export failed",
      hint: "Try scale=0.6, print_background=false, or a simpler page. Ensure tab is http(s).",
      code: "pdf_failed",
    });
  }
}
