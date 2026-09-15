// libs/nestjs-mcp/src/mcp-server.factory.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { RegisteredTool } from "./mcp-registry.service.js";
import { isStructuredToolError } from "./mcp-tool-error.js";

/** Tracer name shared by every MCP server built on this framework. */
const TRACER_NAME = "@playground/nestjs-mcp";

export interface McpServerInfo {
  name: string;
  version: string;
}

/**
 * The MCP endpoint label, used as the `mcp.endpoint` span dimension so metrics
 * can be split by endpoint (e.g. read vs write). Derived as the last
 * `-`-delimited segment of the server name: `playground-graph-ops-read` → `read`,
 * `playground-graph-ops-write` → `write`. Falls back to the full name when unsegmented.
 */
export function endpointLabel(serverName: string): string {
  const segments = serverName.split("-");
  return segments[segments.length - 1] || serverName;
}

/**
 * Build a fresh SDK Server wired to the (already-discovered) tool list.
 *
 * Deliberately uses the low-level `Server` (deprecated in favor of `McpServer`
 * for the high-level API, but sanctioned for advanced use): we need a single
 * CallTool seam to instrument every tool with one span and one error envelope,
 * which `McpServer.registerTool` does not provide.
 */
export function buildMcpServer(
  serverInfo: McpServerInfo,
  tools: RegisteredTool[],
): Server {
  const server = new Server(serverInfo, { capabilities: { tools: {} } });
  const endpoint = endpointLabel(serverInfo.name);

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.jsonSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Error: Unknown tool: ${name}` }],
        isError: true,
      };
    }
    // Auto-instrument every tool call with one active span. This is the single
    // generic seam that traces all tools — no per-tool telemetry code required.
    return trace
      .getTracer(TRACER_NAME)
      .startActiveSpan(
        `tool.${name}`,
        { attributes: { "mcp.tool": name, "mcp.endpoint": endpoint } },
        async (span) => {
          try {
            const result = await tool.invoke(args ?? {});
            span.setStatus({ code: SpanStatusCode.OK });
            // `JSON.stringify(undefined)` returns `undefined` (not the string
            // "undefined"), which would make `text` undefined and fail the SDK's
            // CallToolResult content validation (a `text` item must carry a
            // string). Coerce void/undefined tool returns to a literal so the
            // content item stays well-formed.
            const text =
              result === undefined ? "undefined" : JSON.stringify(result, null, 2);
            return { content: [{ type: "text", text }] };
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            span.recordException(error);
            span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
            const text = isStructuredToolError(error)
              ? JSON.stringify({
                  code: error.code,
                  httpStatusHint: error.httpStatusHint,
                  message: error.message,
                  details: error.details,
                })
              : JSON.stringify({
                  code: "INTERNAL_ERROR",
                  httpStatusHint: 500,
                  message: error.message,
                });
            return { content: [{ type: "text", text }], isError: true };
          } finally {
            span.end();
          }
        },
      );
  });

  return server;
}
