import { SpanKind, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { SpanAttributes } from "./span.js";

/**
 * Resolves the OTel `service.instance.id` resource attribute. Defaults to a
 * STABLE constant shared by every replica (cattle, not pets): aggregate
 * per-service metrics are usually what's wanted, not a per-pod time-series
 * that fans out with pod churn. Some backends (e.g. Aspire) require this
 * attribute to render metrics/traces for a resource at all, so it can't
 * simply be dropped. Set `OTEL_SERVICE_INSTANCE_ID` to opt into per-instance
 * granularity.
 */
export function serviceInstanceId(): string {
  // TODO: bnaya 2027-07-15 Get pod if exists
  return process.env.OTEL_SERVICE_INSTANCE_ID || "default";
}

export interface DedicatedResourceOptions {
  spanProcessors: SpanProcessor[];
  /** Overrides the resolved {@link serviceInstanceId} for this provider. */
  serviceInstanceId?: string;
}

/**
 * Builds a `NodeTracerProvider` whose resource is pinned to a given
 * `service.name`, distinct from the calling app's own service. Use this to
 * give a downstream dependency (a database driver, an external API client,
 * ...) its own identity in the tracing backend, while its spans still nest
 * inside the caller's trace — `startActiveSpan` reads the parent span from
 * the process-wide active context, which is independent of which provider
 * owns the resource.
 *
 * Deliberately does NOT call `.register()` — that would clobber the app's
 * global provider and context manager. Pair with {@link withDependencySpan}
 * using a `Tracer` obtained from this provider directly (e.g.
 * `provider.getTracer(name)`).
 */
export function createDedicatedResourceTracerProvider(
  serviceName: string,
  options: DedicatedResourceOptions,
): NodeTracerProvider {
  return new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": serviceName,
      "service.instance.id": options.serviceInstanceId ?? serviceInstanceId(),
    }),
    spanProcessors: options.spanProcessors,
  });
}

export interface DependencySpanOptions {
  /** Full span name, e.g. `"neo4j.query"`. */
  name: string;
  /** Defaults to `SpanKind.CLIENT` — the common case for a dependency call. */
  kind?: SpanKind;
  attributes?: SpanAttributes;
}

/**
 * Wraps a call to a dedicated-resource dependency in a span on the given
 * tracer. Same success/failure handling as `withSpan`/`withAsyncSpan`: OK
 * status on return, exception recorded + ERROR status + rethrow on throw,
 * span always ended.
 */
export async function withDependencySpan<T>(
  tracer: Tracer,
  options: DependencySpanOptions,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    options.name,
    { kind: options.kind ?? SpanKind.CLIENT, attributes: options.attributes },
    async (span) => {
      try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
