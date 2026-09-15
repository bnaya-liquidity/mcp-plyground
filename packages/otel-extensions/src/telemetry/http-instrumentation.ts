import type { Instrumentation } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";

/**
 * Incoming path prefixes dropped by default: **none**.
 *
 * Request-path filtering is the COLLECTOR's responsibility, not the
 * application's (decided 2026-08-31). Filtering in one place that can be
 * changed without a release beats a default compiled into every service, and a
 * default that deletes telemetry needs knowledge of each service's real routes —
 * `/metrics` and `/ping` are genuine endpoints on some services, and a span that
 * silently stops existing is worse than one that is dropped visibly downstream.
 *
 * The collector's `filter/health` processor drops probe traffic, and it runs
 * before the exporters and before `span_metrics`, so filtered spans are absent
 * from the trace list and the latency histograms alike — the same end state this
 * list used to produce, in a place that can be tuned per service.
 *
 * Kept as an empty escape hatch rather than removed, so a service with a
 * genuinely local reason can still opt in via `ignoreIncomingPaths`. Prefer the
 * collector; a value here is a second source of truth for one concern.
 */
export const DEFAULT_IGNORE_INCOMING_PATHS: readonly string[] = [];

export interface HttpInstrumentationOptions {
  /** Set false to register no instrumentation at all. Default true. */
  httpInstrumentation?: boolean;
  /**
   * Path prefixes to drop, as an escape hatch. Defaults to
   * {@link DEFAULT_IGNORE_INCOMING_PATHS}, which is EMPTY: path filtering
   * belongs to the collector. Set this only for a service with a local reason,
   * and expect to justify it.
   */
  ignoreIncomingPaths?: readonly string[];
}

/**
 * True when this request should produce no server span.
 *
 * Matching is on whole path SEGMENTS, not a raw string prefix: a bare
 * `startsWith("/health")` also swallows `/healthy-lifestyle`, which is a real
 * route on somebody's service. A prefix matches when the path equals it or
 * continues with `/`.
 */
export function shouldIgnoreIncomingRequest(
  url: string | undefined,
  ignorePaths: readonly string[],
): boolean {
  const path = (url ?? "").split("?")[0] ?? "";
  if (path === "") return false;
  return ignorePaths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** The two OTLP defaults the exporters fall back to when no env var is set. */
const DEFAULT_OTLP_ENDPOINTS = ["http://localhost:4318", "http://localhost:4317"] as const;

const OTLP_ENDPOINT_ENV_VARS = [
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
] as const;

const SCHEME_DEFAULT_PORT: Record<string, string> = { "http:": "80", "https:": "443" };

/**
 * Strips a single leading `[` and trailing `]` from an IPv6 literal.
 *
 * `new URL(...).hostname` keeps the brackets (`"[::1]"`), but the outgoing
 * request Node hands the instrumentation's hook comes from
 * `urlToHttpOptions`, which strips them (`"::1"`). Both sides of the
 * authority comparison must agree on one representation, so this is applied
 * everywhere a hostname is derived from a `URL` and everywhere one is parsed
 * out of a raw `host` string.
 */
function stripBrackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

/**
 * Parses one endpoint string to its `"hostname:port"` authority (hostname
 * unbracketed, see {@link stripBrackets}), defaulting the port from the URL
 * scheme only when the URL itself carries none. Returns `undefined` for
 * anything that does not parse as a URL — a malformed env var must not break
 * telemetry startup.
 */
function toAuthority(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    const hostname = stripBrackets(parsed.hostname);
    const port = parsed.port !== "" ? parsed.port : (SCHEME_DEFAULT_PORT[parsed.protocol] ?? "");
    return port !== "" ? `${hostname}:${port}` : hostname;
  } catch {
    return undefined;
  }
}

/**
 * Extracts the hostname portion of a raw `host` string (as seen on
 * `http.RequestOptions.host`, e.g. `"localhost:4318"`,
 * `"[::1]:4318"`, or a bare `"[::1]"`/`"::1"`).
 *
 * An IPv6 literal's brackets are the only reliable delimiter for where the
 * host ends: `host.split(":")[0]` gives `"["` for `"[::1]:4318"`, which is
 * wrong. So: if a `]` is present, everything up to it (unbracketed) is the
 * host; else if there is exactly one `:`, split on it; else the whole string
 * is the host (a bare IPv6 literal with no brackets and no port has many
 * colons).
 */
function extractHostname(host: string): string {
  const bracketEnd = host.indexOf("]");
  if (host.startsWith("[") && bracketEnd !== -1) {
    return host.slice(1, bracketEnd);
  }
  const parts = host.split(":");
  if (parts.length === 2 && parts[0] !== undefined) return parts[0];
  return host;
}

/**
 * The set of `"hostname:port"` authorities the configured OTLP exporters
 * send to — i.e. the endpoints that must NOT get their own client span (see
 * {@link buildHttpInstrumentations} for why).
 *
 * Reads the signal-specific and generic OTLP endpoint env vars, in the same
 * precedence OTel's own exporters use, and always also includes the two
 * hardcoded defaults: an unset env var means the exporter falls back to one
 * of `http://localhost:4318` (HTTP) or `http://localhost:4317` (gRPC), so
 * both must be covered even when nothing is configured.
 */
export function otlpEndpointAuthorities(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const values = [
    ...OTLP_ENDPOINT_ENV_VARS.map((name) => env[name]).filter(
      (value): value is string => value !== undefined,
    ),
    ...DEFAULT_OTLP_ENDPOINTS,
  ];
  const authorities = new Set<string>();
  for (const value of values) {
    const authority = toAuthority(value);
    if (authority !== undefined) authorities.add(authority);
  }
  return authorities;
}

/**
 * True when an outgoing request targets one of the configured OTLP
 * exporters' own endpoints (see {@link otlpEndpointAuthorities}).
 *
 * Prefers `hostname`; falls back to `host`, extracting its hostname portion
 * via {@link extractHostname} (a raw `:`-split breaks on an IPv6 literal's
 * own colons). Either way the hostname is run through {@link stripBrackets}
 * so an IPv6 literal matches regardless of which representation it arrived
 * in. `port` is coerced to a string; when it is absent, this matches on
 * hostname alone against any authority with that hostname. Returns `false`
 * when no host can be determined at all — never a blanket suppression.
 */
export function shouldIgnoreOutgoingRequest(
  options: { hostname?: string | null; host?: string | null; port?: number | string | null },
  authorities: ReadonlySet<string>,
): boolean {
  const rawHostname = options.hostname ?? (options.host !== null && options.host !== undefined
    ? extractHostname(options.host)
    : undefined);
  if (rawHostname === undefined || rawHostname === "") return false;
  const hostname = stripBrackets(rawHostname);
  const port = options.port !== null && options.port !== undefined ? String(options.port) : undefined;
  if (port !== undefined) return authorities.has(`${hostname}:${port}`);
  for (const authority of authorities) {
    if (authority.startsWith(`${hostname}:`)) return true;
  }
  return false;
}

/**
 * Builds the instrumentation list registered by `initTelemetry`.
 *
 * Deliberately `http` ONLY — server and client spans. No express (a span per
 * middleware layer is internal-framework noise, not signal), and no fs/dns/net.
 *
 * Incoming requests are NOT filtered here by default. Probe and path filtering
 * is the collector's job — see {@link DEFAULT_IGNORE_INCOMING_PATHS}. Note the
 * asymmetry with outgoing requests below, which is deliberate: dropping probe
 * noise is a POLICY choice that belongs where it can be tuned, while the
 * outgoing OTLP exclusion is a CORRECTNESS guard that only the app can apply.
 *
 * Client spans ARE traced for outgoing requests — EXCEPT the configured OTLP
 * exporters' own endpoint. `sdk.ts` uses `SimpleSpanProcessor`, which exports
 * on every span end; without this exclusion, the exporter's own `http.request`
 * POST would itself produce a client span, whose `span.end()` triggers another
 * export, recursing without bound. At the pinned versions
 * (`@opentelemetry/otlp-exporter-base@0.219.0`,
 * `@opentelemetry/instrumentation-http@0.219.0`) neither side suppresses this
 * for us: the exporter never calls `suppressTracing`, and the instrumentation's
 * outgoing-request path has no `isTracingSuppressed` check (only its incoming
 * path does). gRPC is unaffected — `@grpc/grpc-js` runs over `http2`, which
 * this instrumentation does not patch.
 */
export function buildHttpInstrumentations(
  options: HttpInstrumentationOptions = {},
): Instrumentation[] {
  const {
    httpInstrumentation = true,
    ignoreIncomingPaths = DEFAULT_IGNORE_INCOMING_PATHS,
  } = options;
  if (!httpInstrumentation) return [];
  const authorities = otlpEndpointAuthorities();
  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (request) =>
        shouldIgnoreIncomingRequest(request.url, ignoreIncomingPaths),
      ignoreOutgoingRequestHook: (options) => shouldIgnoreOutgoingRequest(options, authorities),
    }),
  ];
}
