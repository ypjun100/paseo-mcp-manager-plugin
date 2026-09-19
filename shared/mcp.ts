import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Agent providers this plugin knows how to inspect. */
export const providerIdSchema = z.enum(["claude", "codex"]);
export type ProviderId = z.infer<typeof providerIdSchema>;

export const PROVIDER_IDS: ProviderId[] = ["claude", "codex"];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/**
 * `connected` and `failed` only mean something when the provider actually
 * opened a connection. Codex reports configuration, not reachability, so its
 * rows carry `verified: false` and the UI must not claim the server is live.
 */
export const mcpStatusSchema = z.enum([
  "connected",
  "needs_auth",
  "failed",
  "no_auth",
  "disabled",
  "unknown",
]);
export type McpStatus = z.infer<typeof mcpStatusSchema>;

/**
 * MCP names and agent IDs reach a CLI as positional arguments. A leading
 * hyphen would be read as an option and control characters would corrupt the
 * daemon's own output, so both are rejected here rather than in each adapter.
 */
const cliArgument = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), "must not contain control characters")
  .refine((value) => !value.startsWith("-"), "must not start with a hyphen");

export const mcpServerSchema = z.object({
  provider: providerIdSchema,
  name: z.string(),
  /** Display form only: URL without credentials for remote servers, executable name for stdio. */
  target: z.string(),
  transport: z.string(),
  status: mcpStatusSchema,
  /** Short human-readable note: the provider's own status text or error detail. */
  detail: z.string(),
  /** True when the provider health-checked the server rather than reading config. */
  verified: z.boolean(),
  canLogin: z.boolean(),
});
export type McpServer = z.infer<typeof mcpServerSchema>;

export const providerReportSchema = z.object({
  provider: providerIdSchema,
  /** False when the provider CLI is not installed on the daemon machine. */
  available: z.boolean(),
  error: z.string().nullable(),
  servers: z.array(mcpServerSchema),
});
export type ProviderReport = z.infer<typeof providerReportSchema>;

export const listMcpRpc = defineRpc({
  name: "mcp.list",
  input: z.object({}),
  output: z.object({ reports: z.array(providerReportSchema) }),
});

export const loginOutcomeSchema = z.enum([
  /** The daemon returned an authorization URL for the client to open. */
  "open_url",
  /** A browser flow was started on the daemon machine and is still running. */
  "browser_started",
  /** The provider reported the login as finished. */
  "completed",
  "failed",
]);
export type LoginOutcome = z.infer<typeof loginOutcomeSchema>;

export const loginMcpRpc = defineRpc({
  name: "mcp.login",
  input: z.object({ provider: providerIdSchema, name: cliArgument }),
  output: z.object({
    outcome: loginOutcomeSchema,
    /** Authorization URL for the client to open. Returned once; never logged. */
    url: z.string().nullable(),
    message: z.string(),
  }),
});

export const reloadAgentRpc = defineRpc({
  name: "mcp.reload-agent",
  input: z.object({ agentId: cliArgument }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});
