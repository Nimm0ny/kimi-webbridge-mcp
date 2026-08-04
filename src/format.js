import { readFileSync, existsSync } from "node:fs";

/**
 * Format a daemon result for MCP content blocks.
 * Screenshots/PDFs that return a filesystem path are attached as images when possible.
 */
export function formatResult(result, { preferImage = false } = {}) {
  if (result == null) {
    return { content: [{ type: "text", text: "null" }] };
  }

  const content = [];
  const path = typeof result.path === "string" ? result.path : null;
  const mime = result.mimeType || guessMime(path, result.format);

  if (preferImage && path && existsSync(path) && mime?.startsWith("image/")) {
    try {
      const buf = readFileSync(path);
      content.push({
        type: "image",
        data: buf.toString("base64"),
        mimeType: mime,
      });
    } catch {
      // fall through to text only
    }
  }

  content.push({
    type: "text",
    text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
  });

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
