import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:net";
import {
  hijackStdoutForMcp,
  jsonRpcFrameLog,
  dispatchMcpMessage,
  setGuards,
  resetLoopBreaker,
  checkLoopBreaker,
  guardMutatingTool,
  windowsToWsl,
  headTailTruncate,
  probeNCtx,
  applyReasoningContentPolicy,
  createReasoningState,
  sanitizeRequestBody,
  assertEmbeddingDimension,
  mrlSlice,
  parseDirtyToolCall,
  redactSecrets,
} from "../src/bridge.js";
import { whoOwnsPort, fetchOpenAiCompatModels } from "../src/scanner.js";
import { buildTopology, ownerToNode, findNode } from "../src/topology.js";
import { createPortgraphTools } from "../src/cli.js";

describe("who_owns_port + topology", () => {
  let server: ReturnType<typeof createServer>;
  let port = 0;
  beforeEach(async () => {
    server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it("detects current process listener and builds graph node", async () => {
    const owner = await whoOwnsPort(port);
    expect(owner?.pid).toBe(process.pid);
    expect(findNode(await buildTopology(), port)?.pid).toBe(process.pid);
    expect(ownerToNode(owner!).port).toBe(port);
  });
});

describe("MCP JSON-RPC", () => {
  const meta = { name: "portgraph", version: "0.1.0" };
  const tools = createPortgraphTools();
  beforeEach(() => {
    jsonRpcFrameLog.length = 0;
    resetLoopBreaker();
    setGuards({ allowWrite: false, dryRun: false });
    hijackStdoutForMcp();
  });
  it("handshake initialize and tools/list", () => {
    dispatchMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, meta, tools);
    dispatchMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, meta, tools);
    expect(JSON.parse(jsonRpcFrameLog[0].trim()).result.serverInfo.name).toBe("portgraph");
  });
  it("blocks kill_port_owner without allow-write", async () => {
    dispatchMcpMessage(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "kill_port_owner", arguments: { port: 9, confirm: true } } },
      meta,
      tools,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(JSON.parse(jsonRpcFrameLog.at(-1)!.trim()).result.isError).toBe(true);
  });

  it("dry-run blocks kill_port_owner but runs get_local_topology", async () => {
    setGuards({ dryRun: true, allowWrite: false });
    dispatchMcpMessage(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "kill_port_owner", arguments: { port: 9, confirm: true } },
      },
      meta,
      tools,
    );
    await new Promise((r) => setTimeout(r, 50));
    const killFrame = JSON.parse(jsonRpcFrameLog.at(-1)!.trim());
    expect(killFrame.result.isError).toBe(true);
    expect(killFrame.result.content[0].text).toMatch(/dry-run/);

    dispatchMcpMessage(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "get_local_topology", arguments: {} },
      },
      meta,
      tools,
    );
    await new Promise((r) => setTimeout(r, 500));
    const topoLine = jsonRpcFrameLog.find((l) => l.includes('"id":5'));
    const topoFrame = JSON.parse((topoLine ?? jsonRpcFrameLog.at(-1)!).trim());
    expect(topoFrame.result.isError).toBeUndefined();
    expect(topoFrame.result.content[0].text).toContain("scannedAt");
  });
});

describe("Blindaje 4 stdout hijack", () => {
  beforeEach(() => {
    jsonRpcFrameLog.length = 0;
    hijackStdoutForMcp();
  });
  it("normalizes Windows paths in tool args", async () => {
    const tools = [
      {
        name: "echo_path",
        description: "Echo path for MCP stdio guard test.",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
        handler: async (args: Record<string, unknown>) => {
          process.stdout.write("NOISE\n");
          return args;
        },
      },
    ] as ReturnType<typeof createPortgraphTools>;
    dispatchMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo_path", arguments: { path: "D:\\proj\\app.ts" } } },
      { name: "portgraph", version: "0.1.0" },
      tools,
      { pathToWsl: true },
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(JSON.parse(jsonRpcFrameLog.at(-1)!.trim()).result.content[0].text).toContain("/mnt/d/proj/app.ts");
  });
});

describe("Blindaje 1 loop breaker", () => {
  beforeEach(() => resetLoopBreaker());
  it("trips on third identical call", () => {
    expect(checkLoopBreaker("get_local_topology", {})).toBeNull();
    expect(checkLoopBreaker("get_local_topology", {})).toBeNull();
    expect(checkLoopBreaker("get_local_topology", {})).toMatch(/LOOP_BREAKER/);
  });
});

describe("Blindaje 2 n_ctx", () => {
  it("head+tail truncation", () => {
    expect(headTailTruncate("a".repeat(200), 120)).toContain("PORTGRAPH CONTEXT GUARD");
  });
});

describe("Blindaje 5 reasoning", () => {
  it("strips thinking", () => {
    const { messages } = applyReasoningContentPolicy(
      [{ role: "user", content: "hi" }, { role: "assistant", content: "<" + "think" + ">x</" + "think" + ">ok" }],
      createReasoningState(),
    );
    expect(messages[1].content).toBe("ok");
  });
});

describe("Ollama adapter", () => {
  it("lists models", async () => {
    const ids = await fetchOpenAiCompatModels("http://127.0.0.1:1234", async () => new Response(JSON.stringify({ data: [{ id: "llama3" }] })));
    expect(ids).toEqual(["llama3"]);
  });
});

describe("secret redactor", () => {
  it("redacts tokens", () => {
    expect(redactSecrets("sk-abcdefghijklmnopqrstuvwxyz")).toContain("[REDACTED]");
  });
});
