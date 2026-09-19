import type { McpServer, McpStatus, ProviderReport } from "../shared/mcp";
import { displayTarget, displayText, resolveBin, run, runDetached } from "./exec";

const BIN = "codex";

/**
 * `codex mcp list --json` reports configuration, not reachability: it never
 * opens a connection. Rows are therefore marked `verified: false` and the UI
 * says "Configured" rather than claiming the server is live.
 *
 * auth_status values observed in codex 0.147: not_logged_in, o_auth,
 * bearer_token, unsupported, unknown.
 */
interface Entry {
  name: string;
  enabled: boolean;
  disabledReason: string | null;
  authStatus: string;
  transportType: string;
  target: string;
}

/**
 * An unreadable list is reported as a provider error rather than an empty one.
 * `[]` is a real answer; a changed JSON shape is not.
 */
export type CodexList = { kind: "servers"; servers: McpServer[] } | { kind: "unreadable" };

function isMissing(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * Reads only the non-sensitive fields. `env`, `http_headers`,
 * `env_http_headers`, and `bearer_token_env_var` are never touched, so a
 * credential in the Codex config cannot reach the client through this plugin.
 * Returns null when a field this plugin renders has an unexpected type.
 */
function readEntry(raw: unknown): Entry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as Record<string, unknown>;

  if (typeof item.name !== "string" || !item.name) return null;
  if (!isMissing(item.enabled) && typeof item.enabled !== "boolean") return null;
  if (!isMissing(item.auth_status) && typeof item.auth_status !== "string") return null;
  if (!isMissing(item.disabled_reason) && typeof item.disabled_reason !== "string") return null;
  if (!isMissing(item.transport) && typeof item.transport !== "object") return null;

  const transport = (item.transport ?? {}) as Record<string, unknown>;
  const url = typeof transport.url === "string" ? transport.url : null;
  const command = typeof transport.command === "string" ? transport.command : null;

  return {
    name: item.name,
    enabled: item.enabled !== false,
    disabledReason: typeof item.disabled_reason === "string" ? item.disabled_reason : null,
    authStatus: typeof item.auth_status === "string" ? item.auth_status : "",
    transportType: typeof transport.type === "string" ? transport.type : "unknown",
    target: url ?? command ?? "-",
  };
}

function describeAuth(auth: string): { status: McpStatus; detail: string } {
  switch (auth) {
    case "not_logged_in":
      return { status: "needs_auth", detail: "OAuth login required" };
    case "o_auth":
      return { status: "connected", detail: "Signed in with OAuth" };
    case "bearer_token":
      return { status: "connected", detail: "Bearer token configured" };
    case "unsupported":
      return { status: "no_auth", detail: "No authentication needed" };
    default:
      return { status: "unknown", detail: auth ? `auth_status: ${auth}` : "Status unknown" };
  }
}

export function parseList(stdout: string): CodexList {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { kind: "unreadable" };
  }
  if (!Array.isArray(parsed)) return { kind: "unreadable" };

  const servers: McpServer[] = [];
  for (const raw of parsed) {
    const entry = readEntry(raw);
    // Dropping the entry would hide a configured server, so the whole report
    // becomes an error instead.
    if (!entry) return { kind: "unreadable" };

    const described = describeAuth(entry.authStatus);
    servers.push({
      provider: "codex",
      name: entry.name,
      target: displayTarget(entry.target),
      transport: entry.transportType,
      status: entry.enabled ? described.status : "disabled",
      detail: entry.enabled
        ? described.detail
        : displayText(entry.disabledReason ?? "Disabled in the Codex config"),
      verified: false,
      canLogin: entry.enabled && (entry.authStatus === "not_logged_in" || entry.authStatus === "o_auth"),
    });
  }
  return { kind: "servers", servers };
}

export async function listCodex(): Promise<ProviderReport> {
  const bin = resolveBin(BIN);
  if (!bin) {
    return {
      provider: "codex",
      available: false,
      error: "codex CLI not found on the daemon machine.",
      servers: [],
    };
  }

  const result = await run(bin, ["mcp", "list", "--json"], { timeoutMs: 45_000 });
  if (result.spawnError) {
    return {
      provider: "codex",
      available: false,
      error: displayText(result.spawnError),
      servers: [],
    };
  }
  if (result.timedOut) {
    return { provider: "codex", available: true, error: "codex mcp list timed out.", servers: [] };
  }
  if (result.truncated) {
    return {
      provider: "codex",
      available: true,
      error: "codex mcp list produced too much output to read.",
      servers: [],
    };
  }

  // A readable list is a readable list. Codex can warn on stderr and still exit
  // non-zero, and throwing the parsed servers away for that would hide them.
  const parsed = parseList(result.stdout);
  if (parsed.kind === "servers") {
    return { provider: "codex", available: true, error: null, servers: parsed.servers };
  }
  return {
    provider: "codex",
    available: true,
    error:
      displayText(result.stderr) ||
      `codex mcp list returned unreadable JSON (exit ${result.code}).`,
    servers: [],
  };
}

export async function loginCodex(
  name: string,
): Promise<{
  outcome: "browser_started" | "completed" | "failed";
  url: string | null;
  message: string;
}> {
  const bin = resolveBin(BIN);
  if (!bin) return { outcome: "failed", url: null, message: "codex CLI not found." };

  // codex has no --no-browser flag: it opens a browser and runs a loopback
  // callback server on the daemon machine. Wait briefly to surface fast
  // failures, then let the flow outlive this RPC.
  const result = await runDetached(bin, ["mcp", "login", name], 4_000);
  const output = displayText(result.output);

  if (result.exited) {
    if (result.code === 0 && /success/i.test(result.output)) {
      return { outcome: "completed", url: null, message: output || "Authentication completed." };
    }
    return {
      outcome: "failed",
      url: null,
      message: output || `codex mcp login failed (exit ${result.code}).`,
    };
  }

  return {
    outcome: "browser_started",
    url: null,
    message: "Finish the sign-in in the browser on the daemon machine, then refresh the list.",
  };
}
