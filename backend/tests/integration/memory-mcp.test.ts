import express from "express";
import { createServer, Server as HttpServer } from "http";
import { createMemoryMcpHttpHandler } from "../../src/mcp/server";

describe("authenticated memory MCP HTTP transport", () => {
  let server: HttpServer;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: "256kb" }));
    app.all("/mcp", await createMemoryMcpHttpHandler({
      token: "test-bearer-token",
      memoryToolHandler: async (name, args) => JSON.stringify({ name, args }),
    }));
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    baseUrl = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterAll(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

  async function post(body: unknown, token?: string) {
    return fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async function payload(response: Response): Promise<any> {
    const text = await response.text();
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      const data = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
      return data[data.length - 1];
    }
    return text ? JSON.parse(text) : null;
  }

  it("rejects missing and wrong bearer tokens without echoing secrets", async () => {
    expect((await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).status).toBe(401);
    const wrong = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "wrong-secret");
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).not.toContain("wrong-secret");
  });

  it("registers and calls all curated memory tools over Streamable HTTP", async () => {
    const init = await post({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }, "test-bearer-token");
    expect(init.status).toBe(200);
    expect((await payload(init)).result.serverInfo.name).toBe("ArcRift-memory");

    const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, "test-bearer-token");
    const names = (await payload(listed)).result.tools.map((tool: any) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["memory_search", "memory_propose", "memory_conflicts", "memory_resolve_conflict", "recall_context"]));

    for (const name of ["memory_search", "memory_propose", "memory_conflicts", "memory_resolve_conflict"]) {
      const called = await post({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: { query: "x" } } }, "test-bearer-token");
      expect(called.status).toBe(200);
      expect((await payload(called)).result.content[0].text).toContain(name);
    }
  });

  it("rejects unsupported methods and oversized bodies", async () => {
    const get = await fetch(baseUrl, { headers: { authorization: "Bearer test-bearer-token" } });
    expect(get.status).toBe(405);
    const oversized = await post({ jsonrpc: "2.0", id: 9, method: "x", params: { value: "x".repeat(270_000) } }, "test-bearer-token");
    expect(oversized.status).toBe(413);
  });
});
