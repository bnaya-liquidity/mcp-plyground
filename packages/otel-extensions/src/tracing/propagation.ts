import { context, propagation, trace, ROOT_CONTEXT, type Link } from "@opentelemetry/api";

/**
 * The header map a message carries trace context in. Deliberately narrow: the
 * default OTel text-map getter reads `string | string[]` values only, so a
 * transport whose headers are `Buffer`s (kafkajs) must decode them to strings
 * before calling — passing raw buffers extracts nothing, silently.
 */
export type MessageHeaders = Record<string, string | string[] | undefined>;

/**
 * Reads the producer's span context out of a message carrier and returns it as
 * a {@link Link}, or `undefined` when the carrier holds no valid context
 * (an uninstrumented producer, a message predating instrumentation, or a
 * sampled-out trace).
 *
 * Extraction is rooted at {@link ROOT_CONTEXT} on purpose. Extracting into the
 * *active* context would fall back to whatever span the poll loop is currently
 * in, so a message with no trace context would yield a link to the consumer's
 * own poller — a self-referential edge that reads as a working link and is not
 * one.
 *
 * Extraction goes through the global propagator, which `initTelemetry` installs
 * via `tracerProvider.register()` (W3C tracecontext + baggage by default,
 * overridable with `OTEL_PROPAGATORS`). Before the SDK is initialized — or under
 * `OTEL_SDK_DISABLED=true` — the global propagator is a no-op, so this returns
 * `undefined` rather than throwing.
 */
export function extractLink(carrier: MessageHeaders): Link | undefined {
  const upstream = propagation.extract(ROOT_CONTEXT, carrier);
  const spanContext = trace.getSpan(upstream)?.spanContext();
  if (!spanContext || !trace.isSpanContextValid(spanContext)) return undefined;
  return { context: spanContext };
}

/**
 * Writes the currently active span's context into a message carrier, so the
 * consumer can {@link extractLink} it later. Use this only for transports no
 * instrumentation covers — `kafkajs`, `aws-sdk` and friends inject on their own,
 * and injecting twice is not additive, it is a silent overwrite.
 *
 * For an **outbox table**, the injected `traceparent` must be written in the
 * same transaction as the row it describes. Context written outside that
 * transaction goes missing in exactly the failure cases you need it for.
 */
export function injectContext(carrier: MessageHeaders): void {
  propagation.inject(context.active(), carrier);
}
