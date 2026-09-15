import { diag, DiagLogLevel, type DiagLogger } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter as GrpcLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPLogExporter as HttpLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter as GrpcTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as HttpTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import pino, { type Logger } from "pino";
import { buildPinoLoggerOptions, otelLogsEnabled } from "../logging/pino-otel.js";
import { throttleWithPino } from "../logging/throttle-pino.js";
import { throttle } from "../logging/throttle.js";
import { serviceInstanceId } from "../tracing/dedicated-resource.js";
import {
  buildHttpInstrumentations,
  type HttpInstrumentationOptions,
} from "./http-instrumentation.js";
import { resolveOtlpProtocol } from "./otlp-protocol.js";

export type TelemetryShutdown = () => Promise<void>;

/**
 * The slice of a tracer/logger provider that shutdown needs. Both
 * `NodeTracerProvider` and `LoggerProvider` satisfy this structurally, so no
 * cast is needed at the call site.
 */
export interface FlushableProvider {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Builds the shutdown handle: force-flush EVERY provider, then shut them all
 * down.
 *
 * Why flush before shutdown, when `shutdown()` already flushes its own
 * processor: with more than one provider, `shutdown()`-only teardown runs each
 * provider's flush and its exporter teardown interleaved. A provider that
 * finishes first can tear its exporter down while another is still exporting
 * over the same connection, and records still in a batch queue are lost. K8s
 * makes this concrete — SIGTERM starts a grace period, and whatever has not
 * reached the collector when it expires is gone. Draining every buffer first,
 * and only then releasing exporters, removes that ordering hazard.
 *
 * `allSettled` on both phases is deliberate: one provider failing to flush must
 * not skip the other's shutdown, or a failing exporter would leak the process's
 * open handles and hang the pod past its grace period.
 *
 * The handle is idempotent — repeated calls return the same promise, so a
 * SIGTERM racing an explicit shutdown call flushes once.
 */
export function makeShutdown(providers: readonly FlushableProvider[]): TelemetryShutdown {
  let settled: Promise<void> | null = null;
  return () => {
    settled ??= Promise.allSettled(providers.map((provider) => provider.forceFlush()))
      .then(() => Promise.allSettled(providers.map((provider) => provider.shutdown())))
      .then(() => undefined);
    return settled;
  };
}

const NOOP_SHUTDOWN: TelemetryShutdown = () => Promise.resolve();

/**
 * Builds the trace exporter for the resolved transport. Both variants read the
 * standard OTLP endpoint env vars themselves — no endpoint is hand-passed.
 * Exported for unit tests; not part of the package's public API.
 */
export function makeTraceExporter(): GrpcTraceExporter | HttpTraceExporter {
  return resolveOtlpProtocol("traces") === "grpc"
    ? new GrpcTraceExporter()
    : new HttpTraceExporter();
}

/** Builds the logs exporter for the resolved transport (see {@link makeTraceExporter}). */
export function makeLogExporter(): GrpcLogExporter | HttpLogExporter {
  return resolveOtlpProtocol("logs") === "grpc"
    ? new GrpcLogExporter()
    : new HttpLogExporter();
}

/**
 * Singleton handle. `initTelemetry` may be called more than once per process
 * (e.g. once per feature module in a host app), but the OTel SDK must be set
 * up exactly once. We cache the shutdown function and return it on every
 * later call.
 */
let _shutdown: TelemetryShutdown | null = null;

/**
 * Threshold/window tuned for a steady low-frequency repeat, not just a burst:
 * a dead collector fires one export failure per k8s liveness/readiness probe
 * (default `periodSeconds: 10`), i.e. one hit per ~10s. The library default
 * (5 hits / 10s) never trips on that cadence — by the time hit 5 lands, the
 * rolling window has long since reset. 3 hits / 40s trips within ~20s of a
 * 10s-cadence repeat while still ignoring one-off blips.
 */
const CONNECTIVITY_THROTTLE_CONFIG /* :ThrottleConfig */ = {
  threshold: 3,
  windowMs: 40_000,
  flushIntervalMs: 120_000,
  flushCount: 200,
  quietMs: 300_000,
} as const;

/**
 * Builds an OTel {@link DiagLogger} backed by a pino logger. The `error` and
 * `debug` arms — the ones that storm on a flapping collector, including a
 * steady drip from periodic health-check spans — are wrapped by the throttle
 * (see {@link CONNECTIVITY_THROTTLE_CONFIG}) so repeats collapse into a
 * periodic WARN aggregate; `warn`/`info`/`verbose` pass straight through.
 * Every line is a structured pino record (`logger: "otel"`, plus
 * `level`/`status`), so DataDog can filter it by status. Exported for unit
 * tests.
 */
export function createDiagLogger(logger: Logger): DiagLogger {
  const throttledError = throttle(throttleWithPino(logger, "error"), {
    level: "error",
    ...CONNECTIVITY_THROTTLE_CONFIG,
  });
  const throttledDebug = throttle(throttleWithPino(logger, "debug"), {
    level: "debug",
    ...CONNECTIVITY_THROTTLE_CONFIG,
  });
  const join = (a: unknown[]): string => a.map(String).join(" ");
  return {
    error: (...a: unknown[]) => throttledError(join(a)),
    warn: (...a: unknown[]) => logger.warn(join(a)),
    info: (...a: unknown[]) => logger.info(join(a)),
    debug: (...a: unknown[]) => throttledDebug(join(a)),
    verbose: (...a: unknown[]) => logger.trace(join(a)),
  };
}

/**
 * Installs {@link createDiagLogger} as the global OTel diag logger. The pino
 * logger writes structured JSON to **stdout only** (not the OTLP arm): diag
 * output is mostly OTLP-export-failure noise, and routing it back through the
 * OTLP exporter would feed the failing export a loop. stdout still reaches
 * DataDog, which is the intended destination for these lines.
 *
 * `level` gates verbosity, not whether the (always-throttled) error/debug
 * circuit breaker is installed: callers should pass `DiagLogLevel.ERROR` by
 * default so export-failure errors are always caught and rate-limited, and
 * escalate via {@link resolveDiagLogLevel} (`LOG_LEVEL`) only when more
 * verbose OTel internals are wanted.
 */
function enableDiagLogger(level: DiagLogLevel): void {
  const logger = pino(buildPinoLoggerOptions()).child({ logger: "otel" });
  diag.setLogger(createDiagLogger(logger), level);
}

const LOG_LEVELS: Record<string, DiagLogLevel> = {
  none: DiagLogLevel.NONE,
  error: DiagLogLevel.ERROR,
  warn: DiagLogLevel.WARN,
  info: DiagLogLevel.INFO,
  debug: DiagLogLevel.DEBUG,
  verbose: DiagLogLevel.VERBOSE,
  all: DiagLogLevel.ALL,
};

/**
 * Resolves `LOG_LEVEL` to a {@link DiagLogLevel}, defaulting to `ERROR`
 * (per the class doc on {@link initTelemetry}) for unset/unrecognized values.
 */
function resolveDiagLogLevel(): DiagLogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  return (raw !== undefined ? LOG_LEVELS[raw] : undefined) ?? DiagLogLevel.WARN;
}

/**
 * The resource attributes every provider in this process is stamped with.
 *
 * Exported and pure so it is testable without registering global providers:
 * `initTelemetry` registers into `@opentelemetry/api` globals, which persist
 * across `jest.resetModules()`, so a test asserting through
 * `trace.getTracerProvider()` reads the FIRST registration and silently passes
 * on stale data.
 *
 * `service.version` is optional and OMITTED when unset — never defaulted to
 * `"unknown"`, which reads as a real version in a backend query and makes "did
 * this start with the deploy?" unanswerable for every service that forgot to
 * set it. Absent is honest; a placeholder is not.
 *
 * `deployment.environment`, `k8s.pod.name` and `k8s.namespace.name` are
 * deliberately NOT set here: they are enriched at the collector, which knows
 * them from the pod it runs beside and cannot get them wrong. Do not add them
 * app-side — two sources for one attribute is how they diverge.
 */
export function buildResourceAttributes(serviceName: string): Record<string, string> {
  const serviceVersion = process.env.OTEL_SERVICE_VERSION ?? process.env.SERVICE_VERSION;
  return {
    "service.name": process.env.OTEL_SERVICE_NAME ?? serviceName,
    "service.instance.id": serviceInstanceId(),
    ...(serviceVersion !== undefined && serviceVersion !== ""
      ? { "service.version": serviceVersion }
      : {}),
  };
}

/**
 * Initializes traces + logs against an OTLP/gRPC collector and returns a
 * shutdown function that flushes the providers.
 *
 * - **Idempotent:** repeated calls return the same shutdown handle.
 * - **Standard env var:** the OTLP exporters read `OTEL_EXPORTER_OTLP_ENDPOINT`
 *   (and the signal-specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` /
 *   `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`) per the OTLP spec. No endpoint is
 *   hand-passed; the transport (gRPC vs HTTP) is resolved per signal by
 *   {@link resolveOtlpProtocol} — explicit protocol env first, then inferred
 *   from the endpoint's port (4317→grpc, 4318→http), defaulting to OTLP/HTTP
 *   when nothing is set, i.e. `http://localhost:4318`.
 * - **Disable switch:** `OTEL_SDK_DISABLED=true` makes this a no-op (used by
 *   tests).
 * - Service name precedence: `OTEL_SERVICE_NAME` env → `serviceName` argument.
 * - **Diag logger:** installed via {@link resolveDiagLogLevel}, which maps
 *   `LOG_LEVEL` (none/error/warn/info/debug/verbose/all) to a
 *   {@link DiagLogLevel}, defaulting to `ERROR` when unset or unrecognized —
 *   so export failures are always caught by the throttle circuit breaker
 *   (see {@link createDiagLogger}) even without `LOG_LEVEL` set.
 * - **HTTP instrumentation:** on by default — one server span per incoming
 *   request plus client spans for outgoing HTTP. Health-probe paths are
 *   excluded. Disable with `{ httpInstrumentation: false }`. **Must be called
 *   before `http`/`express` load**; see the note at the registration site.
 */
export function initTelemetry(
  serviceName: string,
  options: HttpInstrumentationOptions = {},
): TelemetryShutdown {
  if (_shutdown) return _shutdown;

  enableDiagLogger(resolveDiagLogLevel());

  if (process.env.OTEL_SDK_DISABLED === "true") {
    _shutdown = NOOP_SHUTDOWN;
    return _shutdown;
  }

  const resource = resourceFromAttributes(buildResourceAttributes(serviceName));

  const tracerProvider = new NodeTracerProvider({
    resource,
    // SimpleSpanProcessor is a DELIBERATE, LIBRARY-OWNED choice. Do not
    // "upgrade" it to BatchSpanProcessor, and do not expose the processor as a
    // consumer option — one export shape for every service is the point, so
    // that reasoning about trace delivery does not have to be repeated per
    // repo.
    //
    // Reviewed 2026-08-31 and kept, with the trade-off understood:
    //   - Kept for crash fidelity. Batch loses up to its scheduled delay of
    //     spans on SIGKILL, which is exactly the request you most want a trace
    //     for. Simple has already exported them.
    //   - Kept for loud failure. Batch drops silently once its queue fills;
    //     Simple fails per span, visibly, through `diag`.
    //   - The cost is one export per span end on the app→collector hop. That is
    //     accepted: the collector runs as a node-local DaemonSet, so the hop is
    //     cheap, and IT is responsible for batching onward to the backend.
    //
    // LOAD-BEARING CONSEQUENCE: because this exports on every span end, the
    // OTLP-endpoint exclusion in `buildHttpInstrumentations` is what stops the
    // exporter's own HTTP request from producing a span whose end triggers
    // another export, without bound. Keeping Simple means that exclusion is not
    // optional. See the comment at its definition.
    spanProcessors: [new SimpleSpanProcessor(makeTraceExporter())],
  });
  tracerProvider.register();

  // Registered INSIDE the `_shutdown` idempotency guard above, so repeated
  // initTelemetry calls patch once.
  //
  // LOAD ORDER IS LOAD-BEARING. Instrumentation patches modules as they are
  // loaded. Calling this after `http`/`express` are already in memory does not
  // throw and does not warn — it simply produces no spans, which looks exactly
  // like a misconfigured OTLP endpoint. Call initTelemetry from the FIRST
  // import of the process entrypoint, never from a DI factory.
  registerInstrumentations({
    instrumentations: buildHttpInstrumentations(options),
    tracerProvider,
  });

  // The OTLP log path is on by default but can be turned off (e.g. when a
  // filelog DaemonSet tails stdout instead). When off, no LoggerProvider is
  // registered — pino still writes structured JSON to stdout.
  // BatchLogRecordProcessor is the production-correct choice: it buffers and
  // retries, and flushes on shutdown via the handle below (K8s sends SIGTERM
  // with a grace period before SIGKILL).
  const loggerProvider = otelLogsEnabled()
    ? new LoggerProvider({
        resource,
        processors: [new BatchLogRecordProcessor({ exporter: makeLogExporter() })],
      })
    : null;
  if (loggerProvider) logs.setGlobalLoggerProvider(loggerProvider);

  _shutdown = makeShutdown([tracerProvider, ...(loggerProvider ? [loggerProvider] : [])]);
  return _shutdown;
}
