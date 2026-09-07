import { writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolError, asToolError } from "./errors.js";
import { evaluateJson, sleep } from "./page-actions.js";
import sharp from "sharp";

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
  const deadline = Date.now() + (opts.timeoutMs ?? 60000);
  const remaining = () => {
    if (Date.now() >= deadline) throw new ToolError("Screenshot budget exhausted", { code: "screenshot_timeout" });
    return Math.min(ATTEMPT_MS, deadline - Date.now());
  };

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
        visible: document.visibilityState,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        scroll: { x: scrollX, y: scrollY }
      }))()`,
      session,
      remaining(),
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

  const daemonShot = async (format, quality) => {
    const args = { format };
    if (quality != null) args.quality = quality;
    if (selector) args.selector = selector;
    if (outPath) args.path = outPath;
    return client.command("screenshot", args, {
      session,
      timeoutMs: remaining(),
    });
  };

  const errors = [];

  // Attempt 1: requested / default jpeg
  try {
    const r = await daemonShot(format, quality, 1);
    return preview(annotate(r, { format, quality, page, mode: "daemon", attempt: 1 }));
  } catch (err) {
    errors.push(String(err.problem || err.message));
  }

  // Attempt 2: smaller jpeg (skip if selector-only failure without timeout)
  try {
    const r = await daemonShot(format, format === "jpeg" ? 40 : undefined, 2);
    return preview(annotate(r, {
      format,
      quality: format === "jpeg" ? 40 : undefined,
      page,
      mode: "daemon-retry",
      attempt: 2,
      prior: errors,
    }));
  } catch (err) {
    errors.push(String(err.problem || err.message));
  }

  // Attempt 3: CDP fallback (viewport; selector ignored)
  if (!selector) {
    try {
      const cdpResult = await cdpCaptureJpeg(client, session, outPath, 45, format, remaining);
      return preview(annotate(cdpResult, {
        format,
        quality: format === "jpeg" ? 45 : undefined,
        page,
        mode: "cdp-fallback",
        attempt: 3,
        prior: errors,
        note: "Daemon screenshot timed out; used CDP Page.captureScreenshot (viewport).",
      }));
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

async function cdpCaptureJpeg(client, session, outPath, quality, format, remaining) {
  const response = await client.command("cdp", { method: "Page.captureScreenshot",
    params: { format, ...(format === "jpeg" ? { quality: quality ?? 45 } : {}), fromSurface: true } },
    { session, timeoutMs: remaining() });
  const raw = response?.data ?? response;
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
    join(dir, `cdp_${Date.now()}.${format === "png" ? "png" : "jpg"}`);
  writeFileSync(path, Buffer.from(b64, "base64"));
  return {
    ok: true,
    data: {
      format,
      path,
      sizeBytes: Buffer.from(b64, "base64").length,
      mimeType: `image/${format}`,
    },
  };
}

// Preserve the original file. A bounded preview is for model observation only;
// publish its dimensions so it cannot be mistaken for original coordinates.
async function preview(result) {
  const artifact = result?.data && typeof result.data === "object" ? result.data : result;
  const cap = Number(process.env.WEBBRIDGE_MAX_EMBED_BYTES || 400000);
  if (!artifact?.path || !existsSync(artifact.path)) return result;
  try {
    const metadata = await sharp(artifact.path).metadata();
    artifact.imageDimensions = { width: metadata.width, height: metadata.height };
    if (statSync(artifact.path).size <= cap) return result;
    for (const width of [1600, 1200, 900, 600, 400]) {
      const bytes = await sharp(artifact.path).resize({ width, withoutEnlargement: true }).jpeg({ quality: 60 }).toBuffer();
      if (bytes.length > cap) continue;
      const dir = join(tmpdir(), "kimi-webbridge-screenshots"); mkdirSync(dir, { recursive: true });
      const path = join(dir, `preview_${Date.now()}_${width}.jpg`);
      writeFileSync(path, bytes);
      const resized = await sharp(bytes).metadata();
      artifact.preview = { path, mimeType: "image/jpeg", width: resized.width, height: resized.height, originalWidth: metadata.width, originalHeight: metadata.height };
      break;
    }
  } catch (err) { artifact.previewError = err.message; }
  return result;
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
