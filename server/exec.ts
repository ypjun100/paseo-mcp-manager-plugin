import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";

/**
 * The daemon subprocess does not inherit a login shell, so provider CLIs
 * installed under a user-local prefix are invisible to a bare PATH lookup.
 */
const EXTRA_BIN_DIRS = [
  join(homedir(), ".local", "bin"),
  join(homedir(), ".bun", "bin"),
  join(homedir(), ".volta", "bin"),
  join(homedir(), ".cargo", "bin"),
  join(homedir(), ".npm-global", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

export function searchPath(): string[] {
  const fromEnv = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return [...new Set([...fromEnv, ...EXTRA_BIN_DIRS])];
}

const resolved = new Map<string, string>();

/** Absolute path to a provider CLI, or null when it is not installed. */
export function resolveBin(name: string): string | null {
  const hit = resolved.get(name);
  if (hit) return hit;
  for (const dir of searchPath()) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      resolved.set(name, candidate);
      return candidate;
    }
  }
  return null;
}

/**
 * Combined stdout and stderr a provider may produce before the run is cut
 * short. A CLI stuck in a progress loop would otherwise grow the daemon's heap
 * for as long as the timeout allows.
 */
export const MAX_OUTPUT_CHARS = 256 * 1024;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when the output cap stopped the process before it finished. */
  truncated: boolean;
  spawnError: string | null;
}

/**
 * Runs a provider CLI with stdin closed. Never inherits a TTY, so CLIs take
 * their non-interactive branch instead of blocking on a prompt.
 */
export function run(
  bin: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<RunResult> {
  const { timeoutMs = 90_000 } = options;
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;

    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: searchPath().join(delimiter) },
    });

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const enforceCap = () => {
      if (truncated || stdout.length + stderr.length <= MAX_OUTPUT_CHARS) return;
      truncated = true;
      child.kill("SIGKILL");
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      enforceCap();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      enforceCap();
    });
    child.on("error", (error: Error) => {
      finish({ code: null, stdout, stderr, timedOut, truncated, spawnError: error.message });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut, truncated, spawnError: null });
    });
  });
}

/**
 * Starts a CLI that owns its own browser flow. Waits `graceMs` to catch a fast
 * failure, then detaches so the flow outlives this RPC. Once detached the pipes
 * are drained and discarded: keeping them attached would either grow the heap
 * or stall the child on a full pipe.
 */
export function runDetached(
  bin: string,
  args: string[],
  graceMs: number,
): Promise<{ exited: boolean; code: number | null; output: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let output = "";

    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, PATH: searchPath().join(delimiter) },
    });

    const collect = (chunk: Buffer) => {
      if (output.length >= MAX_OUTPUT_CHARS) return;
      output = (output + chunk.toString("utf8")).slice(0, MAX_OUTPUT_CHARS);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const settle = (exited: boolean, code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!exited) {
        for (const stream of [child.stdout, child.stderr]) {
          stream?.removeListener("data", collect);
          stream?.resume();
        }
        child.unref();
      }
      resolve({ exited, code, output });
    };

    const timer = setTimeout(() => settle(false, null), graceMs);
    child.on("error", (error: Error) => {
      output += error.message;
      settle(true, null);
    });
    child.on("close", (code) => settle(true, code));
  });
}

// Built from escapes so this source file stays free of control characters.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const CONTROL = /[\u0000-\u001F\u007F]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi;

/**
 * Rewrites every URL to scheme://host/path. Userinfo, query, and fragment are
 * where a provider's own message would carry a credential.
 */
export function redactUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    const parts = match.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(.*)$/i);
    if (!parts) return match;
    const authority = parts[2];
    const host = authority.slice(authority.lastIndexOf("@") + 1);
    return `${parts[1]}://${host}${parts[3]}${parts[4] ? "?..." : ""}`;
  });
}

const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted]"],
  [
    /\b(token|secret|password|passwd|api[_-]?key|access[_-]?key|authorization)\s*[=:]\s*("?)[^\s"',;]+\2/gi,
    "$1=[redacted]",
  ],
];

/** Removes credential-shaped values a provider may have printed. */
export function redactTokens(text: string): string {
  return TOKEN_PATTERNS.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    text,
  );
}

/**
 * The only way provider text reaches the client. Escape sequences and control
 * characters go, credentials go, and the rest is clamped to a panel row.
 */
export function displayText(text: string, max = 240): string {
  const flat = redactTokens(redactUrls(stripAnsi(text).replace(CONTROL, " ")))
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/**
 * Display form of a server target: a URL without credentials, or the file name
 * of a stdio command so the daemon's filesystem layout is not published.
 */
export function displayTarget(raw: string): string {
  const trimmed = stripAnsi(raw).replace(CONTROL, "").trim();
  if (!trimmed) return "-";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return displayText(trimmed, 160);
  return basename(trimmed) || trimmed;
}

/**
 * Pulls the authorization URL out of a login CLI's output. The query string is
 * part of the grant, so this deliberately returns the URL unredacted; it goes
 * straight to the client and is never logged or rendered.
 */
export function firstUrl(text: string): string | null {
  const match = stripAnsi(text).match(/https?:\/\/\S+/);
  if (!match) return null;
  return match[0].replace(/[).,]+$/, "");
}
