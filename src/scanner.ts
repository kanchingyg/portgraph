import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LLM_SIGNATURE_PORTS: Record<number, string> = {
    11434: "ollama",
    1234: "lmstudio",
    8000: "vllm",
    8080: "llamacpp",
    6333: "qdrant",
};

export type PortListener = {
    port: number;
    pid: number;
    address: string;
};

export type PortOwner = {
    port: number;
    pid: number;
    address: string;
    command?: string;
    cwd?: string;
};

export type DockerContainerRow = {
    name: string;
    ports: string;
    image: string;
};

export type LocalLlmProbe = {
    provider: string;
    port: number;
    models: string[];
    nCtx?: number;
};

export function parsePortInput(raw: string): number {
    const s = raw.trim().replace(/^:/, "");
    const n = parseInt(s, 10);
    if (!Number.isFinite(n) || n < 1 || n > 65535)
        throw new Error(`Invalid port: ${raw}`);
    return n;
}

function execText(file: string, args: string[]): Promise<string> {
    return execFileAsync(file, args, {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        shell: false,
    }).then((r) => r.stdout);
}

export async function listListeningPorts(): Promise<PortListener[]> {
    if (process.platform === "win32") {
        const out = await execText("netstat", ["-ano"]);
        const rows: PortListener[] = [];
        for (const line of out.split(/\r?\n/)) {
            if (!/LISTENING/i.test(line))
                continue;
            const m = line.match(/TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
            if (!m)
                continue;
            const port = parseInt(m[2], 10);
            const pid = parseInt(m[3], 10);
            if (pid > 0)
                rows.push({ port, pid, address: m[1] });
        }
        return rows;
    }
    try {
        const out = await execText("ss", ["-tlnp"]);
        const rows: PortListener[] = [];
        for (const line of out.split(/\n/)) {
            const pm = line.match(/:(\d+)\s/);
            if (!pm)
                continue;
            const port = parseInt(pm[1], 10);
            const pidm = line.match(/pid=(\d+)/);
            const pid = pidm ? parseInt(pidm[1], 10) : 0;
            const addr = line.trim().split(/\s+/)[3] ?? "*";
            if (port > 0)
                rows.push({ port, pid, address: addr });
        }
        return rows;
    }
    catch {
        const out = await execText("netstat", ["-tlnp"]);
        const rows: PortListener[] = [];
        for (const line of out.split(/\n/)) {
            const m = line.match(/:(\d+)\s+.*LISTEN/i);
            if (!m)
                continue;
            const port = parseInt(m[1], 10);
            const pidm = line.match(/\/(\d+)\//);
            const pid = pidm ? parseInt(pidm[1], 10) : 0;
            rows.push({ port, pid, address: "*" });
        }
        return rows;
    }
}

export async function resolveProcessMeta(pid: number): Promise<{ command?: string; cwd?: string }> {
    if (pid <= 0)
        return {};
    if (process.platform === "win32") {
        try {
            const out = await execText("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
            const line = out.split(/\r?\n/).find((l) => l.includes(`"${pid}"`)) ?? out.trim();
            const cols = line.match(/"([^"]*)"/g);
            return { command: cols?.[0]?.replace(/"/g, "") ?? undefined };
        }
        catch {
            return {};
        }
    }
    try {
        const cmd = await execText("ps", ["-p", String(pid), "-o", "command="]);
        return { command: cmd.trim() };
    }
    catch {
        return {};
    }
}

export async function whoOwnsPort(port: number): Promise<PortOwner | null> {
    const hit = (await listListeningPorts()).find((r) => r.port === port);
    if (!hit || hit.pid <= 0)
        return null;
    return { port, pid: hit.pid, address: hit.address, ...(await resolveProcessMeta(hit.pid)) };
}

export async function killPortOwner(
  port: number,
  confirm: boolean,
): Promise<{ ok: boolean; message: string }> {
    if (!confirm)
        return { ok: false, message: "kill_port_owner requires confirm: true" };
    const owner = await whoOwnsPort(port);
    if (!owner)
        return { ok: false, message: `No listener on port ${port}` };
    if (owner.pid === process.pid) {
        return { ok: false, message: "Refusing to kill the current process (agent/IDE guard)" };
    }
    if (process.platform === "win32")
        await execText("taskkill", ["/PID", String(owner.pid), "/F"]);
    else
        process.kill(owner.pid, "SIGTERM");
    return { ok: true, message: `Terminated PID ${owner.pid} on port ${port}` };
}

export async function listDockerContainers(): Promise<DockerContainerRow[]> {
    try {
        const out = await execText("docker", ["ps", "--format", "{{json .}}"]);
        const rows: DockerContainerRow[] = [];
        for (const line of out.split(/\r?\n/)) {
            if (!line.trim())
                continue;
            const j = JSON.parse(line) as { Names?: string; Ports?: string; Image?: string };
            rows.push({ name: j.Names ?? "", ports: j.Ports ?? "", image: j.Image ?? "" });
        }
        return rows;
    }
    catch {
        return [];
    }
}

export async function probeLocalLlm(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalLlmProbe | null> {
    const provider = LLM_SIGNATURE_PORTS[port];
    if (!provider)
        return null;
    const base = `http://127.0.0.1:${port}`;
    const models: string[] = [];
    let nCtx: number | undefined;
    try {
        if (provider === "ollama") {
            const ps = await fetchImpl(`${base}/api/ps`);
            if (ps.ok) {
                const j = (await ps.json()) as { models?: { name: string }[] };
                for (const m of j.models ?? [])
                    models.push(m.name);
            }
        }
        else if (provider === "llamacpp") {
            const props = await fetchImpl(`${base}/props`);
            if (props.ok)
                nCtx = (await props.json() as { n_ctx?: number }).n_ctx;
        }
        else {
            const modelsRes = await fetchImpl(`${base}/v1/models`);
            if (modelsRes.ok) {
                const j = (await modelsRes.json()) as {
                    data?: { id: string; max_model_len?: number }[];
                };
                for (const m of j.data ?? []) {
                    models.push(m.id);
                    if (m.max_model_len)
                        nCtx = m.max_model_len;
                }
            }
        }
    }
    catch {
        return null;
    }
    if (models.length === 0 && provider !== "qdrant")
        models.push(provider);
    return { provider, port, models, nCtx };
}

export async function fetchOpenAiCompatModels(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/v1/models`);
    if (!res.ok)
        return [];
    const j = (await res.json()) as { data?: { id: string }[] };
    return (j.data ?? []).map((d) => d.id);
}
