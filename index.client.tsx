import type { PluginClientContext } from "@getpaseo/plugin/client";
import { McpAgentPanel } from "./client/manager";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "mcp",
    title: "MCP",
    icon: "Plug",
    context: "agent",
    locations: ["workspace"],
    Component: McpAgentPanel,
  });

  // Agent context is the only one registered: it carries the agentId the panel
  // needs to restart the session, which is the point of the plugin.
  client.addCommandCenterItem({
    id: "mcp",
    title: "Manage MCP connections",
    icon: "Plug",
    keywords: ["mcp", "auth", "login", "connector", "oauth", "server"],
    context: "agent",
    onSelect({ openPanel }) {
      // No location override: Paseo places it as a main-panel tab.
      openPanel("mcp");
    },
  });

  return () => {};
}
