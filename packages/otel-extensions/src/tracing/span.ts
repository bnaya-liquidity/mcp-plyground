import { trace, SpanKind, SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";
import {
  ATTR_MESSAGING_BATCH_MESSAGE_COUNT,
  ATTR_MESSAGING_DESTINATION_NAME,
  ATTR_MESSAGING_OPERATION_NAME,
  ATTR_MESSAGING_SYSTEM,
} from "@opentelemetry/semantic-conventions/incubating";
import { extractLink, type MessageHeaders } from "./propagation.js";

export type SpanAttributes = Record<string, string | number | boolean>;

export interface ConsumerSpanOptions {
  /**
   * The queue or topic this message came off. Becomes both
   * `messaging.destination.name` and the second half of the span name.
   */
  destination: string;
  /**
   * The message's headers — or one entry per message for a batch, which
   * produces ONE span carrying one link per message (see
   * {@link SpanHelpers.withConsumerSpan}).
   */
  headers: MessageHeaders | readonly MessageHeaders[];
  /** `messaging.system`, e.g. `"aws_sqs"` | `"kafka"`. Omitted if unset. */
  system?: string;
  /** semconv operation name; defaults to `"process"`. */
  operation?: string;
  /** Extra attributes merged over the semconv ones. */
  attributes?: SpanAttributes;
}

export interface SpanHelpers {
  withSpan: <T>(name: string, fn: () => T, attributes?: SpanAttributes) => T;
  withAsyncSpan: <T>(
    name: string,
    fn: () => Promise<T>,
    attributes?: SpanAttributes,
  ) => Promise<T>;
  withConsumerSpan: <T>(options: ConsumerSpanOptions, fn: () => Promise<T>) => Promise<T>;
}

/**
 * Marks `span` failed from a thrown value and rethrows it as an `Error`.
 * Shared by all three helpers so the recorded shape (exception event + ERROR
 * status carrying the message) cannot drift between them.
 */
function fail(span: Span, err: unknown): never {
  const error = err instanceof Error ? err : new Error(String(err));
  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  throw error;
}

/**
 * Builds the `withSpan` / `withAsyncSpan` / `withConsumerSpan` trio bound to a
 * fixed tracer name (OTel's "instrumentation scope"). Each library/service
 * creates one bound instance at module load and reuses it, so call sites never
 * repeat the tracer name.
 *
 * The tracer is resolved fresh on every call via `trace.getTracer(tracerName)`
 * (not cached at construction). This ensures the current OTel provider is always
 * used, avoiding the risk that a cached proxy might pin to a noop tracer if the
 * real provider is registered later (e.g. by `initTelemetry`, which may run after
 * this module is imported).
 *
 * All three share the same success/failure handling: OK status on return,
 * exception recorded + ERROR status + rethrow on throw, span always ended.
 * They differ only in what parents the span — the active context for the first
 * two, the message headers for {@link SpanHelpers.withConsumerSpan}.
 */
export function createSpanHelpers(tracerName: string): SpanHelpers {
  const getTracer = (): Tracer => trace.getTracer(tracerName);

  function withSpan<T>(name: string, fn: () => T, attributes?: SpanAttributes): T {
    return getTracer().startActiveSpan(name, { attributes }, (span) => {
      try {
        const result = fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        return fail(span, err);
      } finally {
        span.end();
      }
    });
  }

  async function withAsyncSpan<T>(
    name: string,
    fn: () => Promise<T>,
    attributes?: SpanAttributes,
  ): Promise<T> {
    return getTracer().startActiveSpan(name, { attributes }, async (span) => {
      try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        return fail(span, err);
      } finally {
        span.end();
      }
    });
  }

  /**
   * Opens the span for processing work pulled off a queue or topic. Auto-
   * instrumentation cannot produce this span — it has no way to know a poll
   * returned work, nor which producer that work came from — so this is the one
   * span type a message consumer must always write by hand.
   *
   * **It is a ROOT span carrying a LINK to the producer, never a child of it.**
   * That is the org's decided trace shape for every async hop, and the reasons
   * are load-bearing rather than stylistic:
   *
   * - A parent span cannot end until its children do. Parenting a consumer to
   *   its producer turns a four-hour queue wait into a four-hour root span, and
   *   every latency percentile the collector's `span_metrics` connector derives
   *   from it is then garbage.
   * - Fan-out has no single parent — one publish consumed five times, or a
   *   batch of 100 handled in one poll. Links are many-to-many; parenthood is
   *   not.
   * - The producer's span was exported and made immutable long before the
   *   consumer started. Retroactive parenting is not a thing.
   *
   * `root: true` makes this hold even inside an active poll span. A link says
   * "this was caused by that", which is the true relationship, and leaves the
   * consumer its own trace with its own honest duration.
   *
   * **The exception worth naming:** synchronous request/reply over a queue,
   * where the caller blocks on the response, genuinely is parent-child. Do not
   * use this helper for that shape.
   *
   * A **batch** passes an array of headers and gets ONE span with one link per
   * message plus `messaging.batch.message_count` — not one span per message.
   * Messages whose headers carry no valid context contribute no link (an
   * uninstrumented producer, or a sampled-out trace) but still count toward the
   * batch size, so the count always reports messages received.
   *
   * The span name is built as `"<operation> <destination>"` from the options
   * rather than taken as a free string: `span_metrics` keys on span name, so a
   * caller-supplied name is the one place a message id can leak in and turn
   * every message into its own metric series.
   */
  async function withConsumerSpan<T>(
    options: ConsumerSpanOptions,
    fn: () => Promise<T>,
  ): Promise<T> {
    const { destination, headers, system, operation = "process", attributes } = options;
    const carriers = Array.isArray(headers) ? headers : [headers as MessageHeaders];
    const links = carriers.map(extractLink).filter((link) => link !== undefined);

    return getTracer().startActiveSpan(
      `${operation} ${destination}`,
      {
        kind: SpanKind.CONSUMER,
        root: true,
        links,
        attributes: {
          [ATTR_MESSAGING_OPERATION_NAME]: operation,
          [ATTR_MESSAGING_DESTINATION_NAME]: destination,
          ...(system !== undefined ? { [ATTR_MESSAGING_SYSTEM]: system } : {}),
          ...(carriers.length > 1
            ? { [ATTR_MESSAGING_BATCH_MESSAGE_COUNT]: carriers.length }
            : {}),
          ...attributes,
        },
      },
      async (span) => {
        try {
          const result = await fn();
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err) {
          return fail(span, err);
        } finally {
          span.end();
        }
      },
    );
  }

  return { withSpan, withAsyncSpan, withConsumerSpan };
}
