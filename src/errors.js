/**
 * Structured, agent-friendly errors ("problem lines").
 * Always include: problem (one line) + hint (what to try next).
 */

export class ToolError extends Error {
  constructor(problem, { hint, detail, code, cause } = {}) {
    const parts = [`problem: ${problem}`];
    if (detail) parts.push(`detail: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    if (hint) parts.push(`hint: ${hint}`);
    if (code) parts.push(`code: ${code}`);
    super(parts.join("\n"));
    this.name = "ToolError";
    this.problem = problem;
    this.hint = hint;
    this.detail = detail;
    this.code = code;
    if (cause) this.cause = cause;
  }

  toJSON() {
    return {
      ok: false,
      problem: this.problem,
      hint: this.hint,
      detail: this.detail,
      code: this.code,
    };
  }
}

export function asToolError(err, fallback = {}) {
  if (err instanceof ToolError) return err;
  const msg = err?.message || String(err);
  // Parse nested daemon errors
  let detail = msg;
  try {
    const j = JSON.parse(msg);
    if (j?.error?.message) detail = j.error.message;
    else if (j?.message) detail = j.message;
  } catch {
    /* keep */
  }
  return new ToolError(fallback.problem || summarizeProblem(detail), {
    hint: fallback.hint,
    detail,
    code: fallback.code || err?.code,
    cause: err,
  });
}

function summarizeProblem(msg) {
  const s = String(msg);
  if (/timed out|timeout/i.test(s)) return "Operation timed out";
  if (/extension not connected|NOT connected/i.test(s)) return "Browser extension not connected";
  if (/element not found/i.test(s)) return "Element not found";
  if (/no tab matching/i.test(s)) return "No matching tab in this session";
  if (/url is required/i.test(s)) return "find_tab requires a url (or active tab resolve failed)";
  if (/ECONNREFUSED|not reachable/i.test(s)) return "WebBridge daemon not reachable";
  if (/503|502|500/.test(s)) return "Target page returned an HTTP error";
  return s.split("\n")[0].slice(0, 160);
}

export function formatToolError(err, { tool } = {}) {
  const te = asToolError(err);
  const body = {
    ok: false,
    tool: tool || undefined,
    problem: te.problem,
    hint: te.hint || undefined,
    detail: te.detail || te.message,
    code: te.code || undefined,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    isError: true,
  };
}
