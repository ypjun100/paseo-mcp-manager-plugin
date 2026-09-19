import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderReport } from "../shared/mcp";
import type { RunResult } from "./exec";
import { isolate, judgeReload } from "./handlers";

function result(partial: Partial<RunResult>): RunResult {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    truncated: false,
    spawnError: null,
    ...partial,
  };
}

const codexReport: ProviderReport = {
  provider: "codex",
  available: true,
  error: null,
  servers: [
    {
      provider: "codex",
      name: "notion",
      target: "https://mcp.notion.com/mcp",
      transport: "streamable_http",
      status: "connected",
      detail: "Signed in with OAuth",
      verified: false,
      canLogin: true,
    },
  ],
};

test("a provider that throws does not remove the other provider's servers", async () => {
  const reports = await Promise.all([
    isolate("claude", () => Promise.reject(new Error("claude adapter crashed"))),
    isolate("codex", () => Promise.resolve(codexReport)),
  ]);

  assert.equal(reports[0].provider, "claude");
  assert.equal(reports[0].error, "claude adapter crashed");
  assert.deepEqual(reports[0].servers, []);
  assert.deepEqual(reports[1], codexReport);
});

test("agent reload fails on a JSON error body even with exit code 0", () => {
  const judged = judgeReload(
    result({ code: 0, stderr: '{"error":{"message":"AGENT_NOT_FOUND"}}' }),
  );
  assert.deepEqual(judged, { ok: false, message: "AGENT_NOT_FOUND" });
});

test("agent reload fails on a non-zero exit", () => {
  const judged = judgeReload(result({ code: 1, stderr: "daemon unreachable" }));
  assert.equal(judged.ok, false);
  assert.equal(judged.message, "daemon unreachable");
});

test("agent reload fails on a timeout, a spawn error, and flooded output", () => {
  assert.equal(judgeReload(result({ code: null, timedOut: true })).ok, false);
  assert.equal(judgeReload(result({ code: null, spawnError: "ENOENT" })).ok, false);
  assert.equal(judgeReload(result({ code: 0, truncated: true })).ok, false);
});

test("agent reload succeeds on a clean JSON body", () => {
  const judged = judgeReload(result({ code: 0, stdout: '{"agent":{"id":"a1"}}' }));
  assert.equal(judged.ok, true);
  assert.match(judged.message, /Session restarted/);
});

test("agent reload reads a null error field as success, not failure", () => {
  const judged = judgeReload(result({ code: 0, stdout: '{"agent":{"id":"a1"},"error":null}' }));
  assert.equal(judged.ok, true);
});
