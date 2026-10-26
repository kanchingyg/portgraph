# portgraph

[![ci](https://github.com/kanchingyg/portgraph/actions/workflows/ci.yml/badge.svg)](https://github.com/kanchingyg/portgraph/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/portgraph/latest?label=npm)](https://www.npmjs.com/package/portgraph)
[![JSR](https://jsr.io/badges/@kanchingyg/portgraph)](https://jsr.io/@kanchingyg/portgraph)
[![JSR Score](https://jsr.io/badges/@kanchingyg/portgraph/score)](https://jsr.io/@kanchingyg/portgraph/score)
[![Rust](https://img.shields.io/badge/engine-Rust_%2B_TypeScript-dea584)](https://github.com/kanchingyg/portgraph)
[![license](https://img.shields.io/github/license/kanchingyg/portgraph)](https://github.com/kanchingyg/portgraph/blob/HEAD/LICENSE)

**One line:** `npx portgraph` (or `bunx portgraph`): live local port topology (Docker + Ollama/LM Studio/vLLM) as a terminal TUI and stdio MCP server.

## Install

[Bun](https://bun.sh) / [npm](https://www.npmjs.com/package/portgraph):

```bash
bunx portgraph
npx portgraph

# or install in your project / globally
bun add -d portgraph
npm i -D portgraph
```

[JSR](https://jsr.io/@kanchingyg/portgraph):

```bash
bunx jsr add @kanchingyg/portgraph
npx jsr add @kanchingyg/portgraph
```

[Cargo (Rust native binary)](https://github.com/kanchingyg/portgraph):

```bash
cargo install --git https://github.com/kanchingyg/portgraph
```

The scan engine and MCP stdio server are written in **Rust** (`src/lib.rs`, `src/main.rs`, `src/mcp.rs`). TypeScript under `src/*.ts` is included for `npx` / `bunx` / JSR usage and MCP bridge helpers when no native binary is present.

## CLI

```bash
npx portgraph
bunx portgraph
npx portgraph who :3000
npx portgraph kill :3000 --allow-write
npx portgraph --mcp
npx portgraph --mcp --allow-write
npx portgraph --mcp --dry-run   # blocks mutating tools only
```

## MCP Tools Reference

| Tool | Mutates | Description |
| --- | --- | --- |
| `get_local_topology` | `false` | List active TCP listening ports, owning PIDs, Docker container port mappings, and local LLM server tags (Ollama, LM Studio, vLLM). |
| `who_owns_port` | `false` | Return the process ID, executable name, and command line bound to a specific TCP port. |
| `kill_port_owner` | `true` | Terminate the process listening on a port when `confirm: true` is passed (requires `--allow-write`; blocked under `--dry-run`). |

## Editor and Agent Integration

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "portgraph": {
      "command": "npx",
      "args": ["-y", "portgraph", "--mcp"]
    }
  }
}
```

### Claude Code CLI

```bash
claude mcp add portgraph -- npx -y portgraph --mcp
```

### Programmatic Usage (JSR / TypeScript)

```ts
import * as bridge from "jsr:@kanchingyg/portgraph/bridge";
```

## Runtime Safety and Guardrails

- **Stdio frame isolation**: When `--mcp` is active, `hijackStdoutForMcp()` redirects accidental `console.log` calls to `stderr` so JSON-RPC 2.0 frames on `stdout` never corrupt.
- **Read-only by default**: Mutating tools (`mutates: true`) are blocked in `--dry-run` mode and require explicit `--allow-write` authorization.
- **Loop breaker**: Repeated identical `(toolName, args)` invocations are hashed with SHA-256 and halted after 3 consecutive repeats to prevent runaway agent loops.
- **Context budget truncation**: Tool outputs are middle-truncated (`60%` head / `40%` tail) scaled to the probed local model `n_ctx` (Ollama `/api/show`, llama.cpp `/props`, vLLM `/v1/models`).
- **Secret redaction and path normalization**: AWS keys (`AKIA*`, `ASIA*`), bearer tokens, and `sk-*` keys are scrubbed before returning tool output, and Windows drive paths (`C:\...`) translate cleanly to `/mnt/c/...` when WSL mode is enabled.

## License

[MIT](./LICENSE)
