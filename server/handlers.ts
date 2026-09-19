import type { RpcInput } from "@getpaseo/plugin";
import { type ProviderId, type ProviderReport, loginMcpRpc, reloadAgentRpc } from "../shared/mcp";
import { listClaude, loginClaude } from "./claude";
import { listCodex, loginCodex } from "./codex";
import { type RunResult, displayText, resolveBin, run } from "./exec";

/**
 * Adapters return their failures, so a thrown error here is a bug. It still
 * must not take the other provider's result down with it.
 */
export async function isolate(
  provider: ProviderId,
  load: () => Promise<ProviderReport>,
): Promise<ProviderReport> {
  try {
    return await load();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      provider,
      available: true,
      error: displayText(message) || `Reading ${provider} MCP servers failed unexpectedly.`,
      servers: [],
    };
  }
}

export async function listMcp(): Promise<{ reports: ProviderReport[] }> {
  const reports = await Promise.all([isolate("claude", listClaude), isolate("codex", listCodex)]);
  return { reports };
}

export async function loginMcp({ provider, name }: RpcInput<typeof loginMcpRpc>) {
  return provider === "claude" ? loginClaude(name) : loginCodex(name);
}

/**
 * `paseo agent reload --json` reports some failures with exit code 0 and a JSON
 * error body, so the exit code alone cannot decide the outcome.
 */
export function judgeReload(result: RunResult): { ok: boolean; message: string } {
  if (result.spawnError) return { ok: false, message: displayText(result.spawnError) };
  if (result.timedOut) return { ok: false, message: "Agent restart did not finish in time." };
  if (result.truncated) return { ok: false, message: "Agent restart produced unreadable output." };

  // The CLI writes its error body to stderr and its success body to stdout.
  const body = result.stdout.trim() || result.stderr.trim();
  try {
    const parsed: unknown = JSON.parse(body);
    // Keyed on the value, not on the key: a success body carrying `error: null`
    // would otherwise be read as a failure.
    const error = (parsed as { error?: { message?: unknown } } | null)?.error;
    if (error) {
      return {
        ok: false,
        message: displayText(typeof error.message === "string" ? error.message : "Agent restart failed."),
      };
    }
  } catch {
    // Non-JSON output falls through to the exit-code check below.
  }

  if (result.code !== 0) {
    return {
      ok: false,
      message:
        displayText(result.stderr || result.stdout) ||
        `Agent restart failed (exit ${result.code}).`,
    };
  }
  return { ok: true, message: "Session restarted. New MCP authentication is now applied." };
}

/**
 * The Paseo SDK has no session-restart method, so this shells out to the CLI's
 * `agent reload`, which maps to the daemon's refresh_agent request and reopens
 * the provider process against the same agent record.
 */
export async function reloadAgent({ agentId }: RpcInput<typeof reloadAgentRpc>) {
  const bin = resolveBin("paseo");
  if (!bin) return { ok: false, message: "paseo CLI not found on the daemon machine." };

  return judgeReload(await run(bin, ["agent", "reload", agentId, "--json"], { timeoutMs: 60_000 }));
}
