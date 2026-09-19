# Agent instructions

Paseo plugin that lists and authenticates Claude Code and Codex MCP servers from inside Paseo. Keep it small: implement what the feature needs today rather than extension points for later.

## Runtime boundaries

Paseo loads three separate module graphs. Crossing a boundary breaks the load, not the typecheck.

| Directory          | Runtime                | May import                                     |
| ------------------ | ---------------------- | ---------------------------------------------- |
| `index.client.tsx`, `client/` | Paseo app (React Native) | `react`, `react-native`, `@getpaseo/plugin/client`, `@tanstack/react-query`, `shared/` |
| `index.server.ts`, `server/`  | Paseo daemon (Node)      | `node:*`, `@getpaseo/plugin`, `@getpaseo/plugin/server`, `shared/` |
| `shared/`                     | Both                     | `zod`, `@getpaseo/plugin` only |

- No `node:*` or `react-native` import in `shared/`.
- No DOM. `client/web.ts` is the only module allowed to touch a web global, and it declares the global it uses instead of enabling the DOM lib.
- Use React Native primitives (`View`, `Text`, `Pressable`, `StyleSheet`), never HTML elements, `className`, or `onClick`.
- Both entry points only register contributions and return a cleanup function. They own no state.

## Provider output and credentials

- Never copy `env`, `http_headers`, `env_http_headers`, or `bearer_token_env_var` out of a provider's config. Read only the fields the panel renders.
- Everything sent to the client goes through `displayText` or `displayTarget` in `server/exec.ts`: ANSI and control characters stripped, URL userinfo/query/fragment dropped, token-shaped values redacted, length clamped.
- Never log provider output or an OAuth authorization URL. The authorization URL is returned once, to the client, and is not persisted.
- Spawn CLIs as `(bin, args[])` with stdin closed. Never build a shell string. Names and IDs that reach a CLI as arguments are validated in `shared/mcp.ts`.

## Error handling

Expected CLI failures return a value; they do not throw. A provider that fails returns a `ProviderReport` with `available`/`error` set so the other provider's result survives. Unparseable provider output is a provider error, never an empty server list.

## Verification

```bash
npm install
npm run check   # unit tests, then strict typecheck
```

Unit tests live next to the module they cover as `server/*.test.ts` and run on the Node test runner through `tsx`. Parsers, redaction, and command-result judgement are covered by tests; the UI is verified by installing the plugin and using it.

```bash
paseo plugin install "$PWD"
paseo plugin ls
paseo plugin logs paseo-mcp-manager
paseo plugin reload paseo-mcp-manager
```
