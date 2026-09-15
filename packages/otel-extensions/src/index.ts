export {
  createSpanHelpers,
  type ConsumerSpanOptions,
  type SpanAttributes,
  type SpanHelpers,
} from "./tracing/span.js";
export { extractLink, injectContext, type MessageHeaders } from "./tracing/propagation.js";
export { withSuppressedTracing } from "./tracing/suppress.js";
export {
  createDedicatedResourceTracerProvider,
  withDependencySpan,
  serviceInstanceId,
  type DedicatedResourceOptions,
  type DependencySpanOptions,
} from "./tracing/dedicated-resource.js";
export {
  OtelPinoStream,
  traceMixin,
  pinoLevelToSeverity,
  pinoLabelToSeverity,
  otelLogsEnabled,
  shouldPrettyPrint,
  buildPinoLoggerOptions,
  buildPinoDestination,
  type TraceFields,
  type PinoLoggerOptions,
  type PinoDestination,
} from "./logging/pino-otel.js";
export {
  throttle,
  defaultNormalize,
  type ThrottleConfig,
  type ThrottleEmit,
  type ThrottleNoticeAttrs,
} from "./logging/throttle.js";
export { throttleWithPino, type PinoThrottleLevel } from "./logging/throttle-pino.js";
export {
  initTelemetry,
  buildResourceAttributes,
  type TelemetryShutdown,
} from "./telemetry/sdk.js";
export { resolveOtlpProtocol, type OtlpProtocol } from "./telemetry/otlp-protocol.js";
export {
  buildHttpInstrumentations,
  shouldIgnoreIncomingRequest,
  DEFAULT_IGNORE_INCOMING_PATHS,
  type HttpInstrumentationOptions,
} from "./telemetry/http-instrumentation.js";
