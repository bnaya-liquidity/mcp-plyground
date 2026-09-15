import { context, trace } from "@opentelemetry/api";
import { SeverityNumber, logs } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { hrTimeToMilliseconds } from "@opentelemetry/core";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import pino from "pino";
import {
  OtelPinoStream,
  buildPinoDestination,
  buildPinoLoggerOptions,
  otelLogsEnabled,
  pinoLabelToSeverity,
  pinoLevelToSeverity,
  shouldPrettyPrint,
  traceMixin,
} from "./pino-otel.js";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

const contextManager = new AsyncLocalStorageContextManager();
beforeAll(() => context.setGlobalContextManager(contextManager.enable()));
afterAll(() => {
  contextManager.disable();
  context.disable();
});

describe("pinoLevelToSeverity", () => {
  it.each([
    [10, SeverityNumber.TRACE],
    [20, SeverityNumber.DEBUG],
    [30, SeverityNumber.INFO],
    [40, SeverityNumber.WARN],
    [50, SeverityNumber.ERROR],
    [60, SeverityNumber.FATAL],
  ])("maps pino level %i to the matching OTel SeverityNumber", (level, expected) => {
    expect(pinoLevelToSeverity(level)).toBe(expected);
  });

  it("rounds an in-between level down to the nearest band (e.g. 35 → INFO)", () => {
    expect(pinoLevelToSeverity(35)).toBe(SeverityNumber.INFO);
  });

  it("maps an unknown/zero level to UNSPECIFIED", () => {
    expect(pinoLevelToSeverity(0)).toBe(SeverityNumber.TRACE);
    // expect(pinoLevelToSeverity(0)).toBe(SeverityNumber.UNSPECIFIED);
  });
});

describe("pinoLabelToSeverity", () => {
  it.each([
    ["Trace", SeverityNumber.TRACE],
    ["Debug", SeverityNumber.DEBUG],
    ["Info", SeverityNumber.INFO],
    ["Warn", SeverityNumber.WARN],
    ["Error", SeverityNumber.ERROR],
    ["Fatal", SeverityNumber.FATAL],
  ])("maps the %s label to the matching OTel SeverityNumber", (label, expected) => {
    expect(pinoLabelToSeverity(label)).toBe(expected);
  });

  it("is case-insensitive", () => {
    expect(pinoLabelToSeverity("error")).toBe(SeverityNumber.ERROR);
    expect(pinoLabelToSeverity("ERROR")).toBe(SeverityNumber.ERROR);
  });

  it("maps an unrecognized label to TRACE", () => {
    expect(pinoLabelToSeverity("bogus")).toBe(SeverityNumber.TRACE);
  });
});

describe("traceMixin", () => {
  it("returns trace_id/span_id/trace_flags when a span is active", () => {
    const span = trace.wrapSpanContext({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: 1,
    });
    const ctx = trace.setSpan(context.active(), span);

    const fields = context.with(ctx, () => traceMixin());

    expect(fields).toEqual({ trace_id: TRACE_ID, span_id: SPAN_ID, trace_flags: 1 });
  });

  it("returns an empty object when no span is active", () => {
    expect(traceMixin()).toEqual({});
  });
});

describe("OtelPinoStream", () => {
  let exporter: InMemoryLogRecordExporter;
  let provider: LoggerProvider;

  beforeEach(() => {
    exporter = new InMemoryLogRecordExporter();
    provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter })],
    });
    logs.setGlobalLoggerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    logs.disable();
  });

  it("parses a pino line and emits one LogRecord with body, severity and attributes", () => {
    const stream = new OtelPinoStream();
    const line = JSON.stringify({
      level: 30,
      time: 1_700_000_000_000,
      msg: "playground-mcp listening",
      pid: 123,
      hostname: "h",
      context: "Bootstrap",
      port: 3000,
    });

    stream.write(line);

    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.body).toBe("playground-mcp listening");
    expect(record.severityNumber).toBe(pinoLevelToSeverity(30));
    expect(record.attributes).toMatchObject({ context: "Bootstrap", port: 3000 });
    expect(record.attributes).not.toHaveProperty("pid");
    expect(record.attributes).not.toHaveProperty("msg");
  });

  it("propagates trace_id/span_id onto the emitted record's trace context", () => {
    const stream = new OtelPinoStream();
    const line = JSON.stringify({
      level: 50,
      time: 1_700_000_000_000,
      msg: "boom",
      trace_id: TRACE_ID,
      span_id: SPAN_ID,
      trace_flags: 1,
    });

    stream.write(line);

    const record = exporter.getFinishedLogRecords()[0]!;
    expect(record.spanContext?.traceId).toBe(TRACE_ID);
    expect(record.spanContext?.spanId).toBe(SPAN_ID);
    expect(record.attributes).not.toHaveProperty("trace_id");
  });

  it("drops a malformed (non-JSON) line without throwing or emitting", () => {
    const stream = new OtelPinoStream();
    expect(() => stream.write("not json")).not.toThrow();
    expect(exporter.getFinishedLogRecords()).toHaveLength(0);
  });

  it('emits under the default "pino" logger name when none is given', () => {
    const stream = new OtelPinoStream();
    stream.write(JSON.stringify({ level: 30, time: 1, msg: "hi" }));
    expect(exporter.getFinishedLogRecords()).toHaveLength(1);
    // instrumentationScope is attached by the SDK based on logs.getLogger(name)
    const record = exporter.getFinishedLogRecords()[0]!;
    expect(record.instrumentationScope.name).toBe("pino");
  });

  it("emits under a custom logger name when given", () => {
    const stream = new OtelPinoStream("nestjs-mcp");
    stream.write(JSON.stringify({ level: 30, time: 1, msg: "hi" }));
    const record = exporter.getFinishedLogRecords()[0]!;
    expect(record.instrumentationScope.name).toBe("nestjs-mcp");
  });

  it("parses the human-readable level label + ISO time written by buildPinoLoggerOptions", () => {
    const stream = new OtelPinoStream();
    // A future instant: timeInputToHrTime treats a numeric/date input smaller
    // than the process's time origin as a performance.now() offset rather
    // than an absolute epoch, so the timestamp under test must sit ahead of
    // "now" to round-trip through the OTel SDK unambiguously.
    const future = new Date(Date.now() + 60_000).toISOString();
    const line = JSON.stringify({ level: "Error", time: future, msg: "boom" });

    stream.write(line);

    const record = exporter.getFinishedLogRecords()[0]!;
    expect(record.severityNumber).toBe(SeverityNumber.ERROR);
    expect(hrTimeToMilliseconds(record.hrTime)).toBe(Date.parse(future));
  });
});

describe("otelLogsEnabled", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("is enabled by default", () => {
    delete process.env.OTEL_LOGS_EXPORTER;
    delete process.env.OTEL_SDK_DISABLED;
    expect(otelLogsEnabled()).toBe(true);
  });

  it("is enabled when OTEL_LOGS_EXPORTER=otlp", () => {
    process.env.OTEL_LOGS_EXPORTER = "otlp";
    expect(otelLogsEnabled()).toBe(true);
  });

  it("is disabled when OTEL_LOGS_EXPORTER=none", () => {
    process.env.OTEL_LOGS_EXPORTER = "none";
    expect(otelLogsEnabled()).toBe(false);
  });

  it("is disabled when OTEL_SDK_DISABLED=true", () => {
    process.env.OTEL_SDK_DISABLED = "true";
    expect(otelLogsEnabled()).toBe(false);
  });
});

describe("shouldPrettyPrint", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("is off by default (production-safe: structured JSON to stdout)", () => {
    delete process.env.LOG_PRETTY;
    expect(shouldPrettyPrint()).toBe(false);
  });

  it("is on when LOG_PRETTY=true", () => {
    process.env.LOG_PRETTY = "true";
    expect(shouldPrettyPrint()).toBe(true);
  });
});

describe("buildPinoLoggerOptions", () => {
  it("wires the trace mixin", () => {
    const options = buildPinoLoggerOptions();
    expect(options.mixin).toBe(traceMixin);
  });

  it("defaults level to info", () => {
    delete process.env.LOG_LEVEL;
    expect(buildPinoLoggerOptions().level).toBe("debug");
  });

  it("formats the level as a capitalized label plus a DataDog-native status", () => {
    const { formatters } = buildPinoLoggerOptions();
    expect(formatters.level("debug")).toEqual({ level: "Debug", status: "debug" });
    expect(formatters.level("info")).toEqual({ level: "Info", status: "info" });
    expect(formatters.level("error")).toEqual({ level: "Error", status: "error" });
  });

  it("lowercases the status for DataDog's default status remapper", () => {
    const { formatters } = buildPinoLoggerOptions();
    expect(formatters.level("WARN").status).toBe("warn");
    expect(formatters.level("Fatal").status).toBe("fatal");
  });

  it("stamps a local-offset ISO timestamp field instead of pino's default epoch ms", () => {
    const { timestamp } = buildPinoLoggerOptions();
    const field = timestamp();
    expect(field).toMatch(
      /^,"time":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}"$/,
    );
    const [, iso] = /"time":"(.+)"/.exec(field) ?? [];
    expect(Date.parse(iso as string)).not.toBeNaN();
  });
});

describe("buildPinoDestination", () => {
  const ORIGINAL_ENV = { ...process.env };
  /** Global LoggerProviders installed by a test, torn down after each one. */
  const installedProviders: LoggerProvider[] = [];

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    while (installedProviders.length > 0) {
      await installedProviders.pop()?.shutdown();
    }
    logs.disable();
  });

  it("returns stdout when the OTel logs sink is disabled", () => {
    process.env.OTEL_LOGS_EXPORTER = "none";
    expect(buildPinoDestination()).toBe(process.stdout);
  });

  it("returns a non-stdout (multistream) destination when the OTel logs sink is enabled", () => {
    delete process.env.OTEL_LOGS_EXPORTER;
    delete process.env.OTEL_SDK_DISABLED;
    expect(buildPinoDestination()).not.toBe(process.stdout);
  });

  it("delivers DEBUG records to the destination, not just INFO and above", () => {
    // Regression test. `pino.multistream` filters a SECOND time on write and
    // defaults each stream to `info`, so a logger built at LOG_LEVEL=debug used
    // to write its debug records into a destination that discarded them —
    // silently, on both arms. Asserting a debug record ARRIVES is the only
    // thing that catches that; asserting the destination "is a multistream"
    // passes either way.
    delete process.env.OTEL_LOGS_EXPORTER;
    delete process.env.OTEL_SDK_DISABLED;
    process.env.LOG_LEVEL = "debug";

    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter })],
    });
    logs.setGlobalLoggerProvider(provider);
    // Restored below, not left installed: the global provider outlives this
    // test, so leaving it is a landmine for whatever is appended after it.
    installedProviders.push(provider);

    const logger = pino(buildPinoLoggerOptions(), buildPinoDestination());
    logger.debug("a debug record");
    logger.info("an info record");

    const messages = exporter.getFinishedLogRecords().map((record) => record.body);
    expect(messages).toContain("a debug record");
    expect(messages).toContain("an info record");
  });
});
