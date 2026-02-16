import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  LIVE_SALES_ENDPOINT,
  buildSalesToolResult,
  createSalesSummaryText,
  getErrorMessage,
} from "./sales.js";

const APP_RESOURCE_URI = "ui://choose/current-sales";
const APP_RESOURCE_NAME = "Choose Current Sales";
const TOOL_NAME = "choose-current-sales";
const DEFAULT_MCP_PATH = "/mcp";
const DEFAULT_MCP_HOST = "127.0.0.1";
const DEFAULT_MCP_PORT = 3001;

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFilePath);
const projectRoot = path.resolve(currentDirectory, "..");
const appHtmlPath = path.join(projectRoot, "dist", "mcp-app.html");

const mcpPath = process.env.MCP_PATH ?? DEFAULT_MCP_PATH;
const mcpHost = process.env.MCP_HOST ?? DEFAULT_MCP_HOST;
const parsedPort = Number.parseInt(process.env.MCP_PORT ?? "", 10);
const mcpPort = Number.isNaN(parsedPort) ? DEFAULT_MCP_PORT : parsedPort;

type SessionContext = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

const sessions = new Map<string, SessionContext>();

let appHtmlCache: string | null = null;

async function readAppHtml(): Promise<string> {
  if (appHtmlCache !== null) {
    return appHtmlCache;
  }

  try {
    appHtmlCache = await readFile(appHtmlPath, "utf8");
    return appHtmlCache;
  } catch {
    throw new Error(
      `Missing UI bundle at ${appHtmlPath}. Run "npm run build" before starting the server.`,
    );
  }
}

function createServer(): McpServer {
  const server = new McpServer({
    name: "choose-mcp",
    version: "0.1.0",
  });

  registerAppTool(
    server,
    TOOL_NAME,
    {
      title: "Choose Current Sales",
      description:
        "Fetches live sales from Choose and renders an interactive carousel.",
      _meta: {
        ui: {
          resourceUri: APP_RESOURCE_URI,
          visibility: ["model", "app"],
        },
      },
    },
    async () => {
      try {
        const response = await fetch(LIVE_SALES_ENDPOINT, {
          headers: { accept: "application/json" },
        });

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const payload = await response.json();
        const result = buildSalesToolResult(payload);

        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to fetch current sales: ${message}` }],
        };
      }
    },
  );

  registerAppResource(
    server,
    APP_RESOURCE_NAME,
    APP_RESOURCE_URI,
    {
      description: "React carousel for viewing live Choose sales.",
    },
    async () => ({
      contents: [
        {
          uri: APP_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readAppHtml(),
          _meta: {
            ui: {
              csp: {
                connectDomains: ["https://api.appchoose.io"],
                resourceDomains: [
                  "https://api.appchoose.io",
                  "https://*.appchoose.io",
                  "https://images.ctfassets.net",
                  "https://*.cloudfront.net",
                ],
              },
            },
          },
        },
      ],
    }),
  );

  return server;
}

function readHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }

  return null;
}

function writeJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  if (res.headersSent) {
    return;
  }

  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

async function closeSession(sessionId: string): Promise<void> {
  const context = sessions.get(sessionId);
  if (!context) {
    return;
  }

  sessions.delete(sessionId);

  try {
    await context.transport.close();
  } catch (error: unknown) {
    process.stderr.write(
      `Failed to close transport for session ${sessionId}: ${getErrorMessage(error)}\n`,
    );
  }

  try {
    await context.server.close();
  } catch (error: unknown) {
    process.stderr.write(
      `Failed to close server for session ${sessionId}: ${getErrorMessage(error)}\n`,
    );
  }
}

async function createSessionContext(): Promise<SessionContext> {
  const server = createServer();
  let context: SessionContext;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, context);
      process.stderr.write(`Session initialized: ${sessionId}\n`);
    },
    onsessionclosed: (sessionId) => {
      void closeSession(sessionId);
    },
  });

  context = { server, transport };

  transport.onclose = () => {
    const sessionId = transport.sessionId;
    if (!sessionId) {
      return;
    }

    void closeSession(sessionId);
  };

  await server.connect(transport);
  return context;
}

async function shutdown(signal: string): Promise<void> {
  process.stderr.write(`Received ${signal}. Shutting down Choose-MCP server.\n`);
  const activeSessions = Array.from(sessions.keys());
  await Promise.all(activeSessions.map((sessionId) => closeSession(sessionId)));
  process.exit(0);
}

async function main(): Promise<void> {
  const app = createMcpExpressApp({ host: mcpHost });

  app.get("/", (_req: Request, res: Response) => {
    res.json({
      name: "choose-mcp",
      transport: "streamable-http",
      endpoint: `http://${mcpHost}:${mcpPort}${mcpPath}`,
    });
  });

  app.post(mcpPath, async (req: Request, res: Response) => {
    const sessionId = readHeaderValue(req.headers["mcp-session-id"]);

    try {
      if (sessionId) {
        const existingSession = sessions.get(sessionId);
        if (!existingSession) {
          writeJsonRpcError(res, 404, -32001, "Unknown MCP session ID.");
          return;
        }

        await existingSession.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        writeJsonRpcError(
          res,
          400,
          -32000,
          "No session ID provided for non-initialize request.",
        );
        return;
      }

      const session = await createSessionContext();
      await session.transport.handleRequest(req, res, req.body);
    } catch (error: unknown) {
      process.stderr.write(
        `Error handling MCP POST request: ${getErrorMessage(error)}\n`,
      );
      writeJsonRpcError(res, 500, -32603, "Internal server error.");
    }
  });

  app.get(mcpPath, async (req: Request, res: Response) => {
    const sessionId = readHeaderValue(req.headers["mcp-session-id"]);

    if (!sessionId) {
      writeJsonRpcError(res, 400, -32000, "Missing MCP session ID.");
      return;
    }

    const existingSession = sessions.get(sessionId);
    if (!existingSession) {
      writeJsonRpcError(res, 404, -32001, "Unknown MCP session ID.");
      return;
    }

    try {
      await existingSession.transport.handleRequest(req, res);
    } catch (error: unknown) {
      process.stderr.write(
        `Error handling MCP GET request: ${getErrorMessage(error)}\n`,
      );
      writeJsonRpcError(res, 500, -32603, "Internal server error.");
    }
  });

  app.delete(mcpPath, async (req: Request, res: Response) => {
    const sessionId = readHeaderValue(req.headers["mcp-session-id"]);

    if (!sessionId) {
      writeJsonRpcError(res, 400, -32000, "Missing MCP session ID.");
      return;
    }

    const existingSession = sessions.get(sessionId);
    if (!existingSession) {
      writeJsonRpcError(res, 404, -32001, "Unknown MCP session ID.");
      return;
    }

    try {
      await existingSession.transport.handleRequest(req, res);
    } catch (error: unknown) {
      process.stderr.write(
        `Error handling MCP DELETE request: ${getErrorMessage(error)}\n`,
      );
      writeJsonRpcError(res, 500, -32603, "Internal server error.");
    }
  });

  app.listen(mcpPort, mcpHost, () => {
    process.stderr.write(
      `Choose-MCP server is running on Streamable HTTP: http://${mcpHost}:${mcpPort}${mcpPath}\n`,
    );
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`Failed to start Choose-MCP server: ${message}\n`);
  process.exit(1);
});
