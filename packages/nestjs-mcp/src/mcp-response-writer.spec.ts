import { createServer, type Server, type ServerResponse } from "node:http";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MCP_RESPONSE_EMITTED_EVENT, writeMcpResponse } from "./mcp-response-writer.js";
import type { McpRequestContext } from "./mcp-request-context.js";

const exporter = new InMemorySpanExporter();
const result: CallToolResult = { content: [{ type: "text", text: "hello" }] };

beforeAll(() => {
  trace.disable();
  context.disable();
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});

beforeEach(() => exporter.reset());

/**
 * Serves one request with `handler`, which receives the raw response and
 * decides when to flush headers — the same position hono is in when the SDK
 * hands it the SSE stream.
 */
async function serveOnce(
  handler: (res: ServerResponse) => Promise<void>,
): Promise<{ status: number; text: string }> {
  const server: Server = createServer((_req, res) => void handler(res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no TCP address");
    const response = await fetch(`http://127.0.0.1:${address.port}/`, { method: "POST" });
    return { status: response.status, text: await response.text() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function flushHeadersLater(res: ServerResponse): void {
  setTimeout(() => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
  }, 20);
}

describe("writeMcpResponse", () => {
  it("waits for the headers, writes one SSE frame, and records a span event", async () => {
    let written: boolean | undefined;
    const { status, text } = await serveOnce(async (res) => {
      const ctx: McpRequestContext = { headers: {}, res, requestId: 7 };
      flushHeadersLater(res);
      await trace.getTracer("test").startActiveSpan("job", async (span) => {
        written = await writeMcpResponse(result, ctx);
        span.end();
      });
    });

    expect(status).toBe(200);
    expect(written).toBe(true);
    expect(text).toBe(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 7, result })}\n\n`,
    );

    const [span] = exporter.getFinishedSpans();
    const event = span!.events.find((e) => e.name === MCP_RESPONSE_EMITTED_EVENT);
    expect(event?.attributes).toEqual({
      "mcp.request_id": "7",
      "mcp.response.mode": "direct-write",
      "mcp.response.bytes": Buffer.byteLength(text),
    });
  });

  it("writes only once per request; later callers get false", async () => {
    const outcomes: boolean[] = [];
    const { text } = await serveOnce(async (res) => {
      const ctx: McpRequestContext = { headers: {}, res, requestId: "a" };
      flushHeadersLater(res);
      outcomes.push(
        ...(await Promise.all([writeMcpResponse(result, ctx), writeMcpResponse(result, ctx)])),
      );
    });

    expect(outcomes).toEqual([true, false]);
    expect(text.match(/event: message/g)).toHaveLength(1);
  });

  it("throws when there is no request context", async () => {
    await expect(writeMcpResponse(result, undefined)).rejects.toThrow(
      /requires an MCP request context/,
    );
  });

  it("throws when the context has no request id yet", async () => {
    await serveOnce(async (res) => {
      await expect(writeMcpResponse(result, { headers: {}, res })).rejects.toThrow(
        /requires an MCP request context/,
      );
      res.end();
    });
  });
});
