# portgraph

[![ci](https://github.com/kanchingyg/portgraph/actions/workflows/ci.yml/badge.svg)](https://github.com/kanchingyg/portgraph/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/portgraph)](https://www.npmjs.com/package/portgraph)
[![JSR](https://jsr.io/badges/@kanchingyg/portgraph)](https://jsr.io/@kanchingyg/portgraph)
[![Rust](https://img.shields.io/badge/engine-Rust-dea584)](https://github.com/kanchingyg/portgraph)
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

## MCP tools

| Tool | Purpose |
| --- | --- |
| `get_local_topology` | Active listening ports, PIDs, Docker mappings, and local LLM signature tags |
| `who_owns_port` | Owning process and command line for a specific listening port |
| `kill_port_owner` | Terminate port owner (`confirm: true`; requires `--allow-write`, blocked under `--dry-run`) |

## License

[MIT](./LICENSE)
