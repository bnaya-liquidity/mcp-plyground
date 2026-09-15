import { jest } from "@jest/globals";

type InitTelemetry = (typeof import("./sdk.js"))["initTelemetry"];

async function loadInitTelemetry(): Promise<InitTelemetry> {
  jest.resetModules();
  const mod = await import("./sdk.js");
  return mod.initTelemetry;
}

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("initTelemetry", () => {
  describe("buildResourceAttributes", () => {
    async function build(serviceName: string): Promise<Record<string, string>> {
      jest.resetModules();
      const mod = await import("./sdk.js");
      return mod.buildResourceAttributes(serviceName);
    }

    it("omits service.version when neither env var is set", async () => {
      delete process.env.OTEL_SERVICE_VERSION;
      delete process.env.SERVICE_VERSION;

      const attrs = await build("svc-no-version");

      expect(attrs["service.name"]).toBe("svc-no-version");
      expect(attrs["service.instance.id"]).toBeDefined();
      // Absent, not a placeholder: a defaulted version reads as real in a
      // backend query and makes "did this start with the deploy?" unanswerable.
      expect(attrs).not.toHaveProperty("service.version");
    });

    it("prefers OTEL_SERVICE_VERSION over SERVICE_VERSION", async () => {
      process.env.OTEL_SERVICE_VERSION = "1.4.2";
      process.env.SERVICE_VERSION = "ignored";

      expect((await build("svc"))["service.version"]).toBe("1.4.2");
    });

    it("falls back to SERVICE_VERSION", async () => {
      delete process.env.OTEL_SERVICE_VERSION;
      process.env.SERVICE_VERSION = "abc1234";

      expect((await build("svc"))["service.version"]).toBe("abc1234");
    });

    it("treats an empty version string as unset rather than emitting an empty attribute", async () => {
      delete process.env.OTEL_SERVICE_VERSION;
      process.env.SERVICE_VERSION = "";

      expect(await build("svc")).not.toHaveProperty("service.version");
    });

    it("does NOT set collector-enriched attributes app-side", async () => {
      // These are enriched at the collector from the pod it runs beside. Two
      // sources for one attribute is how they diverge, so the app must not
      // guess them.
      const attrs = await build("svc");

      expect(attrs).not.toHaveProperty("deployment.environment");
      expect(attrs).not.toHaveProperty("k8s.pod.name");
      expect(attrs).not.toHaveProperty("k8s.namespace.name");
    });
  });

  it("returns a working no-op shutdown when OTEL_SDK_DISABLED=true", async () => {
    process.env.OTEL_SDK_DISABLED = "true";
    const initTelemetry = await loadInitTelemetry();

    const shutdown = initTelemetry("test-service");

    expect(typeof shutdown).toBe("function");
    await expect(shutdown()).resolves.toBeUndefined();
  });

  // Regression guard for a silent, install-time breakage.
  //
  // `makeLogExporter()` is handed to `new BatchLogRecordProcessor(...)` as
  // `{ exporter }`, which is the contract from @opentelemetry/sdk-logs 0.221.0
  // onward. Before 0.221.0 that constructor took the exporter POSITIONALLY; if
  // the shape ever drifts again, the exporter is left undefined and every log
  // export throws "Cannot read properties of undefined (reading 'export')" —
  // losing all logs while traces keep working.
  //
  // Asserting that `shutdown()` resolves does NOT catch this: the batch
  // processor swallows the failure and reports it through `diag`, so shutdown
  // resolves cleanly in both the working and broken cases (verified against a
  // real 0.221.0 install). The only reliable signal is whether records actually
  // reach an exporter, so this drives a stub through the real processor.
  it("delivers records to the exporter passed to BatchLogRecordProcessor", async () => {
    const { BatchLogRecordProcessor, LoggerProvider } = await import("@opentelemetry/sdk-logs");
    const exported: unknown[] = [];
    const stubExporter = {
      export(logRecords: unknown[], resultCallback: (result: { code: number }) => void): void {
        exported.push(...logRecords);
        resultCallback({ code: 0 });
      },
      shutdown(): Promise<void> {
        return Promise.resolve();
      },
      // Without this, BatchLogRecordProcessor's flush throws a TypeError that
      // the SDK swallows into a diag `Error` line — noise that looks like a
      // real failure in CI logs.
      forceFlush(): Promise<void> {
        return Promise.resolve();
      },
    };

    // Constructed exactly as sdk.ts does it — via the options object. The cast
    // is scoped to the exporter value, so the `{ exporter }` key itself stays
    // type-checked; if sdk-logs renames it, this stops compiling instead of
    // silently never calling the exporter.
    const provider = new LoggerProvider({
      processors: [new BatchLogRecordProcessor({ exporter: stubExporter as never })],
    });
    provider.getLogger("regression").emit({ body: "drift check", severityNumber: 13 });
    await provider.forceFlush();
    await provider.shutdown();

    expect(exported).toHaveLength(1);
  });

  it("is idempotent — repeated calls return the same shutdown handle (single SDK)", async () => {
    process.env.OTEL_SDK_DISABLED = "true";
    const initTelemetry = await loadInitTelemetry();

    const first = initTelemetry("test-service");
    const second = initTelemetry("test-service");

    expect(second).toBe(first);
  });
});

async function loadFactories() {
  jest.resetModules();
  return import("./sdk.js");
}

async function loadExporterTypes() {
  return {
    GrpcTraceExporter: (await import("@opentelemetry/exporter-trace-otlp-grpc"))
      .OTLPTraceExporter,
    HttpTraceExporter: (await import("@opentelemetry/exporter-trace-otlp-http"))
      .OTLPTraceExporter,
    GrpcLogExporter: (await import("@opentelemetry/exporter-logs-otlp-grpc"))
      .OTLPLogExporter,
    HttpLogExporter: (await import("@opentelemetry/exporter-logs-otlp-http"))
      .OTLPLogExporter,
  };
}

describe("exporter transport selection", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("builds gRPC exporters for a :4317 endpoint", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otelcol:4317";
    const { makeTraceExporter, makeLogExporter } = await loadFactories();
    const { GrpcTraceExporter, GrpcLogExporter } = await loadExporterTypes();
    expect(makeTraceExporter()).toBeInstanceOf(GrpcTraceExporter);
    expect(makeLogExporter()).toBeInstanceOf(GrpcLogExporter);
  });

  it("builds HTTP exporters for a :4318 endpoint", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otelcol:4318";
    const { makeTraceExporter, makeLogExporter } = await loadFactories();
    const { HttpTraceExporter, HttpLogExporter } = await loadExporterTypes();
    expect(makeTraceExporter()).toBeInstanceOf(HttpTraceExporter);
    expect(makeLogExporter()).toBeInstanceOf(HttpLogExporter);
  });
});

import type { Logger } from "pino";

function fakePinoLogger() {
  return {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    child: jest.fn(),
  };
}

describe("createDiagLogger", () => {
  async function loadCreateDiagLogger() {
    jest.resetModules();
    const mod = await import("./sdk.js");
    return mod.createDiagLogger;
  }

  it("routes diag.error through pino error (joined args) while closed", async () => {
    const createDiagLogger = await loadCreateDiagLogger();
    const logger = fakePinoLogger();
    const diagLogger = createDiagLogger(logger as unknown as Logger);
    diagLogger.error("14 UNAVAILABLE", "detail");
    expect(logger.error).toHaveBeenCalledWith("14 UNAVAILABLE detail");
  });

  it("routes diag.debug through pino debug", async () => {
    const createDiagLogger = await loadCreateDiagLogger();
    const logger = fakePinoLogger();
    const diagLogger = createDiagLogger(logger as unknown as Logger);
    diagLogger.debug("OTLPExportDelegate items");
    expect(logger.debug).toHaveBeenCalledWith("OTLPExportDelegate items");
  });

  it("passes diag.warn/info straight through to pino", async () => {
    const createDiagLogger = await loadCreateDiagLogger();
    const logger = fakePinoLogger();
    const diagLogger = createDiagLogger(logger as unknown as Logger);
    diagLogger.warn("w");
    diagLogger.info("i");
    expect(logger.warn).toHaveBeenCalledWith("w");
    expect(logger.info).toHaveBeenCalledWith("i");
  });
});

describe("makeShutdown", () => {
  /**
   * Records provider activity. Flush logs both its START and its COMPLETION,
   * because the property under test is "no shutdown begins until every flush
   * has COMPLETED" — asserting on call order alone is vacuous, since both
   * implementations invoke every forceFlush() synchronously via .map().
   * `flushTicks` delays completion so interleaving becomes observable.
   */
  function recordingProvider(name: string, log: string[], opts = {}) {
    const {
      flushRejects = false,
      shutdownRejects = false,
      flushTicks = 0,
    } = opts as { flushRejects?: boolean; shutdownRejects?: boolean; flushTicks?: number };
    return {
      async forceFlush(): Promise<void> {
        for (let i = 0; i < flushTicks; i++) await Promise.resolve();
        log.push(`${name}:flush:end`);
        if (flushRejects) throw new Error("flush failed");
      },
      shutdown(): Promise<void> {
        log.push(`${name}:shutdown:start`);
        return shutdownRejects ? Promise.reject(new Error("shutdown failed")) : Promise.resolve();
      },
    };
  }

  it("flushes EVERY provider before shutting ANY of them down", async () => {
    // The ordering guarantee: no exporter is torn down while another provider
    // may still be exporting. A shutdown-only teardown interleaves these.
    const log: string[] = [];
    const { makeShutdown } = await import("./sdk.js");

    // `tracer` flushes SLOWLY. If teardown is per-provider
    // (flush().then(shutdown)), logger:shutdown:start lands before
    // tracer:flush:end — the exact hazard this ordering exists to prevent.
    await makeShutdown([
      recordingProvider("tracer", log, { flushTicks: 5 }),
      recordingProvider("logger", log),
    ])();

    const lastFlush = Math.max(...log.map((e, i) => (e.endsWith(":flush:end") ? i : -1)));
    const firstShutdown = log.findIndex((e) => e.endsWith(":shutdown:start"));
    expect(firstShutdown).toBeGreaterThan(lastFlush);
    expect(log).toHaveLength(4);
  });

  it("still shuts every provider down when one fails to flush", async () => {
    const log: string[] = [];
    const { makeShutdown } = await import("./sdk.js");

    await makeShutdown([
      recordingProvider("tracer", log, { flushRejects: true }),
      recordingProvider("logger", log),
    ])();

    // A failing exporter must not strand the other provider's open handles —
    // that hangs the pod past its SIGTERM grace period.
    expect(log).toContain("tracer:shutdown:start");
    expect(log).toContain("logger:shutdown:start");
  });

  it("does not reject when a provider's shutdown rejects", async () => {
    const log: string[] = [];
    const { makeShutdown } = await import("./sdk.js");
    const shutdown = makeShutdown([
      recordingProvider("tracer", log, { shutdownRejects: true }),
    ]);

    await expect(shutdown()).resolves.toBeUndefined();
  });

  it("is idempotent — a second call flushes nothing further", async () => {
    const log: string[] = [];
    const { makeShutdown } = await import("./sdk.js");
    const shutdown = makeShutdown([recordingProvider("tracer", log)]);

    const first = shutdown();
    const second = shutdown();

    expect(second).toBe(first);
    await first;
    expect(log).toEqual(["tracer:flush:end", "tracer:shutdown:start"]);
  });

  it("resolves cleanly with no providers registered", async () => {
    const { makeShutdown } = await import("./sdk.js");
    await expect(makeShutdown([])()).resolves.toBeUndefined();
  });
});
