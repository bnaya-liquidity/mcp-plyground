import { jest } from "@jest/globals";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPMetricExporter as GrpcMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPMetricExporter as HttpMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

const COLLECTOR_IMAGE = "otel/opentelemetry-collector-contrib:0.152.0";

// Collector: OTLP in (grpc 4317 + http 4318) -> debug out, one log stream for
// all three signals. The debug exporter (verbosity: detailed) prints each
// span's `Name`, each metric descriptor's `Name`, and each log record's
// `Body` straight to stdout/stderr, so the collector's own log stream — read
// via the Docker API, not a bind-mounted host file — is the assertion oracle.
// That keeps this test daemon-location-independent (works under remote/DinD
// CI, where a host bind mount would not be visible to the daemon).
const COLLECTOR_CONFIG = `
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug:
    verbosity: detailed
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
    metrics:
      receivers: [otlp]
      exporters: [debug]
    logs:
      receivers: [otlp]
      exporters: [debug]
`;

const ORIGINAL_ENV = { ...process.env };

let container: StartedTestContainer;
const logBuffer: string[] = [];

beforeAll(async () => {
  container = await new GenericContainer(COLLECTOR_IMAGE)
    .withCopyContentToContainer([
      { content: COLLECTOR_CONFIG, target: "/etc/otelcol/config.yaml" },
    ])
    .withCommand(["--config=/etc/otelcol/config.yaml"])
    .withExposedPorts(4317, 4318)
    .withWaitStrategy(Wait.forLogMessage(/Everything is ready/))
    .withStartupTimeout(120_000)
    .start();

  const stream = await container.logs();
  stream.on("data", (line) => logBuffer.push(line.toString()));
  stream.on("err", (line) => logBuffer.push(line.toString()));
}, 120_000);

afterAll(async () => {
  if (container) await container.stop();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Reads the collector's accumulated log stream, captured via the Docker API. */
async function readOutput(): Promise<string> {
  return logBuffer.join("");
}

/** Polls the collector output until every marker is present, or fails after the timeout. */
async function waitForMarkers(markers: string[], timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await readOutput();
    if (markers.every((m) => last.includes(m))) return last;
    await sleep(500);
  }
  throw new Error(
    `timed out waiting for markers ${JSON.stringify(markers)}; last output:\n${last.slice(-2000)}`,
  );
}

/**
 * Sends one span, one log record, and one metric through the lib's exporter
 * selection (traces/logs) plus a directly-built metric exporter, over the given
 * transport, then flushes. Signal names are transport-unique so the two tests
 * can share one collector log stream without ambiguity.
 */
async function sendAllSignals(
  transport: "grpc" | "http",
  endpoint: string,
  names: { span: string; log: string; metric: string },
): Promise<void> {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
  process.env.OTEL_EXPORTER_OTLP_PROTOCOL =
    transport === "grpc" ? "grpc" : "http/protobuf";
  delete process.env.OTEL_SDK_DISABLED;

  // Fresh sdk.js so makeTraceExporter/makeLogExporter read the env just set.
  jest.resetModules();
  const { makeTraceExporter, makeLogExporter } = await import("../src/telemetry/sdk.js");

  // Traces
  const tracerProvider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(makeTraceExporter())],
  });
  tracerProvider.getTracer("integration").startSpan(names.span).end();
  await tracerProvider.forceFlush();

  // Logs
  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: makeLogExporter() })],
  });
  loggerProvider.getLogger("integration").emit({
    severityNumber: SeverityNumber.INFO,
    body: names.log,
  });
  await loggerProvider.forceFlush();

  // Metrics (built directly for the transport under test)
  const metricExporter =
    transport === "grpc" ? new GrpcMetricExporter() : new HttpMetricExporter();
  const meterProvider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 60_000,
      }),
    ],
  });
  meterProvider.getMeter("integration").createCounter(names.metric).add(1);
  await meterProvider.forceFlush();

  await tracerProvider.shutdown();
  await loggerProvider.shutdown();
  await meterProvider.shutdown();
}

describe("OTLP transport integration (real collector via Testcontainers)", () => {
  it("delivers traces, logs, and metrics over OTLP/gRPC", async () => {
    const endpoint = `http://${container.getHost()}:${container.getMappedPort(4317)}`;
    const names = { span: "grpc-span", log: "grpc-log", metric: "grpc_metric_counter" };
    await sendAllSignals("grpc", endpoint, names);
    const out = await waitForMarkers([names.span, names.log, names.metric]);
    expect(out).toContain(names.span);
    expect(out).toContain(names.log);
    expect(out).toContain(names.metric);
  });

  it("delivers traces, logs, and metrics over OTLP/HTTP", async () => {
    const endpoint = `http://${container.getHost()}:${container.getMappedPort(4318)}`;
    const names = { span: "http-span", log: "http-log", metric: "http_metric_counter" };
    await sendAllSignals("http", endpoint, names);
    const out = await waitForMarkers([names.span, names.log, names.metric]);
    expect(out).toContain(names.span);
    expect(out).toContain(names.log);
    expect(out).toContain(names.metric);
  });
});
