import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";

/**
 * Runs `fn` in a context where span creation is a no-op: any tracer's
 * `startSpan` (including one belonging to a wholly separate `TracerProvider`,
 * e.g. the dedicated Neo4j provider in `@playground/mcp-abstractions`) returns a
 * non-recording span, so nothing is exported. Standard OTel mechanism
 * (`@opentelemetry/core`'s `suppressTracing`), propagated via the active
 * context rather than per-tracer configuration — so callers deep in the async
 * chain (e.g. a Neo4j ping triggered by a health probe) are covered without
 * knowing anything about the caller's intent to suppress.
 */
export function withSuppressedTracing<T>(fn: () => T): T {
  return context.with(suppressTracing(context.active()), fn);
}
