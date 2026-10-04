import type { ServerResponse } from "node:http";
import { trace } from "@opentelemetry/api";
import type { CallToolResult, JSONRPCResultResponse } from "@modelcontextprotocol/sdk/types.js";
import { getMcpRequestContext, type McpRequestContext } from "./mcp-request-context.js";

/** Span event recorded on the active span when a response is written directly. */
export const MCP_RESPONSE_EMITTED_EVENT = "mcp.response.emitted";

/** Upper bound on waiting for the transport to flush the SSE headers. */
const HEADERS_TIMEOUT_MS = 5_000;

/**
 * Writes the `tools/call` result straight to the raw HTTP response, bypassing
 * the transport, and records an `mcp.response.emitted` span event on the
 * active span. The tool that owns the call must return `DEFERRED_RESPONSE`,
 * or the SDK would send a second response for the same id.
 *
 * The transport has already opened an SSE stream on `res` for this POST, so
 * the result goes out as one SSE `message` event — plain text would not parse
 * on the client. The SDK hands that stream to `res` through
 * `@hono/node-server`, which buffers the first chunks before calling
 * `writeHead`; writing earlier would make hono's own `writeHead` throw
 * `ERR_HTTP_HEADERS_SENT`. So this waits for the headers to be flushed first.
 *
 * Only the first caller per request writes; later callers get `false`. The
 * claim is checked and set synchronously (no `await` in between), so racing
 * jobs cannot both pass. Also returns `false` if the client is already gone.
 *
 * `ctx` defaults to the current request context. Pass a context captured
 * earlier when calling from code that may run outside it.
 */
export async function writeMcpResponse(
  result: CallToolResult,
  ctx: McpRequestContext | undefined = getMcpRequestContext(),
): Promise<boolean> {
  const res = ctx?.res;
  const requestId = ctx?.requestId;
  if (!ctx || !res || requestId === undefined) {
    throw new Error(
      "writeMcpResponse requires an MCP request context with res and request id " +
        "(is McpRequestContextMiddleware applied to this route?)",
    );
  }
  if (ctx.responseWritten) return false;
  ctx.responseWritten = true;

  await waitForHeaders(res);
  if (res.writableEnded || res.destroyed) return false;

  const message: JSONRPCResultResponse = { jsonrpc: "2.0", id: requestId, result };
  const frame = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
  res.end(frame);

  trace.getActiveSpan()?.addEvent(MCP_RESPONSE_EMITTED_EVENT, {
    "mcp.request_id": String(requestId),
    "mcp.response.mode": "direct-write",
    "mcp.response.bytes": Buffer.byteLength(frame),
  });
  return true;
}

async function waitForHeaders(res: ServerResponse): Promise<void> {
  const deadline = Date.now() + HEADERS_TIMEOUT_MS;
  while (!res.headersSent && !res.writableEnded && !res.destroyed) {
    if (Date.now() > deadline) {
      throw new Error(`MCP response headers not sent within ${HEADERS_TIMEOUT_MS} ms`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
