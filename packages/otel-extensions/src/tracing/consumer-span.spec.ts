import { context, propagation, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createSpanHelpers } from "./span.js";
import { extractLink, injectContext, type MessageHeaders } from "./propagation.js";

const exporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.disable();
  trace.setGlobalTracerProvider(provider);
  // `initTelemetry` installs this via `tracerProvider.register()`; these tests
  // drive a bare BasicTracerProvider, so set it explicitly.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});

afterAll(() => {
  trace.disable();
  propagation.disable();
  contextManager.disable();
  context.disable();
});

beforeEach(() => exporter.reset());

/**
 * Produces the headers a real producer would attach: opens a span, injects the
 * active context into a carrier, ends the span. Returns the carrier plus the
 * producer's own ids so the consumer side can be asserted against them.
 */
function produce(): { headers: MessageHeaders; traceId: string; spanId: string } {
  const span = trace.getTracer("producer").startSpan("send my-queue", {
    kind: SpanKind.PRODUCER,
  });
  const headers: MessageHeaders = {};
  context.with(trace.setSpan(context.active(), span), () => injectContext(headers));
  span.end();
  const { traceId, spanId } = span.spanContext();
  return { headers, traceId, spanId };
}

describe("extractLink", () => {
  it("returns a link to the producer's span context", () => {
    const { headers, traceId, spanId } = produce();

    const link = extractLink(headers);

    expect(link?.context.traceId).toBe(traceId);
    expect(link?.context.spanId).toBe(spanId);
  });

  it("returns undefined for a carrier with no trace context", () => {
    expect(extractLink({})).toBeUndefined();
  });

  it("returns undefined rather than linking to an ambient poll span", () => {
    // Rooting the extract matters: extracting into the active context would
    // hand back a link to the consumer's OWN poller, which renders as a valid
    // link and means nothing.
    const pollSpan = trace.getTracer("poller").startSpan("poll my-queue");

    const link = context.with(trace.setSpan(context.active(), pollSpan), () => extractLink({}));
    pollSpan.end();

    expect(link).toBeUndefined();
  });
});

describe("withConsumerSpan", () => {
  const { withConsumerSpan, withAsyncSpan } = createSpanHelpers("test-tracer");

  it("names the span '<operation> <destination>' and links to the producer", async () => {
    const { headers, traceId, spanId } = produce();
    exporter.reset();

    const result = await withConsumerSpan(
      { destination: "my-queue", headers, system: "aws_sqs" },
      async () => "done",
    );

    expect(result).toBe("done");
    const span = exporter.getFinishedSpans()[0]!;
    expect(span.name).toBe("process my-queue");
    expect(span.kind).toBe(SpanKind.CONSUMER);
    expect(span.links).toHaveLength(1);
    expect(span.links[0]!.context.traceId).toBe(traceId);
    expect(span.links[0]!.context.spanId).toBe(spanId);
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it("is a ROOT span, not a child of the producer", async () => {
    // The whole point. Parent-child would keep the producer's span open until
    // the consumer finished — a 4-hour root span for a 4-hour queue wait, and
    // garbage latency in the span_metrics-derived RED metrics.
    const { headers, traceId } = produce();
    exporter.reset();

    await withConsumerSpan({ destination: "my-queue", headers }, async () => undefined);

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.spanContext().traceId).not.toBe(traceId);
  });

  it("is a ROOT span even inside an active poll span", async () => {
    const { headers } = produce();
    const pollSpan = trace.getTracer("poller").startSpan("poll my-queue");
    exporter.reset();

    await context.with(trace.setSpan(context.active(), pollSpan), () =>
      withConsumerSpan({ destination: "my-queue", headers }, async () => undefined),
    );
    pollSpan.end();

    const consumer = exporter.getFinishedSpans().find((s) => s.name === "process my-queue")!;
    expect(consumer.parentSpanContext).toBeUndefined();
    expect(consumer.spanContext().traceId).not.toBe(pollSpan.spanContext().traceId);
  });

  it("sets semconv messaging attributes", async () => {
    const { headers } = produce();
    exporter.reset();

    await withConsumerSpan(
      {
        destination: "my-queue",
        headers,
        system: "aws_sqs",
        attributes: { "app.tenant": "acme" },
      },
      async () => undefined,
    );

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.attributes["messaging.system"]).toBe("aws_sqs");
    expect(span.attributes["messaging.destination.name"]).toBe("my-queue");
    expect(span.attributes["messaging.operation.name"]).toBe("process");
    expect(span.attributes["app.tenant"]).toBe("acme");
  });

  it("honours a non-default operation in both the name and the attribute", async () => {
    await withConsumerSpan(
      { destination: "my-queue", headers: {}, operation: "settle" },
      async () => undefined,
    );

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.name).toBe("settle my-queue");
    expect(span.attributes["messaging.operation.name"]).toBe("settle");
  });

  it("takes one span per batch with one link per message", async () => {
    const a = produce();
    const b = produce();
    const c = produce();
    exporter.reset();

    await withConsumerSpan(
      { destination: "my-queue", headers: [a.headers, b.headers, c.headers] },
      async () => undefined,
    );

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.links.map((l) => l.context.spanId).sort()).toEqual(
      [a.spanId, b.spanId, c.spanId].sort(),
    );
    expect(spans[0]!.attributes["messaging.batch.message_count"]).toBe(3);
  });

  it("omits the batch count for a single message", async () => {
    const { headers } = produce();
    exporter.reset();

    await withConsumerSpan({ destination: "my-queue", headers }, async () => undefined);

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.attributes["messaging.batch.message_count"]).toBeUndefined();
  });

  it("drops unlinkable messages from a batch rather than emitting empty links", async () => {
    const { headers, spanId } = produce();
    exporter.reset();

    await withConsumerSpan(
      { destination: "my-queue", headers: [headers, {}, {}] },
      async () => undefined,
    );

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.links.map((l) => l.context.spanId)).toEqual([spanId]);
    // The count reports messages received, not links resolved — otherwise an
    // uninstrumented producer silently shrinks the batch size you observe.
    expect(span.attributes["messaging.batch.message_count"]).toBe(3);
  });

  it("emits no links at all when nothing in the carrier is valid", async () => {
    await withConsumerSpan({ destination: "my-queue", headers: {} }, async () => undefined);

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.links).toHaveLength(0);
  });

  it("makes the consumer span the active parent for work inside it", async () => {
    const { headers } = produce();
    exporter.reset();

    await withConsumerSpan({ destination: "my-queue", headers }, async () => {
      await withAsyncSpan("handle-payload", async () => undefined);
    });

    const [child, consumer] = exporter.getFinishedSpans();
    expect(child!.name).toBe("handle-payload");
    expect(child!.parentSpanContext?.spanId).toBe(consumer!.spanContext().spanId);
    expect(child!.spanContext().traceId).toBe(consumer!.spanContext().traceId);
  });

  it("records the exception, sets ERROR, and rethrows", async () => {
    const { headers } = produce();
    exporter.reset();

    await expect(
      withConsumerSpan({ destination: "my-queue", headers }, async () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow("kaboom");

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });
});
