import {
    listListeningPorts,
    listDockerContainers,
    probeLocalLlm,
    LLM_SIGNATURE_PORTS,
    type PortOwner,
    type LocalLlmProbe,
    type DockerContainerRow,
} from "./scanner.js";

export type TopologyNode = {
    port: number;
    pid: number;
    address: string;
    tags: string[];
    command?: string;
    cwd?: string;
    docker?: { name: string; image: string };
    llm?: LocalLlmProbe;
};

export type TopologyGraph = {
    scannedAt: string;
    nodes: TopologyNode[];
};

function dockerPortMap(rows: DockerContainerRow[]): Map<number, { name: string; image: string }> {
    const map = new Map<number, { name: string; image: string }>();
    for (const row of rows) {
        for (const part of row.ports.split(",")) {
            const m = part.match(/:(\d+)->/);
            if (m)
                map.set(parseInt(m[1], 10), { name: row.name, image: row.image });
            const host = part.match(/0\.0\.0\.0:(\d+)/);
            if (host)
                map.set(parseInt(host[1], 10), { name: row.name, image: row.image });
        }
    }
    return map;
}

export function ownerToNode(
  owner: PortOwner,
  extras?: Partial<TopologyNode>,
): TopologyNode {
    const tags: string[] = [];
    if (LLM_SIGNATURE_PORTS[owner.port])
        tags.push("llm");
    return {
        port: owner.port,
        pid: owner.pid,
        address: owner.address,
        command: owner.command,
        cwd: owner.cwd,
        tags,
        ...extras,
    };
}

export async function buildTopology(fetchImpl?: typeof fetch): Promise<TopologyGraph> {
    const listeners = await listListeningPorts();
    const dmap = dockerPortMap(await listDockerContainers());
    const nodes: TopologyNode[] = [];
    const seen = new Set<number>();
    for (const row of listeners) {
        if (seen.has(row.port))
            continue;
        seen.add(row.port);
        const llm = LLM_SIGNATURE_PORTS[row.port] ? await probeLocalLlm(row.port, fetchImpl) : null;
        const tags: string[] = [];
        if (llm)
            tags.push("llm");
        if (dmap.has(row.port))
            tags.push("docker");
        nodes.push({
            port: row.port,
            pid: row.pid,
            address: row.address,
            tags,
            docker: dmap.get(row.port),
            llm: llm ?? undefined,
        });
    }
    nodes.sort((a, b) => a.port - b.port);
    return { scannedAt: new Date().toISOString(), nodes };
}

export function findNode(graph: TopologyGraph, port: number): TopologyNode | undefined {
    return graph.nodes.find((n) => n.port === port);
}
