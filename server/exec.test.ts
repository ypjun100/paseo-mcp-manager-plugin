import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_OUTPUT_CHARS,
  displayTarget,
  displayText,
  firstUrl,
  redactTokens,
  redactUrls,
  run,
} from "./exec";

const ESC = String.fromCharCode(27);
const BELL = String.fromCharCode(7);

test("displayText removes ANSI escapes and control characters", () => {
  const input = `${ESC}[31mFailed${BELL} to  connect${ESC}[0m`;
  assert.equal(displayText(input), "Failed to connect");
});

test("displayText clamps long provider output", () => {
  const clamped = displayText("x".repeat(500));
  assert.equal(clamped.length, 240);
  assert.ok(clamped.endsWith("..."));
});

test("redactUrls drops userinfo, query, and fragment", () => {
  assert.equal(
    redactUrls("open https://user:secret@example.com/mcp?token=abc#frag now"),
    "open https://example.com/mcp?... now",
  );
  assert.equal(redactUrls("plain https://example.com/mcp"), "plain https://example.com/mcp");
});

test("redactTokens replaces credential-shaped values", () => {
  assert.equal(redactTokens("token=abc123def456"), "token=[redacted]");
  assert.equal(redactTokens("sent Bearer abcdef1234567890 header"), "sent Bearer [redacted] header");
  assert.equal(
    redactTokens("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"),
    "jwt [redacted]",
  );
  assert.equal(redactTokens("key sk-ABCDEFGHIJKLMNOP"), "key [redacted]");
});

test("displayText keeps a provider error readable while removing its secret", () => {
  const message = "Failed to connect to https://svc.example.com/mcp?api_key=SUPERSECRET (HTTP 401)";
  const shown = displayText(message);
  assert.ok(!shown.includes("SUPERSECRET"));
  assert.ok(shown.includes("Failed to connect"));
  assert.ok(shown.includes("HTTP 401"));
});

test("displayTarget keeps a URL but reduces a stdio command to its file name", () => {
  assert.equal(displayTarget("https://mcp.example.com/mcp"), "https://mcp.example.com/mcp");
  assert.equal(displayTarget("/Users/someone/.local/share/tools/bin/server"), "server");
  assert.equal(displayTarget(""), "-");
});

test("firstUrl keeps the query string the grant needs", () => {
  assert.equal(
    firstUrl("Open https://auth.example.com/authorize?code=xyz to continue."),
    "https://auth.example.com/authorize?code=xyz",
  );
  assert.equal(firstUrl("no url here"), null);
});

test("run stops a process that floods its output", async () => {
  const script =
    'const c = "y".repeat(1024 * 1024); process.stdout.write(c); process.stdout.write(c);';
  const result = await run(process.execPath, ["-e", script], { timeoutMs: 15_000 });
  assert.equal(result.truncated, true);
  assert.equal(result.timedOut, false);
  assert.ok(result.stdout.length > MAX_OUTPUT_CHARS);
});

test("run reports a timeout instead of hanging", async () => {
  const result = await run(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    timeoutMs: 300,
  });
  assert.equal(result.timedOut, true);
});

test("run reports a spawn error for a missing executable", async () => {
  const result = await run("/nonexistent/mcp-manager-test-bin", [], { timeoutMs: 5_000 });
  assert.ok(result.spawnError);
  assert.equal(result.code, null);
});
