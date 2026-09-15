// libs/nestjs-mcp/src/telemetry/pino-otel.spec.ts
import { OtelPinoStream, buildPinoLoggerOptions, traceMixin } from "@playground/otel-extensions";
import { buildPinoOptions } from "./pino-otel.js";

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("buildPinoOptions", () => {
  it("wires the trace mixin via the pinoHttp tuple", () => {
    const params = buildPinoOptions();
    expect(Array.isArray(params.pinoHttp)).toBe(true);
    const [options] = params.pinoHttp as [{ mixin?: unknown }, unknown];
    expect(options.mixin).toBe(traceMixin);
    expect(options).toMatchObject(buildPinoLoggerOptions());
  });

  it("logs successful health probes below the default floor, but surfaces failures", () => {
    const [options] = buildPinoOptions().pinoHttp as [
      {
        customLogLevel?: (
          req: { url?: string },
          res: { statusCode?: number },
          err?: Error,
        ) => string;
      },
      unknown,
    ];
    const level = options.customLogLevel;
    expect(typeof level).toBe("function");

    // Successful liveness/readiness probes: below the "debug" floor, so silent.
    expect(level!({ url: "/health" }, { statusCode: 200 })).toBe("trace");
    expect(level!({ url: "/health/ready" }, { statusCode: 200 })).toBe("trace");
    expect(level!({ url: "/health/ready?ts=1" }, { statusCode: 200 })).toBe("trace");

    // A failing probe (e.g. readiness returning 503, or a thrown error) still logs.
    expect(level!({ url: "/health/ready" }, { statusCode: 503 })).toBe("error");
    expect(level!({ url: "/health" }, { statusCode: 200 }, new Error("boom"))).toBe(
      "error",
    );

    // Everything else is unaffected.
    expect(level!({ url: "/read/mcp" }, { statusCode: 200 })).toBe("info");
    expect(level!({ url: "/read/mcp" }, { statusCode: 500 })).toBe("info");
  });

  it("names the MCP tool target in the success/error message instead of the generic default", () => {
    const [options] = buildPinoOptions().pinoHttp as [
      {
        customSuccessMessage?: (
          req: unknown,
          res: unknown,
          responseTime: number,
        ) => string;
        customErrorMessage?: (req: unknown, res: unknown, err: Error) => string;
      },
      unknown,
    ];
    const success = options.customSuccessMessage;
    const error = options.customErrorMessage;
    expect(typeof success).toBe("function");
    expect(typeof error).toBe("function");

    // tools/call: the message names the tool, not just the JSON-RPC method.
    const toolCallReq = {
      method: "POST",
      url: "/read/mcp",
      body: { method: "tools/call", params: { name: "execute_cypher" } },
    };
    expect(success!(toolCallReq, {}, 82)).toBe(
      "POST /read/mcp [tools/call:execute_cypher] completed",
    );
    expect(error!(toolCallReq, {}, new Error("boom"))).toBe(
      "POST /read/mcp [tools/call:execute_cypher] errored",
    );

    // Other JSON-RPC methods (no tool name): falls back to the bare method.
    const listReq = { method: "POST", url: "/read/mcp", body: { method: "tools/list" } };
    expect(success!(listReq, {}, 5)).toBe("POST /read/mcp [tools/list] completed");

    // Non-MCP requests (health probes, malformed/absent body): just method + URL.
    const healthReq = { method: "GET", url: "/health", body: {} };
    expect(success!(healthReq, {}, 1)).toBe("GET /health completed");
  });

  it("delegates its destination to @playground/otel-extensions' buildPinoDestination", () => {
    delete process.env.OTEL_LOGS_EXPORTER;
    delete process.env.OTEL_SDK_DISABLED;
    // buildPinoDestination() builds a fresh `pino.multistream` on every call (its
    // internal write/add/... closures are recreated each time), so two independent
    // calls are never `toEqual` — assert the shape that proves delegation instead:
    // a real (non-stdout) multistream whose OTel arm is otel-extensions' own
    // `OtelPinoStream`, not a locally-reimplemented one.
    const [, stream] = buildPinoOptions().pinoHttp as [
      unknown,
      { streams?: Array<{ stream: unknown }> },
    ];
    expect(stream).not.toBe(process.stdout);
    expect(stream.streams).toHaveLength(2);
    const otelStream = stream.streams?.find(
      ({ stream: s }) => s instanceof OtelPinoStream,
    )?.stream;
    expect(otelStream).toBeInstanceOf(OtelPinoStream);
    expect((otelStream as unknown as { loggerName: string }).loggerName).toBe(
      "nestjs-mcp",
    );
  });
});
