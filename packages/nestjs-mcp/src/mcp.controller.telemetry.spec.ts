import "reflect-metadata";
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { Logger } from "@nestjs/common";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { McpController } from "./mcp.controller.js";
import { McpRegistryService } from "./mcp-registry.service.js";

const exporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  // A real context manager is required for `trace.getActiveSpan()` to see the
  // span `startActiveSpan` opens below — the default `NoopContextManager`
  // never tracks an active context, so every read of the active span (and the
  // trace-correlation test in particular) would silently see `undefined`.
  context.setGlobalContextManager(contextManager.enable());
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.disable();
  trace.setGlobalTracerProvider(provider);
});

/** A controller wired to an empty registry, standing in for a real endpoint. */
function makeController(): McpController {
  const registry = { getTools: () => [] } as unknown as McpRegistryService;
  const controller = new McpController(registry, {
    route: "read/mcp",
    serverInfo: { name: "playground-graph-ops-read", version: "1.0.0" },
  });
  controller.onModuleInit();
  return controller;
}

/**
 * Runs the controller's telemetry step inside an active span, the way the HTTP
 * instrumentation's server span wraps it in production, and returns the
 * attributes that landed on that span.
 */
function recordTelemetry(controller: McpController, body: unknown): Record<string, unknown> {
  return trace
    .getTracer("test")
    .startActiveSpan("HTTP POST", (span) => {
      // `recordMcpTelemetry` is the seam extracted in Step 3.
      (controller as unknown as { recordMcpTelemetry: (b: unknown) => void })
        .recordMcpTelemetry(body);
      span.end();
      return { ...(span as unknown as { attributes: Record<string, unknown> }).attributes };
    });
}

describe("MCP request telemetry", () => {
  let debugSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    exporter.reset();
    debugSpy = jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
  });

  // `jest.spyOn` reuses the existing mock when `Logger.prototype.debug` is
  // already spied, so its call history survives across tests unless the spy
  // is torn down here — without this, an earlier test's DEBUG call leaks into
  // a later assertion that expects zero calls.
  afterEach(() => {
    debugSpy.mockRestore();
  });

  it("logs exactly one DEBUG record naming the client on initialize", () => {
    recordTelemetry(makeController(), {
      jsonrpc: "2.0",
      method: "initialize",
      params: { clientInfo: { name: "claude-code", version: "3.1.0" } },
      id: 1,
    });
    expect(debugSpy).toHaveBeenCalledTimes(1);
    const message = String(debugSpy.mock.calls[0]?.[0]);
    expect(message).toContain("initialize");
    expect(message).toContain("claude-code");
    expect(message).toContain("3.1.0");
    expect(message).toContain("playground-graph-ops-read");
  });

  it.each([
    { jsonrpc: "2.0", method: "tools/list", id: 1 },
    { jsonrpc: "2.0", method: "tools/call", params: { name: "add" }, id: 1 },
  ])("logs nothing for %p", (body) => {
    recordTelemetry(makeController(), body);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("enriches the active span for a tools/call", () => {
    const attributes = recordTelemetry(makeController(), {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "add" },
      id: 1,
    });
    expect(attributes["mcp.method"]).toBe("tools/call");
    expect(attributes["mcp.tool"]).toBe("add");
    // endpointLabel("playground-graph-ops-read") === "read"
    expect(attributes["mcp.endpoint"]).toBe("read");
  });

  it("sets no mcp.tool for a non-tool method", () => {
    const attributes = recordTelemetry(makeController(), { method: "tools/list" });
    expect(attributes["mcp.method"]).toBe("tools/list");
    expect(attributes["mcp.tool"]).toBeUndefined();
  });

  it("emits the DEBUG record inside the active span, so it can correlate", () => {
    const controller = makeController();
    let observed: string | undefined;
    debugSpy.mockImplementation(() => {
      observed = trace.getActiveSpan()?.spanContext().traceId;
      return undefined;
    });
    recordTelemetry(controller, {
      method: "initialize",
      params: { clientInfo: { name: "c", version: "1" } },
    });
    expect(observed).toMatch(/^[0-9a-f]{32}$/);
    expect(observed).not.toMatch(/^0+$/);
  });
});
