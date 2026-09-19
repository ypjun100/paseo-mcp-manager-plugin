import type { PluginAgentPanelProps, PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  PROVIDER_LABELS,
  type McpServer,
  type McpStatus,
  type ProviderReport,
  listMcpRpc,
  loginMcpRpc,
  reloadAgentRpc,
} from "../shared/mcp";
import { openExternal } from "./web";

type Theme = PluginHostProps["theme"];
type Layout = PluginHostProps["layout"];
type Tone = "success" | "warning" | "danger" | "muted";

const LIST_KEY = ["paseo-mcp-manager", "list"] as const;

const STATUS_META: Record<McpStatus, { icon: string; label: string; tone: Tone }> = {
  connected: { icon: "CircleCheck", label: "Connected", tone: "success" },
  needs_auth: { icon: "CircleAlert", label: "Needs auth", tone: "warning" },
  failed: { icon: "CircleX", label: "Failed", tone: "danger" },
  no_auth: { icon: "Circle", label: "No auth needed", tone: "muted" },
  disabled: { icon: "CircleSlash", label: "Disabled", tone: "muted" },
  unknown: { icon: "CircleHelp", label: "Unknown", tone: "muted" },
};

/**
 * Rows that need the user to act sort first: Failed, then Needs auth, then
 * Connected. Everything the user cannot act on falls to the bottom.
 */
const STATUS_RANK: Record<McpStatus, number> = {
  failed: 0,
  needs_auth: 1,
  connected: 2,
  no_auth: 3,
  unknown: 4,
  disabled: 5,
};

/**
 * Ties break on name with a plain codepoint comparison rather than
 * `localeCompare`, so ordering never depends on the host locale.
 */
function sortServers(servers: readonly McpServer[]): McpServer[] {
  return [...servers].sort((a, b) => {
    const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (byStatus !== 0) return byStatus;
    if (a.name === b.name) return 0;
    return a.name < b.name ? -1 : 1;
  });
}

function toneColor(theme: Theme, tone: Tone): string {
  if (tone === "success") return theme.colors.statusSuccess;
  if (tone === "warning") return theme.colors.statusWarning;
  if (tone === "danger") return theme.colors.statusDanger;
  return theme.colors.foregroundMuted;
}

/**
 * Codex reports configuration without opening a connection, so an authenticated
 * Codex row must not claim the server is reachable.
 */
function statusLabel(server: McpServer): string {
  if (!server.verified && server.status === "connected") return "Configured";
  return STATUS_META[server.status].label;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

/**
 * Only providers that answered are summarised. A provider the daemon could not
 * read is named instead of being silently counted as healthy.
 */
function summarize(reports: readonly ProviderReport[]): string {
  const unreadable = reports.filter((report) => !report.available || report.error);
  const servers = reports
    .filter((report) => report.available && !report.error)
    .flatMap((report) => report.servers);

  const needsAuth = servers.filter((server) => server.status === "needs_auth").length;
  const failed = servers.filter((server) => server.status === "failed").length;

  const notes: string[] = [];
  if (needsAuth > 0) notes.push(`${needsAuth} ${plural(needsAuth, "server")} waiting for authentication`);
  if (failed > 0) notes.push(`${failed} ${plural(failed, "server")} failing to connect`);
  if (unreadable.length > 0) {
    const names = unreadable.map((report) => PROVIDER_LABELS[report.provider]).join(" and ");
    notes.push(`${names} could not be read`);
  }

  if (notes.length > 0) return `${notes.join("; ")}.`;
  if (servers.length === 0) return "No MCP servers configured.";
  return "All servers are authenticated.";
}

/**
 * The Explorer sidebar is narrow even on a wide desktop window, so the host's
 * `layout.compact` flag alone is not enough. Callers pass a measured value.
 */
function useStyles(theme: Theme, narrow: boolean) {
  return useMemo(
    () =>
      StyleSheet.create({
        screen: { flex: 1, backgroundColor: theme.colors.surface0 },
        content: { padding: narrow ? 12 : 20, gap: narrow ? 10 : 14 },
        headerRow: { flexDirection: "row", alignItems: "center", gap: 10 },
        headerText: { flex: 1, gap: 2 },
        title: {
          color: theme.colors.foreground,
          fontSize: narrow ? 16 : 19,
          fontWeight: "600",
        },
        summary: { color: theme.colors.foregroundMuted, fontSize: 12 },
        section: {
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: 10,
          overflow: "hidden",
        },
        sectionHeader: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 9,
          backgroundColor: theme.colors.surface2,
        },
        sectionTitle: { flex: 1, color: theme.colors.foreground, fontSize: 13, fontWeight: "600" },
        sectionNote: { color: theme.colors.foregroundMuted, fontSize: 11 },
        row: {
          flexDirection: narrow ? "column" : "row",
          alignItems: narrow ? "stretch" : "center",
          gap: narrow ? 6 : 10,
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderTopColor: theme.colors.border,
          borderTopWidth: StyleSheet.hairlineWidth,
        },
        rowMain: { flex: 1, flexDirection: "row", alignItems: "flex-start", gap: 8 },
        rowText: { flex: 1, gap: 2 },
        rowName: { color: theme.colors.foreground, fontSize: 13, fontWeight: "500" },
        rowTarget: { color: theme.colors.foregroundMuted, fontSize: 11 },
        rowDetail: { color: theme.colors.foregroundMuted, fontSize: 11 },
        rowSide: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: narrow ? "flex-start" : "flex-end",
          gap: 8,
          minWidth: narrow ? undefined : 150,
        },
        statusText: { fontSize: 12 },
        button: {
          paddingHorizontal: 12,
          paddingVertical: 7,
          borderRadius: 8,
          backgroundColor: theme.colors.accent,
        },
        buttonText: { color: theme.colors.accentForeground, fontSize: 12, fontWeight: "600" },
        ghostButton: {
          paddingHorizontal: 12,
          paddingVertical: 7,
          borderRadius: 8,
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.border,
          borderWidth: StyleSheet.hairlineWidth,
        },
        ghostButtonText: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" },
        disabledButton: { opacity: 0.5 },
        message: {
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          paddingHorizontal: 12,
          paddingVertical: 10,
        },
        errorMessage: {
          color: theme.colors.statusDanger,
          fontSize: 12,
          paddingHorizontal: 12,
          paddingVertical: 10,
        },
        footer: { gap: 8, paddingTop: 4 },
        footerNote: { color: theme.colors.foregroundMuted, fontSize: 11 },
        confirmBox: {
          gap: 10,
          padding: 12,
          borderRadius: 10,
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.statusWarning,
          borderWidth: StyleSheet.hairlineWidth,
        },
        confirmText: { color: theme.colors.foreground, fontSize: 12 },
        confirmActions: { flexDirection: narrow ? "column" : "row", gap: 8 },
      }),
    [theme, narrow],
  );
}

interface ManagerProps {
  theme: Theme;
  layout: Layout;
  agentId: string;
}

function McpManager({ theme, layout, agentId }: ManagerProps) {
  const [panelWidth, setPanelWidth] = useState(0);
  const [confirmingReload, setConfirmingReload] = useState(false);
  // Below this the status column has no room beside the name, so rows stack.
  const narrow = layout.compact || (panelWidth > 0 && panelWidth < 460);
  const styles = useStyles(theme, narrow);
  const toast = useToast();
  const queryClient = useQueryClient();

  const listMcp = useRpc(listMcpRpc);
  const loginMcp = useRpc(loginMcpRpc);
  const reloadAgent = useRpc(reloadAgentRpc);

  const listing = useQuery({
    queryKey: LIST_KEY,
    // Claude health-checks every server on each call, so this stays manual-refresh.
    queryFn: () => listMcp({}),
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });

  const login = useMutation({
    mutationFn: (server: McpServer) => loginMcp({ provider: server.provider, name: server.name }),
    async onSuccess(result) {
      if (result.outcome === "open_url" && result.url) {
        await openExternal(result.url);
        toast.show(result.message, { variant: "info", durationMs: 8_000 });
        return;
      }
      if (result.outcome === "browser_started") {
        toast.show(result.message, { variant: "info", durationMs: 8_000 });
        return;
      }
      if (result.outcome === "completed") {
        toast.show(result.message, { variant: "success" });
        await queryClient.invalidateQueries({ queryKey: LIST_KEY });
        return;
      }
      toast.error(result.message);
    },
    onError(error: unknown) {
      toast.error(error instanceof Error ? error.message : "Authentication request failed.");
    },
  });

  const reload = useMutation({
    mutationFn: (id: string) => reloadAgent({ agentId: id }),
    onSuccess(result) {
      if (result.ok) toast.show(result.message, { variant: "success" });
      else toast.error(result.message);
    },
    onError(error: unknown) {
      toast.error(error instanceof Error ? error.message : "Session restart failed.");
    },
  });

  const reports = useMemo(
    () =>
      (listing.data?.reports ?? []).map((report) => ({
        ...report,
        servers: sortServers(report.servers),
      })),
    [listing.data],
  );

  const summary = listing.isPending
    ? "Checking status..."
    : listing.isError
      ? "Could not load status."
      : summarize(reports);

  return (
    <View style={styles.screen} onLayout={(event) => setPanelWidth(event.nativeEvent.layout.width)}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <View style={styles.headerText}>
            <Text style={styles.title}>MCP connections</Text>
            <Text style={styles.summary}>{summary}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh MCP status"
            accessibilityState={{ disabled: listing.isFetching, busy: listing.isFetching }}
            disabled={listing.isFetching}
            onPress={() => void listing.refetch()}
            style={[styles.ghostButton, listing.isFetching && styles.disabledButton]}
          >
            <Text style={styles.ghostButtonText}>
              {listing.isFetching ? "Checking..." : "Refresh"}
            </Text>
          </Pressable>
        </View>

        {listing.isError ? (
          <Text style={styles.errorMessage}>
            {listing.error instanceof Error ? listing.error.message : "Unknown error"}
          </Text>
        ) : null}

        {reports.map((report) => (
          <View key={report.provider} style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{PROVIDER_LABELS[report.provider]}</Text>
              <Text style={styles.sectionNote}>
                {report.provider === "codex" ? "config only" : "live health check"}
              </Text>
            </View>

            {!report.available ? (
              <Text style={styles.message}>{report.error ?? "This provider is not installed."}</Text>
            ) : report.error ? (
              <Text style={styles.errorMessage}>{report.error}</Text>
            ) : report.servers.length === 0 ? (
              <Text style={styles.message}>No MCP servers configured.</Text>
            ) : (
              report.servers.map((server) => {
                const meta = STATUS_META[server.status];
                const color = toneColor(theme, meta.tone);
                const busy =
                  login.isPending &&
                  login.variables?.name === server.name &&
                  login.variables?.provider === server.provider;
                const action = server.status === "needs_auth" ? "Authenticate" : "Re-authenticate";
                return (
                  <View key={`${server.provider}:${server.name}`} style={styles.row}>
                    <View style={styles.rowMain}>
                      <Icon name={meta.icon} size={15} color={color} />
                      <View style={styles.rowText}>
                        <Text style={styles.rowName}>{server.name}</Text>
                        <Text style={styles.rowTarget} numberOfLines={1}>
                          {server.target} ({server.transport})
                        </Text>
                        {server.detail ? (
                          <Text style={styles.rowDetail} numberOfLines={3}>
                            {server.detail}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                    <View style={styles.rowSide}>
                      <Text
                        style={[styles.statusText, { color }]}
                        accessibilityLabel={`${server.name} status: ${statusLabel(server)}`}
                      >
                        {statusLabel(server)}
                      </Text>
                      {server.canLogin ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`${action} ${server.name}`}
                          accessibilityState={{ disabled: login.isPending, busy }}
                          disabled={login.isPending}
                          onPress={() => login.mutate(server)}
                          style={[styles.button, login.isPending && styles.disabledButton]}
                        >
                          <Text style={styles.buttonText}>{busy ? "Working..." : action}</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  </View>
                );
              })
            )}
          </View>
        ))}

        <View style={styles.footer}>
          {confirmingReload ? (
            <View style={styles.confirmBox}>
              <Text style={styles.confirmText}>
                Restarting reopens the provider process for this agent. A reply that is still being
                written is interrupted. Continue?
              </Text>
              <View style={styles.confirmActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Cancel the session restart"
                  disabled={reload.isPending}
                  onPress={() => setConfirmingReload(false)}
                  style={[styles.ghostButton, reload.isPending && styles.disabledButton]}
                >
                  <Text style={styles.ghostButtonText}>Cancel</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Confirm the session restart"
                  accessibilityState={{ disabled: reload.isPending, busy: reload.isPending }}
                  disabled={reload.isPending}
                  onPress={() => {
                    setConfirmingReload(false);
                    reload.mutate(agentId);
                  }}
                  style={[styles.button, reload.isPending && styles.disabledButton]}
                >
                  <Text style={styles.buttonText}>
                    {reload.isPending ? "Restarting..." : "Restart now"}
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Restart this session to apply MCP changes"
              accessibilityState={{ disabled: reload.isPending, busy: reload.isPending }}
              disabled={reload.isPending}
              onPress={() => setConfirmingReload(true)}
              style={[styles.ghostButton, reload.isPending && styles.disabledButton]}
            >
              <Text style={styles.ghostButtonText}>
                {reload.isPending ? "Restarting..." : "Restart session to apply"}
              </Text>
            </Pressable>
          )}
          <Text style={styles.footerNote}>
            New authentication only applies after the provider process reopens.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

export function McpAgentPanel({ theme, layout, agentId }: PluginAgentPanelProps) {
  return <McpManager theme={theme} layout={layout} agentId={agentId} />;
}
