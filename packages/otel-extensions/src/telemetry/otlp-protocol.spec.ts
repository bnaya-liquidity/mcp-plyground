import { resolveOtlpProtocol } from "./otlp-protocol.js";

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function clearOtlpEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("OTEL_EXPORTER_OTLP")) delete process.env[k];
  }
}

describe("resolveOtlpProtocol", () => {
  beforeEach(clearOtlpEnv);

  it("defaults to http when nothing is set", () => {
    expect(resolveOtlpProtocol("traces")).toBe("http");
  });

  it("infers grpc from a :4317 endpoint", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otelcol:4317";
    expect(resolveOtlpProtocol("traces")).toBe("grpc");
  });

  it("infers http from a :4318 endpoint", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otelcol:4318";
    expect(resolveOtlpProtocol("logs")).toBe("http");
  });

  it("prefers the general protocol env over inference", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otelcol:4318";
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
    expect(resolveOtlpProtocol("traces")).toBe("grpc");
  });

  it("prefers the signal-specific protocol env over the general one", () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
    process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "http/protobuf";
    expect(resolveOtlpProtocol("logs")).toBe("http");
    expect(resolveOtlpProtocol("traces")).toBe("grpc");
  });

  it("maps http/protobuf and http/json to http", () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";
    expect(resolveOtlpProtocol("traces")).toBe("http");
  });

  it("prefers a signal-specific endpoint over the general one for inference", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otelcol:4318";
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://otelcol:4317";
    expect(resolveOtlpProtocol("traces")).toBe("grpc");
  });

  it("falls back to the default for an endpoint with an unrecognized port", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://vendor.example.com:443";
    expect(resolveOtlpProtocol("traces")).toBe("http");
  });
});
