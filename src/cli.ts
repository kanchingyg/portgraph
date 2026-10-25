#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
    startMcpServer,
    setGuards,
    truncateToolOutput,
    type McpToolDefinition,
} from "./bridge.js";
import { parsePortInput, whoOwnsPort, killPortOwner, resolveProcessMeta } from "./scanner.js";
import { buildTopology, findNode } from "./topology.js";
import { printTui } from "./tui.js";
import { assertPathContained } from "./path-guard.js";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_JSON = assertPathContained("package.json", PKG_ROOT);
const PKG_VERSION = JSON.parse(readFileSync(PKG_JSON, "utf8")).version as string;

function tryNativeCli(argv: string[]): number | null {
    if (process.env.PORTGRAPH_TS_ONLY === "1") return null;
    const exe = process.platform === "win32" ? "portgraph.exe" : "portgraph";
    const local = join(PKG_ROOT, "target", "release", exe);
    const candidates = [local, "portgraph"];
    for (const bin of candidates) {
        if (bin !== "portgraph" && !existsSync(bin)) continue;
        const child = spawnSync(bin, argv, { stdio: "inherit" });
        if (child.error && (child.error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return child.status ?? 1;
    }
    return null;
}

export function createPortgraphTools(): McpToolDefinition[] {
    return [
        {
            name: "get_local_topology",
            description: "Map active local ports, PIDs, Docker, and LLM servers.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true },
            handler: async () => buildTopology(),
        },
        {
            name: "who_owns_port",
            description: "Resolve process, command, and cwd for a TCP port.",
            inputSchema: {
                type: "object",
                properties: { port: { type: "number" } },
                required: ["port"],
                additionalProperties: false,
            },
            annotations: { readOnlyHint: true },
            handler: async (args) => {
                const port =
                    typeof args.port === "number" ? args.port : parsePortInput(String(args.port));
                const graph = await buildTopology();
                const node = findNode(graph, port);
                if (!node || node.pid <= 0)
                    return { owner: null, node };
                const meta = await resolveProcessMeta(node.pid);
                return {
                    owner: { port, pid: node.pid, address: node.address, ...meta },
                    node,
                };
            },
        },
        {
            name: "kill_port_owner",
            description: "Terminate the process bound to a port (destructive).",
            inputSchema: {
                type: "object",
                properties: { port: { type: "number" }, confirm: { type: "boolean" } },
                required: ["port", "confirm"],
                additionalProperties: false,
            },
            annotations: { destructiveHint: true },
            mutates: true,
            handler: async (args, ctx) => {
                const port =
                    typeof args.port === "number" ? args.port : parsePortInput(String(args.port));
                if (ctx.dryRun)
                    return { dryRun: true, port, confirm: Boolean(args.confirm) };
                return killPortOwner(port, Boolean(args.confirm));
            },
        },
    ];
}

export async function runCli(argv: string[]): Promise<number> {
    const nativeCode = tryNativeCli(argv);
    if (nativeCode !== null) return nativeCode;

    if (argv.includes("--mcp")) {
        if (argv.includes("--allow-write"))
            setGuards({ allowWrite: true });
        if (argv.includes("--dry-run"))
            setGuards({ dryRun: true });
        startMcpServer(
            { name: "portgraph", version: PKG_VERSION },
            createPortgraphTools(),
            {
                allowWrite: argv.includes("--allow-write"),
                pathToWsl: argv.includes("--path-wsl"),
            },
        );
        return 0;
    }
    const allowWrite = argv.includes("--allow-write");
    if (allowWrite)
        setGuards({ allowWrite: true });
    const cmd = argv.find((a) => !a.startsWith("-"));
    if (cmd === "who") {
        const port = parsePortInput(argv[argv.indexOf("who") + 1] ?? argv[1]);
        const owner = await whoOwnsPort(port);
        process.stderr.write(truncateToolOutput(JSON.stringify(owner, null, 2), 4096) + "\n");
        return owner ? 0 : 1;
    }
    if (cmd === "kill") {
        if (!allowWrite) {
            process.stderr.write("Read-only: pass --allow-write to kill a port owner.\n");
            return 1;
        }
        const res = await killPortOwner(parsePortInput(argv[argv.indexOf("kill") + 1] ?? argv[1]), true);
        process.stderr.write(res.message + "\n");
        return res.ok ? 0 : 1;
    }
    if (argv.includes("--help") || argv.includes("-h")) {
        process.stderr.write("portgraph — npx portgraph | who :PORT | kill :PORT --allow-write | --mcp\n");
        return 0;
    }
    printTui(await buildTopology());
    return 0;
}

if (process.argv[1]?.includes("cli") || process.argv[1]?.endsWith("portgraph")) {
    const args = process.argv.slice(2).filter((a) => a !== "test");
    void runCli(args).then((code) => {
        if (!args.includes("--mcp"))
            process.exit(code);
    });
}
