import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createSpanHelpers } from "./span.js";

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

describe("createSpanHelpers", () => {
  const { withSpan, withAsyncSpan } = createSpanHelpers("test-tracer");

  it("withSpan returns the function's result and marks the span OK", () => {
    const result = withSpan("do-thing", () => 42, { "attr.a": "x" });

    expect(result).toBe(42);
    const span = exporter.getFinishedSpans()[0]!;
    expect(span.name).toBe("do-thing");
    expect(span.attributes["attr.a"]).toBe("x");
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it("withSpan records the exception, sets ERROR, and rethrows", () => {
    expect(() =>
      withSpan("do-thing", () => {
        throw new Error("kaboom");
      }),
    ).toThrow("kaboom");

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("withAsyncSpan awaits the function's result and marks the span OK", async () => {
    const result = await withAsyncSpan("do-async-thing", async () => 7);

    expect(result).toBe(7);
    const span = exporter.getFinishedSpans()[0]!;
    expect(span.name).toBe("do-async-thing");
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it("withAsyncSpan records the exception, sets ERROR, and rethrows", async () => {
    await expect(
      withAsyncSpan("do-async-thing", async () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow("kaboom");

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });
});
