import {
  All,
  Controller,
  Inject,
  Logger,
  Post,
  Req,
  Res,
  type OnModuleInit,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { trace } from "@opentelemetry/api";
import { McpRegistryService } from "./mcp-registry.service.js";
import { parseMcpBody } from "./mcp-jsonrpc-body.js";
import { buildMcpServer, endpointLabel, type McpServerInfo } from "./mcp-server.factory.js";
import { MCP_FEATURE_OPTIONS } from "./mcp.constants.js";
import type { McpFeatureOptions } from "./mcp.module.js";
import { runWithRequestContext } from "./mcp-request-context.js";

/**
 * Stateless Streamable HTTP MCP endpoint. A fresh Server + transport is built
 * per POST from the registry's cached tools. No auth/session handling — that is
 * the external gateway's responsibility.
 */
@Controller()
export class McpController implements OnModuleInit {
  private readonly logger = new Logger(McpController.name);
  private serverInfo!: McpServerInfo;
  private endpoint!: string;

  constructor(
    private readonly registry: McpRegistryService,
    @Inject(MCP_FEATURE_OPTIONS) private readonly options: McpFeatureOptions,
  ) {}

  onModuleInit(): void {
    this.serverInfo = this.options.serverInfo;
    this.endpoint = endpointLabel(this.serverInfo.name);
  }

  /**
   * Annotates the request's telemetry. Called once per POST, inside the server
   * span opened by the HTTP instrumentation in `initTelemetry`.
   *
   * It creates NO span of its own. The HTTP instrumentation already opened one,
   * and each tool call opens its own child in `buildMcpServer` — a third span
   * here would add a name for the collector's `span_metrics` connector to
   * derive RED series from without adding any information.
   *
   * The DEBUG line fires on `initialize` only. `server.oninitialized` cannot be
   * used for this: the SDK fires that hook from the `notifications/initialized`
   * NOTIFICATION handler while it records `clientInfo` in the `initialize`
   * REQUEST handler, and this transport is stateless — those two arrive on
   * different POSTs, on different Server instances, so the hook would fire on a
   * request that never saw the handshake with `getClientVersion()` undefined.
   */
  private recordMcpTelemetry(body: unknown): void {
    const { method, toolName, clientInfo } = parseMcpBody(body);

    const span = trace.getActiveSpan();
    if (span) {
      span.setAttribute("mcp.endpoint", this.endpoint);
      if (method !== undefined) span.setAttribute("mcp.method", method);
      if (toolName !== undefined) span.setAttribute("mcp.tool", toolName);
    }

    if (method === "initialize") {
      const name = clientInfo?.name ?? "unknown";
      const version = clientInfo?.version ?? "unknown";
      this.logger.debug(
        `MCP initialize: client ${name}@${version} connected to ` +
          `${this.serverInfo.name}@${this.serverInfo.version} (${this.endpoint})`,
      );
    }
  }

  @Post()
  async handlePost(@Req() req: Request, @Res() res: Response): Promise<void> {
    return runWithRequestContext({ headers: req.headers }, async () => {
      this.recordMcpTelemetry(req.body);
      const server = buildMcpServer(this.serverInfo, this.registry.getTools());
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        this.logger.error("MCP handlePost error", err);
        void transport.close();
        void server.close();
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal error" },
            id: null,
          });
        }
      }
    });
  }

  @All()
  fallback(@Req() req: Request, @Res() res: Response): void {
    this.logger.debug(
      `405 ${req.method} ${req.originalUrl} (stateless: only POST is supported)`,
    );
    res
      .status(405)
      .set("Allow", "POST")
      .json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method Not Allowed: use POST for MCP." },
        id: null,
      });
  }
}
