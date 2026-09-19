import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listMcp, loginMcp, reloadAgent } from "./server/handlers";
import { listMcpRpc, loginMcpRpc, reloadAgentRpc } from "./shared/mcp";

export default function contribute(server: PluginServerContext) {
  server.handle(listMcpRpc, listMcp);
  server.handle(loginMcpRpc, loginMcp);
  server.handle(reloadAgentRpc, reloadAgent);
  return () => {};
}
