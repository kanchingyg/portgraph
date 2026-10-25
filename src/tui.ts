import type { TopologyGraph } from "./topology.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";

export function renderTopology(graph: TopologyGraph): string {
    const lines: string[] = [];
    lines.push(`${CYAN}portgraph${RESET} ${DIM}local topology${RESET}  ${graph.scannedAt}`);
    lines.push("");
    if (graph.nodes.length === 0) {
        lines.push("  (no listening ports detected)");
        return lines.join("\n");
    }
    lines.push("  PORT     PID      TAGS           SERVICE / MODEL");
    lines.push("  " + "─".repeat(52));
    for (const n of graph.nodes) {
        const tags = n.tags.length ? n.tags.join(",") : "-";
        const svc = n.llm?.models?.slice(0, 2).join(", ") ?? n.docker?.name ?? n.command?.slice(0, 28) ?? n.address;
        lines.push(`  ${String(n.port).padEnd(8)} ${String(n.pid).padEnd(8)} ${tags.padEnd(14)} ${svc}`);
    }
    lines.push("");
    lines.push(`${GREEN}tip${RESET}  npx portgraph who :3000  ·  npx portgraph --mcp`);
    return lines.join("\n");
}

export function printTui(graph: TopologyGraph): void {
    process.stderr.write(renderTopology(graph) + "\n");
}
