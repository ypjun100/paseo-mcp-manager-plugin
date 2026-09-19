import type { McpServer, McpStatus, ProviderReport } from "../shared/mcp";
import { displayTarget, displayText, firstUrl, resolveBin, run, stripAnsi } from "./exec";

const BIN = "claude";

/**
 * `claude mcp list` health-checks every approved server and prints one line per
 * server. There is no JSON mode, so this parses the human output:
 *
 *   claude.ai Notion: https://mcp.notion.com/mcp - OK Connected
 *   github: https://api.githubcopilot.com/mcp (HTTP) - X Failed to connect - detail
 *
 * The lazy target group stops at the first " - <marker> ", which keeps error
 * text containing hyphens on the right-hand side where it belongs.
 */
const LINE = /^(.+?):\s(.+?)\s-\s([✔✓✘✗⏸!⚠])\s(.+)$/u;
const HEALTH_HEADER = /^checking mcp server health/i;
const EMPTY_NOTICE = /^no mcp servers configured/i;

/**
 * An unreadable list is reported as a provider error rather than an empty one:
 * "no servers" and "the output format changed" must not look the same.
 */
export type ClaudeList =
  | { kind: "servers"; servers: McpServer[] }
  | { kind: "empty" }
  | { kind: "unreadable" };

function classify(text: string): McpStatus {
  const normalized = text.toLowerCase();
  if (normalized.startsWith("connected")) return "connected";
  if (normalized.includes("needs authentication")) return "needs_auth";
  if (normalized.includes("authentication required")) return "needs_auth";
  if (normalized.includes("failed to connect")) return "failed";
  if (normalized.includes("pending approval")) return "disabled";
  return "unknown";
}

function splitTarget(raw: string): { target: string; transport: string } {
  const tagged = raw.match(/^(.*)\s\((HTTP|SSE|STDIO)\)$/i);
  if (tagged) {
    return { target: tagged[1].trim(), transport: tagged[2].toLowerCase() };
  }
  if (/^https?:\/\//i.test(raw)) return { target: raw, transport: "http" };
  return { target: raw, transport: "stdio" };
}

export function parseList(stdout: string): ClaudeList {
  const servers: McpServer[] = [];
  let empty = false;

  for (const rawLine of stripAnsi(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || HEALTH_HEADER.test(line)) continue;
    if (EMPTY_NOTICE.test(line)) {
      empty = true;
      continue;
    }

    const match = line.match(LINE);
    if (!match) continue;

    const { target, transport } = splitTarget(match[2].trim());
    const status = classify(match[4]);

    servers.push({
      provider: "claude",
      name: match[1].trim(),
      target: displayTarget(target),
      transport,
      status,
      detail: displayText(match[4]),
      verified: true,
      // Only URL-backed servers have an OAuth flow; stdio servers cannot log in.
      canLogin: transport === "http" || transport === "sse",
    });
  }

  if (servers.length > 0) return { kind: "servers", servers };
  if (empty) return { kind: "empty" };
  return { kind: "unreadable" };
}

export async function listClaude(): Promise<ProviderReport> {
  const bin = resolveBin(BIN);
  if (!bin) {
    return {
      provider: "claude",
      available: false,
      error: "claude CLI not found on the daemon machine.",
      servers: [],
    };
  }

  // The health check contacts every server, so this is the slow call.
  const result = await run(bin, ["mcp", "list"], { timeoutMs: 120_000 });
  if (result.spawnError) {
    return {
      provider: "claude",
      available: false,
      error: displayText(result.spawnError),
      servers: [],
    };
  }
  if (result.timedOut) {
    return {
      provider: "claude",
      available: true,
      error: "claude mcp list timed out (slow health check).",
      servers: [],
    };
  }
  if (result.truncated) {
    return {
      provider: "claude",
      available: true,
      error: "claude mcp list produced too much output to read.",
      servers: [],
    };
  }

  const parsed = parseList(result.stdout);
  if (parsed.kind === "servers") {
    return { provider: "claude", available: true, error: null, servers: parsed.servers };
  }
  if (parsed.kind === "empty" && result.code === 0) {
    return { provider: "claude", available: true, error: null, servers: [] };
  }
  return {
    provider: "claude",
    available: true,
    error:
      displayText(result.stderr || result.stdout) ||
      `claude mcp list returned nothing readable (exit ${result.code}).`,
    servers: [],
  };
}

export async function loginClaude(
  name: string,
): Promise<{ outcome: "open_url" | "completed" | "failed"; url: string | null; message: string }> {
  const bin = resolveBin(BIN);
  if (!bin) {
    return { outcome: "failed", url: null, message: "claude CLI not found." };
  }

  // --no-browser prints the authorization URL instead of opening a browser on
  // the daemon machine, which is what lets the Paseo client open it instead.
  const result = await run(bin, ["mcp", "login", name, "--no-browser"], { timeoutMs: 45_000 });
  const combined = `${result.stdout}\n${result.stderr}`;
  const url = firstUrl(combined);

  if (url) {
    // claude.ai connectors finish entirely in the browser. Self-hosted OAuth
    // servers additionally want the redirect URL pasted back on stdin, which
    // this non-interactive call cannot supply.
    const needsPaste = /paste|redirect url/i.test(combined);
    return {
      outcome: "open_url",
      url,
      message: needsPaste
        ? `This server also needs the redirect URL pasted back. Approve in the browser, then finish with "claude mcp login ${name}" in a terminal.`
        : "Approve in the browser, then refresh the list.",
    };
  }

  if (result.code === 0 && /success|already/i.test(combined)) {
    return {
      outcome: "completed",
      url: null,
      message: displayText(combined) || "Already authenticated.",
    };
  }
  return {
    outcome: "failed",
    url: null,
    message: displayText(combined) || `claude mcp login failed (exit ${result.code}).`,
  };
}
