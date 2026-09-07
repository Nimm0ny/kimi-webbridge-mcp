import { readFileSync, existsSync, statSync } from "node:fs";

/** Max image bytes to embed as base64 (default ~400KB). Larger → path-only. */
const MAX_EMBED_BYTES = Number(process.env.WEBBRIDGE_MAX_EMBED_BYTES || 400_000);

/**
 * Format a daemon result for MCP content blocks.
 * Screenshots/PDFs that return a filesystem path are attached as images when small enough.
 * Results with ok:false are marked isError so models do not treat them as success.
 */
export function formatResult(result, { preferImage = false } = {}) {
  if (result == null) {
    return { content: [{ type: "text", text: "null" }] };
  }

  const failed =
    (typeof result === "object" && result !== null && result.ok === false) ||
    (typeof result === "object" && result !== null && result.success === false) ||
    result?.data?.ok === false || result?.data?.success === false;

  const content = [];
  const originalArtifact = result?.data && typeof result.data === "object" ? result.data : result;
  const artifact = originalArtifact?.preview || originalArtifact;
  const path = typeof artifact?.path === "string" ? artifact.path : null;
  const mime =
    typeof result === "object" && result
      ? artifact.mimeType || guessMime(path, artifact.format)
      : undefined;

  let embedded = false;
  let skippedReason = !preferImage ? "not_requested" : !path ? "missing_path" : !existsSync(path) ? "file_missing" : "unsupported_mime";
  if (preferImage && path && existsSync(path) && mime?.startsWith("image/")) {
    try {
      const size = statSync(path).size;
      skippedReason = "over_size_cap";
      if (size <= MAX_EMBED_BYTES) {
        const buf = readFileSync(path);
        content.push({
          type: "image",
          data: buf.toString("base64"),
          mimeType: mime,
        });
        embedded = true;
      }
    } catch {
      skippedReason = "file_read_failed";
    }
  }

  const payload =
    typeof result === "string"
      ? result
      : JSON.stringify(
          embedded || !path
            ? result
            : { ...result, imageEmbedded: embedded, imageSkippedReason: skippedReason },
          null,
          2,
        );

  content.push({ type: "text", text: payload });

  if (failed) {
    return { content, isError: true };
  }
  return { content };
}

export function formatError(err) {
  const message = err?.message || String(err);
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

function guessMime(path, format) {
  if (format === "jpeg" || format === "jpg") return "image/jpeg";
  if (format === "png") return "image/png";
  if (format === "pdf") return "application/pdf";
  if (!path) return undefined;
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return undefined;
}
