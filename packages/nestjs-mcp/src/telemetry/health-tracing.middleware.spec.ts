import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Request, Response } from "express";
import { healthTracingMiddleware } from "./health-tracing.middleware.js";

const exporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.disable();
  trace.setGlobalTracerProvider(provider);
});

afterAll(() => {
  trace.disable();
  contextManager.disable();
  context.disable();
});

beforeEach(() => exporter.reset());

function req(url: string): Request {
  return { url } as Request;
}

describe("healthTracingMiddleware", () => {
  it("suppresses spans started while handling /health", () => {
    healthTracingMiddleware(req("/health"), {} as Response, () => {
      trace.getTracer("t").startSpan("neo4j.ping").end();
    });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("suppresses spans started while handling /health/ready", () => {
    healthTracingMiddleware(req("/health/ready?x=1"), {} as Response, () => {
      trace.getTracer("t").startSpan("neo4j.ping").end();
    });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("leaves other routes untouched", () => {
    healthTracingMiddleware(req("/read/mcp"), {} as Response, () => {
      trace.getTracer("t").startSpan("some.op").end();
    });
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });
});
