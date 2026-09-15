/** Which OTLP transport an exporter should speak. */
export type OtlpProtocol = "grpc" | "http";

/** Maps a standard OTLP protocol env value ("grpc" | "http/protobuf" | "http/json") to our two-way choice. */
function fromProtocolEnv(value: string | undefined): OtlpProtocol | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "grpc") return "grpc";
  if (v.startsWith("http")) return "http";
  return undefined;
}

/** Infers the transport from an endpoint's port: 4317 → grpc, 4318 → http; otherwise unknown. */
function fromEndpoint(endpoint: string | undefined): OtlpProtocol | undefined {
  if (endpoint === undefined || endpoint === "") return undefined;
  try {
    const { port } = new URL(endpoint);
    if (port === "4317") return "grpc";
    if (port === "4318") return "http";
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the OTLP transport for a signal, highest precedence first:
 *   1. Signal-specific protocol env (OTEL_EXPORTER_OTLP_{TRACES,LOGS}_PROTOCOL)
 *   2. General protocol env (OTEL_EXPORTER_OTLP_PROTOCOL)
 *   3. Endpoint-port inference (signal-specific endpoint, then general): 4317→grpc, 4318→http
 *   4. Default "http" (the OTLP spec's default transport; also the platform collector's port)
 */
export function resolveOtlpProtocol(signal: "traces" | "logs"): OtlpProtocol {
  const signalKey = signal.toUpperCase();

  const fromEnv =
    fromProtocolEnv(process.env[`OTEL_EXPORTER_OTLP_${signalKey}_PROTOCOL`]) ??
    fromProtocolEnv(process.env.OTEL_EXPORTER_OTLP_PROTOCOL);
  if (fromEnv !== undefined) return fromEnv;

  const inferred =
    fromEndpoint(process.env[`OTEL_EXPORTER_OTLP_${signalKey}_ENDPOINT`]) ??
    fromEndpoint(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  if (inferred !== undefined) return inferred;

  return "http";
}
