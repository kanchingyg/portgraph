import { createHash } from "node:crypto";

/** Constant `DEFAULT_N_CTX` defining default n ctx. */
export const DEFAULT_N_CTX = 4096;

/** Configuration and data shape for `McpToolAnnotations` (mcp tool annotations). */
export type McpToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
};

/** Configuration and data shape for `McpToolContext` (mcp tool context). */
export type McpToolContext = {
  dryRun: boolean;
  allowWrite: boolean;
  nCtx: number;
};

/** Configuration and data shape for `McpToolDefinition` (mcp tool definition). */
export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: McpToolAnnotations;
  mutates?: boolean;
  handler: (
    args: Record<string, unknown>,
    ctx: McpToolContext,
  ) => Promise<unknown> | unknown;
};

/** Configuration and data shape for `GuardOptions` (guard options). */
export type GuardOptions = { allowWrite?: boolean; dryRun?: boolean };

/** Configuration and data shape for `JsonRpcMessage` (json rpc message). */
export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
};

/** Configuration and data shape for `ChatMessage` (chat message). */
export type ChatMessage = {
  role: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: unknown[];
};

/** Configuration and data shape for `ReasoningState` (reasoning state). */
export type ReasoningState = {
  inToolLoop: boolean;
  lastUserTurnIndex: number;
};

/** Configuration and data shape for `NCtxSource` (nctx source). */
export type NCtxSource = "llama.cpp" | "vllm" | "fallback";

/** Configuration and data shape for `DirtyToolCall` (dirty tool call). */
export type DirtyToolCall = { name: string; arguments: Record<string, unknown> };
const TRUNC_MARKER = "[...TRUNCATED BY PORTGRAPH CONTEXT GUARD...]";
/** Executes `headTailTruncate` to head tail truncate in `portgraph`. */
export function headTailTruncate(text: string, maxChars: number): string {
    if (text.length <= maxChars)
        return text;
    const headLen = Math.floor(maxChars * 0.6);
    const tailLen = Math.floor(maxChars * 0.4) - TRUNC_MARKER.length;
    if (tailLen < 0)
        return text.slice(0, maxChars);
    return text.slice(0, headLen) + TRUNC_MARKER + text.slice(-tailLen);
}
/** Executes `truncateToolOutput` to truncate tool output in `portgraph`. */
export function truncateToolOutput(text: string, nCtx: number): string {
    return headTailTruncate(text, Math.floor(nCtx * 4 * 0.3));
}
/** Executes `probeNCtx` to probe nctx in `portgraph`. */
export async function probeNCtx(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ nCtx: number; source: NCtxSource }> {
    const base = baseUrl.replace(/\/$/, "");
    try {
        const props = await fetchImpl(`${base}/props`);
        if (props.ok) {
            const j = (await props.json()) as { n_ctx?: number };
            if (j.n_ctx && j.n_ctx > 0)
                return { nCtx: j.n_ctx, source: "llama.cpp" };
        }
    }
    catch { /* */ }
    try {
        const models = await fetchImpl(`${base}/v1/models`);
        if (models.ok) {
            const n = (await models.json() as { data?: { max_model_len?: number }[] }).data?.[0]
                ?.max_model_len;
            if (n && n > 0)
                return { nCtx: n, source: "vllm" };
        }
    }
    catch { /* */ }
    return { nCtx: DEFAULT_N_CTX, source: "fallback" };
}
const THINK_OPEN = "<" + "think" + ">";
const THINK_CLOSE = "</" + "think" + ">";
/** Executes `stripRedactedThinking` to strip redacted thinking in `portgraph`. */
export function stripRedactedThinking(text: string): string {
    return text.replace(new RegExp(`${THINK_OPEN}[\\s\\S]*?${THINK_CLOSE}`, "gi"), "").trim();
}
/** Executes `parseDirtyToolCall` to parse dirty tool call in `portgraph`. */
export function parseDirtyToolCall(
  raw: string,
  tools: { name: string }[],
): DirtyToolCall | null {
    const cleaned = stripRedactedThinking(raw);
    const m = cleaned.match(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/i);
    const jsonStr = m?.[1] ?? cleaned.match(/\{[\s\S]*"name"[\s\S]*\}/)?.[0];
    if (!jsonStr)
        return null;
    try {
        const parsed = JSON.parse(jsonStr) as { name?: string; arguments?: Record<string, unknown> };
        if (!parsed.name || !tools.some((t) => t.name === parsed.name))
            return null;
        return { name: parsed.name, arguments: parsed.arguments ?? {} };
    }
    catch {
        return null;
    }
}
/** Executes `createReasoningState` to create reasoning state in `portgraph`. */
export function createReasoningState(): ReasoningState {
    return { inToolLoop: false, lastUserTurnIndex: -1 };
}
/** Executes `applyReasoningContentPolicy` to apply reasoning content policy in `portgraph`. */
export function applyReasoningContentPolicy(
  messages: ChatMessage[],
  state: ReasoningState,
): { messages: ChatMessage[]; state: ReasoningState } {
    let lastUser = -1;
    for (let i = 0; i < messages.length; i++)
        if (messages[i].role === "user")
            lastUser = i;
    const newUserTurn = lastUser > state.lastUserTurnIndex;
    if (newUserTurn)
        state = { ...state, lastUserTurnIndex: lastUser, inToolLoop: false };
    if (messages.some((m) => m.role === "assistant" && m.tool_calls?.length))
        state = { ...state, inToolLoop: true };
    const cleaned = messages.map((m, idx) => {
        const copy = { ...m };
        if (typeof copy.content === "string")
            copy.content = stripRedactedThinking(copy.content);
        if (newUserTurn && copy.role === "assistant" && idx < lastUser)
            delete copy.reasoning_content;
        if (!state.inToolLoop && copy.role === "assistant")
            delete copy.reasoning_content;
        return copy;
    });
    return { messages: cleaned, state };
}
/** Executes `sanitizeRequestBody` to sanitize request body in `portgraph`. */
export function sanitizeRequestBody(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
    const out = { ...body };
    if (/deepseek-reasoner|qwq|glm-z1|thinking/i.test(model)) {
        delete out.temperature;
        delete out.top_p;
    }
    return out;
}
/** Executes `assertEmbeddingDimension` to assert embedding dimension in `portgraph`. */
export function assertEmbeddingDimension(expected: number, actual: number): void {
    if (expected !== actual)
        throw new Error(`Embedding dimension mismatch: expected ${expected}, got ${actual}`);
}
/** Executes `mrlSlice` to mrl slice in `portgraph`. */
export function mrlSlice(vec: number[], dimensions: number): number[] {
    const sliced = vec.slice(0, dimensions);
    let sum = 0;
    for (const v of sliced)
        sum += v * v;
    const norm = Math.sqrt(sum) || 1;
    return sliced.map((v) => v / norm);
}
let allowWrite = false;
let dryRun = false;
/** Executes `setGuards` to set guards in `portgraph`. */
export function setGuards(opts: GuardOptions): void {
    allowWrite = Boolean(opts.allowWrite);
    dryRun = Boolean(opts.dryRun);
}
/** Executes `canonicalizeJson` to canonicalize json in `portgraph`. */
export function canonicalizeJson(value: unknown): string {
    if (value === null || value === undefined)
        return "null";
    if (typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map((v) => canonicalizeJson(v)).join(",")}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`).join(",")}}`;
}
const loopState = { lastHash: "", repeatCount: 0 };
/** Executes `resetLoopBreaker` to reset loop breaker in `portgraph`. */
export function resetLoopBreaker() {
    loopState.lastHash = "";
    loopState.repeatCount = 0;
}
/** Executes `checkLoopBreaker` to check loop breaker in `portgraph`. */
export function checkLoopBreaker(toolName: string, args: unknown): string | null {
    const h = createHash("sha256").update(`${toolName}:${canonicalizeJson(args)}`).digest("hex");
    if (h === loopState.lastHash)
        loopState.repeatCount++;
    else {
        loopState.lastHash = h;
        loopState.repeatCount = 1;
    }
    if (loopState.repeatCount >= 3) {
        return "LOOP_BREAKER: Identical tool call repeated 2 times consecutively. Stop calling tools and return your final synthesis.";
    }
    return null;
}
/** Executes `guardMutatingTool` to guard mutating tool in `portgraph`. */
export function guardMutatingTool(
  tool: McpToolDefinition | undefined,
): { blocked: boolean; reason?: string } {
    if (!tool?.mutates)
        return { blocked: false };
    if (dryRun) {
        return {
            blocked: true,
            reason: `[dry-run] Would call mutating tool ${tool.name}; pass --allow-write and omit --dry-run to execute.`,
        };
    }
    if (!allowWrite)
        return { blocked: true, reason: "Read-only mode: pass --allow-write to enable mutating tools." };
    return { blocked: false };
}
const WIN_DRIVE_RE = /^([A-Za-z]):\\(.*)$/;
const WSL_RE = /^\/mnt\/([a-z])\/(.*)$/i;
/** Executes `windowsToWsl` to windows to wsl in `portgraph`. */
export function windowsToWsl(p: string): string {
    const m = p.match(WIN_DRIVE_RE);
    return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}` : p;
}
/** Executes `wslToWindows` to wsl to windows in `portgraph`. */
export function wslToWindows(p: string): string {
    const m = p.match(WSL_RE);
    return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}` : p;
}
/** Executes `normalizePathsDeep` to normalize paths deep in `portgraph`. */
export function normalizePathsDeep<T>(value: T, toWsl: boolean): T {
    if (typeof value === "string") {
        if (toWsl && WIN_DRIVE_RE.test(value))
            return windowsToWsl(value) as T;
        if (!toWsl && WSL_RE.test(value))
            return wslToWindows(value) as T;
        return value;
    }
    if (Array.isArray(value))
        return value.map((v) => normalizePathsDeep(v, toWsl)) as T;
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value))
            out[k] = normalizePathsDeep(v, toWsl);
        return out as T;
    }
    return value;
}
let jsonRpcWrite: ((line: string) => void) | null = null;
let stdoutHijacked = false;
/** Executes `hijackStdoutForMcp` to hijack stdout for mcp in `portgraph`. */
export function hijackStdoutForMcp() {
    if (stdoutHijacked)
        return;
    stdoutHijacked = true;
    const native = process.stdout.write.bind(process.stdout);
    jsonRpcWrite = (line) => native(line);
    process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
        const str = typeof chunk === "string" ? chunk : Buffer.from(chunk as Buffer).toString();
        if (jsonRpcWrite && str.trim().startsWith("{") && str.includes('"jsonrpc"'))
            return native(chunk as string, ...(args as []));
        process.stderr.write(str);
        return true;
    }) as typeof process.stdout.write;
}
/** Constant `jsonRpcFrameLog` defining json rpc frame log. */
export const jsonRpcFrameLog: string[] = [];
/** Executes `writeJsonRpcFrame` to write json rpc frame in `portgraph`. */
export function writeJsonRpcFrame(obj: object): void {
    const line = JSON.stringify(obj) + "\n";
    jsonRpcFrameLog.push(line);
    if (jsonRpcWrite)
        jsonRpcWrite(line);
    else
        process.stdout.write(line);
}
/** Configuration and data shape for `McpServerOptions` (mcp server options). */
export type McpServerOptions = {
  allowWrite?: boolean;
  pathToWsl?: boolean;
  nCtx?: number;
};

/** Executes `dispatchMcpMessage` to dispatch mcp message in `portgraph`. */
export function dispatchMcpMessage(
  msg: JsonRpcMessage,
  meta: { name: string; version: string },
  tools: McpToolDefinition[],
  options?: McpServerOptions,
): void {
    const toWsl = options?.pathToWsl ?? false;
    const nCtx = options?.nCtx ?? DEFAULT_N_CTX;
    const { id, method, params } = msg;
    if (method === "initialize") {
        writeJsonRpcFrame({
            jsonrpc: "2.0",
            id,
            result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: meta.name, version: meta.version } },
        });
        return;
    }
    if (method === "notifications/initialized")
        return;
    if (method === "tools/list") {
        writeJsonRpcFrame({
            jsonrpc: "2.0",
            id,
            result: { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })) },
        });
        return;
    }
    if (method === "tools/call") {
        const name = params?.name;
        const args = normalizePathsDeep(params?.arguments ?? {}, toWsl);
        const tool = tools.find((t) => t.name === name);
        const loopErr = checkLoopBreaker(name ?? "", args);
        if (loopErr) {
            writeJsonRpcFrame({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: loopErr }], isError: true } });
            return;
        }
        if (tool) {
            const guard = guardMutatingTool(tool);
            if (guard.blocked) {
                writeJsonRpcFrame({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: guard.reason ?? "blocked" }], isError: true } });
                return;
            }
        }
        void (async () => {
            try {
                if (!tool)
                    throw new Error(`Unknown tool: ${name}`);
                const result = await tool.handler(args, { dryRun, allowWrite, nCtx });
                const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
                writeJsonRpcFrame({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: finalizeMcpToolText(text, { nCtx, toWsl }) }] } });
            }
            catch (e) {
                writeJsonRpcFrame({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: finalizeMcpToolText(String(e), { nCtx, toWsl }) }], isError: true } });
            }
        })();
        return;
    }
    if (id !== undefined)
        writeJsonRpcFrame({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}
/** Executes `startMcpServer` to start mcp server in `portgraph`. */
export function startMcpServer(
  meta: { name: string; version: string },
  tools: McpToolDefinition[],
  options?: McpServerOptions,
): void {
    if (options?.allowWrite)
        setGuards({ allowWrite: true });
    hijackStdoutForMcp();
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line)
                continue;
            try {
                dispatchMcpMessage(JSON.parse(line) as JsonRpcMessage, meta, tools, options);
            }
            catch { /* */ }
        }
    });
}
/** Executes `redactSecrets` to redact secrets in `portgraph`. */
export function redactSecrets(text: string): string {
    return String(text)
        .replace(/(api[_-]?key|token|password|secret)\s*[=:]\s*[^\s]+/gi, "$1=[REDACTED]")
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
        .replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED]");
}
/** Executes `finalizeMcpToolText` to finalize mcp tool text in `portgraph`. */
export function finalizeMcpToolText(
  text: string,
  opts?: { nCtx?: number; toWsl?: boolean },
): string {
    const nCtx = opts?.nCtx ?? DEFAULT_N_CTX;
    const toWsl = opts?.toWsl ?? false;
    return normalizePathsDeep(redactSecrets(truncateToolOutput(String(text), nCtx)), !toWsl);
}
//# sourceMappingURL=bridge.js.map