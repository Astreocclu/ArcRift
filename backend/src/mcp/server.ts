/** ArcRift MCP server shared by stdio and authenticated Streamable HTTP. */
import crypto from "crypto";
import dotenv from "dotenv";
import path from "path";
import { RequestHandler } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../../../backend/.env") });

import { recall } from "./tools/recall";
import { store } from "./tools/store";
import { prune } from "./tools/prune";
import { search } from "./tools/search";
import { listProjects } from "./tools/projects";
import { getSummary } from "./tools/summary";
import { identifyProject } from "./tools/detector";
import { indexCodebase } from "./tools/index_codebase";
import { handleMemoryTool, MEMORY_TOOLS, MemoryToolHandler } from "./memory-tools";
import { initStorage, sessionStore } from "../services/storage";
import { startWorker } from "../services/jobs";
import { logger } from "../utils/logger";

const LEGACY_TOOLS = [
  { name: "recall_context", description: "Retrieve relevant legacy ArcRift context for a prompt.", inputSchema: { type: "object" as const, properties: { prompt: { type: "string" }, project: { type: "string" }, topN: { type: "number" }, debug: { type: "boolean" } }, required: ["prompt"] } },
  { name: "store_memory", description: "Save text to the legacy ArcRift memory path.", inputSchema: { type: "object" as const, properties: { content: { type: "string" }, project: { type: "string" } }, required: ["content", "project"] } },
  { name: "prune_memory", description: "Remove legacy facts or chunks from a project.", inputSchema: { type: "object" as const, properties: { prompt: { type: "string" }, project: { type: "string" } }, required: ["prompt", "project"] } },
  { name: "search_memory", description: "Search across legacy ArcRift sessions.", inputSchema: { type: "object" as const, properties: { query: { type: "string" }, topN: { type: "number" } }, required: ["query"] } },
  { name: "list_projects", description: "List ArcRift projects.", inputSchema: { type: "object" as const, properties: {}, required: [] } },
  { name: "get_project_summary", description: "Get a legacy knowledge graph summary.", inputSchema: { type: "object" as const, properties: { project: { type: "string" } }, required: ["project"] } },
  { name: "identify_active_project", description: "Identify an ArcRift project from a folder path.", inputSchema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "index_codebase", description: "Index source files into a legacy ArcRift project.", inputSchema: { type: "object" as const, properties: { directoryPath: { type: "string" }, sessionId: { type: "string" } }, required: ["directoryPath"] } },
];

export const TOOLS = [...LEGACY_TOOLS, ...MEMORY_TOOLS];

export function createArcRiftMcpServer(options: { memoryToolHandler?: MemoryToolHandler } = {}): Server {
  const server = new Server({ name: "ArcRift-memory", version: "1.7.0" }, { capabilities: { tools: {}, resources: {} } });
  const memoryHandler = options.memoryToolHandler ?? handleMemoryTool;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const sessions = await sessionStore.getSessions();
    return { resources: sessions.map(session => ({ uri: `ArcRift://projects/${session._id}/graph`, name: `${session.projectName} Knowledge Graph`, mimeType: "text/markdown" })) };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    const uri = new URL(request.params.uri);
    const match = uri.pathname.match(/\/projects\/([^/]+)\/graph/);
    if (!match) throw new Error(`Invalid resource URI: ${request.params.uri}`);
    return { contents: [{ uri: request.params.uri, mimeType: "text/markdown", text: await getSummary(match[1]) }] };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args = {} } = request.params;
    try {
      if (MEMORY_TOOLS.some(tool => tool.name === name)) return { content: [{ type: "text", text: await memoryHandler(name, args as Record<string, unknown>) }] };
      let result: string;
      switch (name) {
        case "recall_context": result = await recall(args.prompt as string, args.project as string, args.topN as number | undefined, args.debug as boolean | undefined); break;
        case "store_memory": result = await store(args.content as string, args.project as string); break;
        case "prune_memory": result = await prune(args.prompt as string, args.project as string); break;
        case "search_memory": result = await search(args.query as string, args.topN as number | undefined); break;
        case "list_projects": result = await listProjects(); break;
        case "get_project_summary": result = await getSummary(args.project as string); break;
        case "identify_active_project": result = await identifyProject(args.path as string); break;
        case "index_codebase": result = await indexCodebase(args.directoryPath as string, args.sessionId as string | undefined); break;
        default: return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
      return { content: [{ type: "text", text: result }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });
  return server;
}

function validBearer(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const target = Buffer.from(expected);
  return supplied.length === target.length && crypto.timingSafeEqual(supplied, target);
}

export async function createMemoryMcpHttpHandler(options: { token: string; memoryToolHandler?: MemoryToolHandler; maxBodyBytes?: number }): Promise<RequestHandler> {
  if (!options.token) throw new Error("ArcRift MCP bearer token must not be empty");
  const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024;
  return async (request, response) => {
    if (request.method !== "POST") { response.setHeader("Allow", "POST"); response.status(405).json({ error: "Method not allowed" }); return; }
    if (!validBearer(request.header("authorization"), options.token)) { response.status(401).json({ error: "Unauthorized" }); return; }
    if (!request.is("application/json")) { response.status(415).json({ error: "Content-Type must be application/json" }); return; }
    if (Buffer.byteLength(JSON.stringify(request.body ?? null), "utf8") > maxBodyBytes) { response.status(413).json({ error: "Request body too large" }); return; }
    const server = createArcRiftMcpServer({ memoryToolHandler: options.memoryToolHandler });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => { transport.close().catch(() => undefined); });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  };
}

async function main() {
  process.env.ARCRIFT_MCP_MODE = "true";
  await initStorage();
  startWorker().catch(error => logger.error("Failed to start job worker:", error));
  const server = createArcRiftMcpServer();
  await server.connect(new StdioServerTransport());
  logger.info("ArcRift MCP Server running on stdio");
}

if (require.main === module) main().catch(error => { process.stderr.write(`[ArcRift MCP] Fatal: ${error}\n`); process.exit(1); });
