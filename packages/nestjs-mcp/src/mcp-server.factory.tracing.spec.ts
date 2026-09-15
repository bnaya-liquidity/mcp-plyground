// libs/nestjs-mcp/src/mcp-server.factory.tracing.spec.ts
import "reflect-metadata";
import { z } from "zod";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer } from "./mcp-server.factory.js";
import type { RegisteredTool } from "./mcp-registry.service.js";

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  // Reset any previously-registered global so this exporter receives the spans.
  trace.disable();
  trace.setGlobalTracerProvider(provider);
});

beforeEach(() => exporter.reset());

function tool(name: string, fn: (a: unknown) => unknown): RegisteredTool {
  const schema = z.object({ x: z.number() });
  return {
    name,
    description: name,
    inputSchema: schema,
    jsonSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    invoke: async (a) => fn(a),
  };
}

async function callTool(
  server: ReturnType<typeof buildMcpServer>,
  name: string,
  args: unknown,
) {
  return (
    server as unknown as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    }
  )._requestHandlers.get(CallToolRequestSchema.shape.method.value)!(
    { method: "tools/call", params: { name, arguments: args } },
    {},
  );
}

describe("buildMcpServer auto-tracing", () => {
  it("emits one OK span named tool.<name> with the mcp.tool attribute per call", async () => {
    const server = buildMcpServer({ name: "t", version: "0.0.0" }, [
      tool("double", (a) => ({ y: (a as { x: number }).x * 2 })),
    ]);

    await callTool(server, "double", { x: 21 });

    const spans: ReadableSpan[] = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("tool.double");
    expect(spans[0].attributes["mcp.tool"]).toBe("double");
    expect(spans[0].status.code).toBe(SpanStatusCode.OK);
  });

  it("stamps mcp.endpoint from the last segment of serverInfo.name", async () => {
    const read = buildMcpServer({ name: "playground-graph-ops-read", version: "0.0.0" }, [
      tool("execute_cypher", () => ({})),
    ]);
    await callTool(read, "execute_cypher", { x: 1 });
    expect(exporter.getFinishedSpans()[0].attributes["mcp.endpoint"]).toBe("read");

    exporter.reset();

    const write = buildMcpServer({ name: "playground-graph-ops-write", version: "0.0.0" }, [
      tool("setup", () => ({})),
    ]);
    await callTool(write, "setup", { x: 1 });
    expect(exporter.getFinishedSpans()[0].attributes["mcp.endpoint"]).toBe("write");
  });

  it("records the exception and ERROR status when a tool throws, still returning isError", async () => {
    const server = buildMcpServer({ name: "t", version: "0.0.0" }, [
      tool("boom", () => {
        throw new Error("kaboom");
      }),
    ]);

    const result = await callTool(server, "boom", { x: 1 });

    expect((result as { isError?: boolean }).isError).toBe(true);
    const payload = JSON.parse(
      (result as { content: [{ text: string }] }).content[0].text,
    );
    expect(payload).toEqual({
      code: "INTERNAL_ERROR",
      httpStatusHint: 500,
      message: "kaboom",
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("tool.boom");
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0].events.some((e) => e.name === "exception")).toBe(true);
  });

  it("serializes a structured tool error (code/httpStatusHint/details) instead of a free-text message", async () => {
    class FakeStructuredError extends Error {
      code = "VALIDATION_ERROR";
      httpStatusHint = 422;
      details = { field: "name" };
      constructor() {
        super("bad input");
      }
    }
    const server = buildMcpServer({ name: "t", version: "0.0.0" }, [
      tool("explode", () => {
        throw new FakeStructuredError();
      }),
    ]);

    const result = await callTool(server, "explode", { x: 1 });

    expect((result as { isError?: boolean }).isError).toBe(true);
    const payload = JSON.parse(
      (result as { content: [{ text: string }] }).content[0].text,
    );
    expect(payload).toEqual({
      code: "VALIDATION_ERROR",
      httpStatusHint: 422,
      message: "bad input",
      details: { field: "name" },
    });
  });

  it("does not emit a span for an unknown tool", async () => {
    const server = buildMcpServer({ name: "t", version: "0.0.0" }, []);

    await callTool(server, "nope", { x: 1 });

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
