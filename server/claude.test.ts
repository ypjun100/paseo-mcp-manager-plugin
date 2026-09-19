import assert from "node:assert/strict";
import { test } from "node:test";
import { parseList } from "./claude";

const LIST = [
  "Checking MCP server health",
  "",
  "claude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected",
  "claude.ai Tavily: https://mcp.tavily.com/mcp - ! Needs authentication",
  "docs: https://docs.example.com/sse (SSE) - ✔ Connected",
  "local-tools: /Users/someone/.local/share/tools/bin/local-tools - ✔ Connected",
  "github: https://api.githubcopilot.com/mcp (HTTP) - ✘ Failed to connect - token rejected",
].join("\n");

function servers(stdout: string) {
  const parsed = parseList(stdout);
  assert.equal(parsed.kind, "servers");
  return parsed.kind === "servers" ? parsed.servers : [];
}

test("parses status, transport, and login capability per row", () => {
  const rows = servers(LIST);
  assert.deepEqual(
    rows.map((row) => [row.name, row.status, row.transport, row.canLogin]),
    [
      ["claude.ai Notion", "connected", "http", true],
      ["claude.ai Tavily", "needs_auth", "http", true],
      ["docs", "connected", "sse", true],
      ["local-tools", "connected", "stdio", false],
      ["github", "failed", "http", true],
    ],
  );
  assert.ok(rows.every((row) => row.verified));
});

test("keeps an error detail that itself contains a hyphen", () => {
  const rows = servers(LIST);
  const github = rows.find((row) => row.name === "github");
  assert.equal(github?.detail, "Failed to connect - token rejected");
  assert.equal(github?.target, "https://api.githubcopilot.com/mcp");
});

test("reduces a stdio target to its file name", () => {
  const rows = servers(LIST);
  assert.equal(rows.find((row) => row.name === "local-tools")?.target, "local-tools");
});

test("reports the known empty notice as an empty list", () => {
  assert.deepEqual(parseList("No MCP servers configured. Use `claude mcp add` to add a server."), {
    kind: "empty",
  });
});

test("reports output it cannot read as unreadable rather than empty", () => {
  assert.deepEqual(parseList("Usage: claude mcp list [options]"), { kind: "unreadable" });
  assert.deepEqual(parseList(""), { kind: "unreadable" });
});
