import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { withSuppressedTracing } from "./suppress.js";

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

describe("withSuppressedTracing", () => {
  it("returns the function's result", () => {
    const result = withSuppressedTracing(() => 42);
    expect(result).toBe(42);
  });

  it("prevents spans started inside fn from being exported", () => {
    withSuppressedTracing(() => {
      trace.getTracer("test-tracer").startSpan("should-not-export").end();
    });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("suppresses spans started by an async continuation of fn", async () => {
    await withSuppressedTracing(async () => {
      await Promise.resolve();
      trace.getTracer("test-tracer").startSpan("should-not-export-either").end();
    });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("does not affect spans started outside the suppressed callback", () => {
    trace.getTracer("test-tracer").startSpan("should-export").end();
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });
});
