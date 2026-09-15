import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import {
  logs,
  SeverityNumber,
  type Logger,
  type LogRecord,
} from "@opentelemetry/api-logs";
import pino from "pino";
import pretty from "pino-pretty";

/** pino bookkeeping keys that should not become OTel log attributes. */
const PINO_META_KEYS = new Set(["level", "time", "msg", "pid", "hostname"]);
/** Trace-correlation keys handled separately, never copied into attributes. */
const TRACE_KEYS = new Set(["trace_id", "span_id", "trace_flags"]);

/** Trace-correlation fields stamped onto every pino record by {@link traceMixin}. */
export interface TraceFields {
  trace_id?: string;
  span_id?: string;
  trace_flags?: number;
}

/**
 * pino `mixin` that stamps the active span's ids onto each log record. The
 * OTel appender reads these back (the stream write may run outside the active
 * context, so the SDK cannot capture it implicitly), and they also make the
 * stdout JSON correlatable for a future filelog agent.
 */
export function traceMixin(): TraceFields {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const { traceId, spanId, traceFlags } = span.spanContext();
  return { trace_id: traceId, span_id: spanId, trace_flags: traceFlags };
}

/**
 * A pino destination that forwards each serialized log line to the OTel Logs
 * API. Used as one arm of a `pino.multistream` built by
 * {@link buildPinoDestination} (the other arm is stdout).
 *
 * The OTel logger is resolved lazily on first write, after some SDK bootstrap
 * (e.g. `initTelemetry`) has registered the global `LoggerProvider`.
 *
 * `loggerName` becomes the OTel "instrumentation scope" name attached to every
 * emitted record — defaults to `"pino"`, a neutral generic name; pass the
 * consuming service/library's own name to identify its logs distinctly.
 */
export class OtelPinoStream {
  private logger: Logger | undefined;

  constructor(private readonly loggerName: string = "pino") {}

  write(line: string): void {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // never let a bad line crash the logging path
    }
    this.emit(rec);
  }

  private emit(rec: Record<string, unknown>): void {
    this.logger ??= logs.getLogger(this.loggerName);

    const attributes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rec)) {
      if (PINO_META_KEYS.has(key) || TRACE_KEYS.has(key)) continue;
      attributes[key] = value;
    }

    const body = typeof rec.msg === "string" ? rec.msg : undefined;

    const record: LogRecord = {
      timestamp: parseRecordTime(rec.time),
      severityNumber: parseRecordSeverity(rec.level),
      body,
      attributes: attributes as LogRecord["attributes"],
    };

    const traceId = rec.trace_id;
    const spanId = rec.span_id;
    if (typeof traceId === "string" && typeof spanId === "string") {
      record.context = trace.setSpanContext(ROOT_CONTEXT, {
        traceId,
        spanId,
        traceFlags: typeof rec.trace_flags === "number" ? rec.trace_flags : 1,
        isRemote: false,
      });
    }

    this.logger.emit(record);
  }
}

/**
 * Whether the in-process OTLP log path is active. On by default; disabled
 * when `OTEL_LOGS_EXPORTER=none` (a future filelog-DaemonSet world) or when
 * the whole SDK is off (`OTEL_SDK_DISABLED=true`, used by tests). stdout JSON
 * is emitted regardless.
 */
export function otelLogsEnabled(): boolean {
  if (process.env.OTEL_SDK_DISABLED === "true") return false;
  return process.env.OTEL_LOGS_EXPORTER !== "none";
}

/**
 * Whether to pretty-print the stdout arm (multi-line, colorized). Off by
 * default so production emits structured JSON; opt in with `LOG_PRETTY=true`.
 * Either way, `level`/`time` are already human-readable — see
 * `buildPinoLoggerOptions`'s `formatters`/`timestamp`.
 */
export function shouldPrettyPrint(): boolean {
  return process.env.LOG_PRETTY === "true";
}

/** Maps a pino numeric level to the nearest OpenTelemetry `SeverityNumber`. */
export function pinoLevelToSeverity(level: number): SeverityNumber {
  if (level >= 60) return SeverityNumber.FATAL;
  if (level >= 50) return SeverityNumber.ERROR;
  if (level >= 40) return SeverityNumber.WARN;
  if (level >= 30) return SeverityNumber.INFO;
  if (level >= 20) return SeverityNumber.DEBUG;
  return SeverityNumber.TRACE;
  //if (level >= 10) return SeverityNumber.TRACE;
  //return SeverityNumber.UNSPECIFIED;
}

/** Maps a pino level *label* (as written by {@link levelLabelFormatter}, e.g. `"Debug"`) to the nearest OTel `SeverityNumber`. */
export function pinoLabelToSeverity(label: string): SeverityNumber {
  switch (label.toLowerCase()) {
    case "fatal":
      return SeverityNumber.FATAL;
    case "error":
      return SeverityNumber.ERROR;
    case "warn":
      return SeverityNumber.WARN;
    case "info":
      return SeverityNumber.INFO;
    case "debug":
      return SeverityNumber.DEBUG;
    default:
      return SeverityNumber.TRACE;
  }
}

/** Resolves a record's OTel severity from either level shape pino may have written (number, pre-{@link levelLabelFormatter}; or label string, after it). */
function parseRecordSeverity(level: unknown): SeverityNumber {
  if (typeof level === "number") return pinoLevelToSeverity(level);
  if (typeof level === "string") return pinoLabelToSeverity(level);
  return pinoLevelToSeverity(0);
}

/** Resolves a record's timestamp (epoch ms) from either time shape pino may have written (number; or an ISO string, after {@link isoTimeWithOffset}). */
function parseRecordTime(time: unknown): number | undefined {
  if (typeof time === "number") return time;
  if (typeof time === "string") {
    const parsed = Date.parse(time);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/**
 * pino `formatters.level`: emits both a human `level` (capitalized label, e.g.
 * `"Info"` — readable in stdout JSON without a lookup table; read back by
 * `parseRecordSeverity` for the OTel arm) and a DataDog-native `status` (the
 * lowercase reserved severity, e.g. `"info"`). DataDog's default status remapper
 * reads `status`, so error-level filtering works with no DataDog-side pipeline.
 */
function levelLabelFormatter(label: string): { level: string; status: string } {
  return {
    level: label.charAt(0).toUpperCase() + label.slice(1),
    status: label.toLowerCase(),
  };
}

/** Zero-pads `n` to `width` digits. */
function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * Formats `date` as an ISO-8601 timestamp using the local timezone offset
 * (e.g. `2026-07-15T12:15:09.859+03:00`) instead of `Date#toISOString`'s
 * fixed UTC `Z` — readable at a glance against a developer's or server's own
 * clock when tailing stdout, without losing precision or timezone info.
 */
function isoTimeWithOffset(date: Date): string {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${offset}`
  );
}

/** pino `timestamp` function: emits `isoTimeWithOffset` instead of the default epoch-ms `time`. */
function isoTimestamp(): string {
  return `,"time":"${isoTimeWithOffset(new Date())}"`;
}

export interface PinoLoggerOptions {
  level: string;
  mixin: () => TraceFields;
  formatters: { level: (label: string) => { level: string; status: string } };
  timestamp: () => string;
}

/**
 * Builds the plain pino logger options: level from `LOG_LEVEL`, the trace
 * mixin, and human-readable `level`/`time` fields (a capitalized label
 * instead of pino's default number, a local-offset ISO string instead of
 * epoch ms) — every arm of {@link buildPinoDestination} gets these, stdout
 * included, since pino formats a record once before fanning it out.
 */
export function buildPinoLoggerOptions(): PinoLoggerOptions {
  return {
    level: process.env.LOG_LEVEL ?? "debug",
    // level: process.env.LOG_LEVEL ?? "info",
    mixin: traceMixin,
    formatters: { level: levelLabelFormatter },
    timestamp: isoTimestamp,
  };
}

export type PinoDestination = NodeJS.WritableStream | ReturnType<typeof pino.multistream>;

/**
 * Builds the pino destination: stdout (pretty in dev, raw JSON in prod) alone
 * when the OTel log path is disabled, or a `pino.multistream` of stdout +
 * {@link OtelPinoStream} when enabled. `options.loggerName` is forwarded to
 * `OtelPinoStream` — see its docs for what it controls.
 */
export function buildPinoDestination(options?: { loggerName?: string }): PinoDestination {
  const stdoutStream = shouldPrettyPrint() ? pretty({ colorize: true }) : process.stdout;
  if (!otelLogsEnabled()) return stdoutStream;
  // `level: "trace"` on EVERY arm, and it is load-bearing. The logger's own
  // `level` (see `buildPinoLoggerOptions`) is the intended and only filter; the
  // streams must not re-apply one on top of it. It is set EXPLICITLY rather
  // than omitted because `pino.multistream` does not inherit the logger's
  // level: `multistream.js` defaults each stream to `opts.level || "info"` and
  // filters a SECOND time on write. Omitting it therefore means a logger built
  // at `LOG_LEVEL=debug` writes its debug records into a destination that
  // silently discards them — on both arms at once, so they are missing from
  // stdout AND from the OTLP log stream, with no error anywhere.
  //
  // Found by plugins/mcp-service/evals/e2e-mcp: the framework's DEBUG
  // `initialize` log never reached the collector, and could not have.
  //
  // Note the effect on volume: with the floor working, an unconfigured service
  // now emits DEBUG and above on both arms. See this package's README, "Log
  // level" — services that want the old volume set `LOG_LEVEL=info`.
  return pino.multistream([
    { stream: stdoutStream, level: "trace" },
    { stream: new OtelPinoStream(options?.loggerName), level: "trace" },
  ]);
}
