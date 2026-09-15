import { context, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import {
  createDedicatedResourceTracerProvider,
  withDependencySpan,
  serviceInstanceId,
} from "./dedicated-resource.js";

const dependencyExporter = new InMemorySpanExporter();
const callerExporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  const callerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(callerExporter)],
  });
  trace.disable();
  trace.setGlobalTracerProvider(callerProvider);
});

afterAll(() => {
  trace.disable();
  contextManager.disable();
  context.disable();
});

beforeEach(() => {
  dependencyExporter.reset();
  callerExporter.reset();
});

function buildDependencyTracer() {
  const provider = createDedicatedResourceTracerProvider("widgets", {
    spanProcessors: [new SimpleSpanProcessor(dependencyExporter)],
  });
  return provider.getTracer("test");
}

describe("createDedicatedResourceTracerProvider + withDependencySpan", () => {
  it("emits the span under the given service.name resource (not the caller's)", async () => {
    const tracer = buildDependencyTracer();

    await withDependencySpan(tracer, { name: "widgets.fetch" }, async () => 42);

    const spans: ReadableSpan[] = dependencyExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.resource.attributes["service.name"]).toBe("widgets");
    expect(callerExporter.getFinishedSpans()).toHaveLength(0);
  });

  it("emits an OK CLIENT span (default kind) carrying the given name and attributes", async () => {
    const tracer = buildDependencyTracer();

    const result = await withDependencySpan(
      tracer,
      { name: "widgets.fetch", attributes: { "widgets.id": "abc" } },
      async () => 42,
    );

    expect(result).toBe(42);
    const span = dependencyExporter.getFinishedSpans()[0]!;
    expect(span.name).toBe("widgets.fetch");
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes["widgets.id"]).toBe("abc");
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it("records the exception, sets ERROR status, and rethrows when fn throws", async () => {
    const tracer = buildDependencyTracer();

    await expect(
      withDependencySpan(tracer, { name: "widgets.fetch" }, async () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow("kaboom");

    const span = dependencyExporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("nests the dependency span under the active caller span (same trace, parented)", async () => {
    const tracer = buildDependencyTracer();
    const parent = trace.getTracer("caller").startSpan("tool.execute");
    const ctx = trace.setSpan(context.active(), parent);

    await context.with(ctx, () =>
      withDependencySpan(tracer, { name: "widgets.fetch" }, async () => 1),
    );
    parent.end();

    const depSpan = dependencyExporter.getFinishedSpans()[0]!;
    expect(depSpan.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(depSpan.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });
});

describe("serviceInstanceId", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('defaults to "default" when OTEL_SERVICE_INSTANCE_ID is unset', () => {
    delete process.env.OTEL_SERVICE_INSTANCE_ID;
    expect(serviceInstanceId()).toBe("default");
  });

  it("reads OTEL_SERVICE_INSTANCE_ID when set", () => {
    process.env.OTEL_SERVICE_INSTANCE_ID = "pod-42";
    expect(serviceInstanceId()).toBe("pod-42");
  });
});
