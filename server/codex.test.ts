import assert from "node:assert/strict";
import { test } from "node:test";
import { parseList } from "./codex";

const LIST = JSON.stringify([
  {
    name: "notion",
    enabled: true,
    disabled_reason: null,
    auth_status: "o_auth",
    transport: {
      type: "streamable_http",
      url: "https://mcp.notion.com/mcp",
      bearer_token_env_var: "NOTION_TOKEN",
      http_headers: { Authorization: "Bearer SUPERSECRET" },
    },
  },
  {
    name: "docs",
    enabled: true,
    auth_status: "unsupported",
    transport: { type: "streamable_http", url: "https://developers.example.com/mcp" },
  },
  {
    name: "needs-login",
    enabled: true,
    auth_status: "not_logged_in",
    transport: { type: "streamable_http", url: "https://mcp.example.com/mcp" },
  },
  {
    name: "tokened",
    enabled: true,
    auth_status: "bearer_token",
    transport: { type: "streamable_http", url: "https://api.example.com/mcp" },
  },
  {
    name: "future",
    enabled: true,
    auth_status: "brand_new_mode",
    transport: { type: "stdio", command: "/opt/tools/bin/future-server" },
  },
  {
    name: "computer-use",
    enabled: false,
    disabled_reason: "Turned off in config.toml",
    auth_status: "unsupported",
    transport: {
      type: "stdio",
      command: "/Users/someone/Library/App/bin/client",
      env: { SECRET_ENV_VALUE: "SUPERSECRET" },
    },
  },
]);

function servers(stdout: string) {
  const parsed = parseList(stdout);
  assert.equal(parsed.kind, "servers");
  return parsed.kind === "servers" ? parsed.servers : [];
}

test("maps every auth status to a config-only row", () => {
  const rows = servers(LIST);
  assert.deepEqual(
    rows.map((row) => [row.name, row.status, row.canLogin]),
    [
      ["notion", "connected", true],
      ["docs", "no_auth", false],
      ["needs-login", "needs_auth", true],
      ["tokened", "connected", false],
      ["future", "unknown", false],
      ["computer-use", "disabled", false],
    ],
  );
  // Codex never opens a connection, so no row may claim it was verified.
  assert.ok(rows.every((row) => !row.verified));
});

test("reports a disabled entry with its reason", () => {
  const row = servers(LIST).find((entry) => entry.name === "computer-use");
  assert.equal(row?.status, "disabled");
  assert.equal(row?.detail, "Turned off in config.toml");
});

test("never copies env, headers, or bearer token fields into the result", () => {
  const rendered = JSON.stringify(servers(LIST));
  assert.ok(!rendered.includes("SUPERSECRET"));
  assert.ok(!rendered.includes("NOTION_TOKEN"));
  assert.ok(!rendered.includes("SECRET_ENV_VALUE"));
});

test("reduces a stdio command to its file name and keeps remote URLs", () => {
  const rows = servers(LIST);
  assert.equal(rows.find((row) => row.name === "future")?.target, "future-server");
  assert.equal(rows.find((row) => row.name === "notion")?.target, "https://mcp.notion.com/mcp");
});

test("treats no configured servers as an empty list", () => {
  assert.deepEqual(parseList("[]"), { kind: "servers", servers: [] });
});

test("treats a changed JSON shape as unreadable rather than empty", () => {
  assert.deepEqual(parseList("not json"), { kind: "unreadable" });
  assert.deepEqual(parseList('{"servers": []}'), { kind: "unreadable" });
  assert.deepEqual(parseList('[{"enabled": true}]'), { kind: "unreadable" });
  assert.deepEqual(parseList('[{"name": "a", "enabled": "yes"}]'), { kind: "unreadable" });
});
