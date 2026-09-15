import { describe, expect, it } from "@jest/globals";
import {
  buildHttpInstrumentations,
  DEFAULT_IGNORE_INCOMING_PATHS,
  otlpEndpointAuthorities,
  shouldIgnoreIncomingRequest,
  shouldIgnoreOutgoingRequest,
} from "./http-instrumentation.js";

describe("shouldIgnoreIncomingRequest", () => {
  const paths = ["/health"] as const;

  it.each(["/health", "/health/ready", "/health?probe=1"])(
    "ignores the health probe path %s",
    (url) => {
      expect(shouldIgnoreIncomingRequest(url, paths)).toBe(true);
    },
  );

  it.each(["/read/mcp", "/", "/healthy-lifestyle", undefined])(
    "does not ignore %s",
    (url) => {
      expect(shouldIgnoreIncomingRequest(url, paths)).toBe(false);
    },
  );

  it("honours a caller-supplied prefix list", () => {
    expect(shouldIgnoreIncomingRequest("/internal/ping", ["/internal"])).toBe(true);
    expect(shouldIgnoreIncomingRequest("/health", ["/internal"])).toBe(false);
  });
});

describe("DEFAULT_IGNORE_INCOMING_PATHS", () => {
  // Guards a decision, not a behaviour: request-path filtering belongs to the
  // COLLECTOR (decided 2026-08-31), so the app-side default must stay empty. A
  // path re-added here reintroduces a second source of truth for one concern,
  // and telemetry dropped app-side cannot be recovered downstream.
  it("is empty, because path filtering is the collector's responsibility", () => {
    expect(DEFAULT_IGNORE_INCOMING_PATHS).toEqual([]);
  });

  it("therefore ignores nothing by default — probe paths included", () => {
    for (const path of ["/health", "/healthz", "/readyz", "/livez", "/ping", "/metrics"]) {
      expect(shouldIgnoreIncomingRequest(path, DEFAULT_IGNORE_INCOMING_PATHS)).toBe(false);
    }
  });
});

describe("buildHttpInstrumentations", () => {
  it("returns one instrumentation by default", () => {
    expect(buildHttpInstrumentations()).toHaveLength(1);
  });

  it("returns none when disabled", () => {
    expect(buildHttpInstrumentations({ httpInstrumentation: false })).toHaveLength(0);
  });
});

describe("otlpEndpointAuthorities", () => {
  it("includes both OTLP defaults when nothing is set", () => {
    const authorities = otlpEndpointAuthorities({});
    expect(authorities.has("localhost:4318")).toBe(true);
    expect(authorities.has("localhost:4317")).toBe(true);
  });

  it("includes a custom OTEL_EXPORTER_OTLP_ENDPOINT", () => {
    const authorities = otlpEndpointAuthorities({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://otelcol.observability:4318",
    });
    expect(authorities.has("otelcol.observability:4318")).toBe(true);
  });

  it("includes a signal-specific OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", () => {
    const authorities = otlpEndpointAuthorities({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector.traces:4318",
    });
    expect(authorities.has("collector.traces:4318")).toBe(true);
  });

  it("skips a malformed endpoint without throwing", () => {
    expect(() =>
      otlpEndpointAuthorities({ OTEL_EXPORTER_OTLP_ENDPOINT: "not a url" }),
    ).not.toThrow();
    const authorities = otlpEndpointAuthorities({
      OTEL_EXPORTER_OTLP_ENDPOINT: "not a url",
    });
    // Still gets the two hardcoded defaults, just not the malformed one.
    expect(authorities.has("localhost:4318")).toBe(true);
    expect(authorities.has("localhost:4317")).toBe(true);
  });

  it("includes a signal-specific OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", () => {
    const authorities = otlpEndpointAuthorities({
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://collector.logs:4318",
    });
    expect(authorities.has("collector.logs:4318")).toBe(true);
  });

  it("unbrackets an IPv6 literal endpoint", () => {
    const authorities = otlpEndpointAuthorities({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://[::1]:4318",
    });
    expect(authorities.has("::1:4318")).toBe(true);
    expect(authorities.has("[::1]:4318")).toBe(false);
  });
});

describe("shouldIgnoreOutgoingRequest", () => {
  const authorities = otlpEndpointAuthorities({});

  it("ignores the exporter's own endpoint (hostname + numeric port)", () => {
    expect(
      shouldIgnoreOutgoingRequest({ hostname: "localhost", port: 4318 }, authorities),
    ).toBe(true);
  });

  it("does not ignore a real dependency call", () => {
    expect(
      shouldIgnoreOutgoingRequest({ hostname: "api.example.com", port: 443 }, authorities),
    ).toBe(false);
  });

  it("falls back to `host` carrying the port when `hostname` is absent", () => {
    expect(shouldIgnoreOutgoingRequest({ host: "localhost:4318" }, authorities)).toBe(true);
  });

  it("returns false when no host can be determined", () => {
    expect(shouldIgnoreOutgoingRequest({}, authorities)).toBe(false);
  });

  describe("IPv6 literal endpoint (regression: bracket mismatch)", () => {
    const ipv6Authorities = otlpEndpointAuthorities({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://[::1]:4318",
    });

    it("matches an unbracketed hostname (as Node's urlToHttpOptions delivers it)", () => {
      expect(
        shouldIgnoreOutgoingRequest({ hostname: "::1", port: 4318 }, ipv6Authorities),
      ).toBe(true);
    });

    // These two exercise the `host`-fallback path in isolation. The
    // authority set is a HAND-BUILT literal — deliberately NOT derived from
    // `otlpEndpointAuthorities` — because a set built that way can hide a
    // broken host parser: if `toAuthority` ever regressed to keeping
    // brackets too, the set would contain the literal "[::1]:4318", and a
    // buggy host parser that (wrongly) extracts "[" as the hostname would
    // still pass, since "[::1]:4318".startsWith("[:") is true — a
    // coincidental match that proves nothing about the parser under test.
    // A literal, always-unbracketed set removes that escape hatch: these
    // two can only pass if `extractHostname`/`stripBrackets` on the `host`
    // fallback path are themselves correct.
    describe("host-fallback path, authority set isolated from otlpEndpointAuthorities", () => {
      const literalAuthorities = new Set(["::1:4318", "localhost:4318", "example.com:9999"]);

      it("matches a bracketed `host` string carrying a port", () => {
        expect(
          shouldIgnoreOutgoingRequest({ host: "[::1]:4318" }, literalAuthorities),
        ).toBe(true);
      });

      it("matches a bracketed `host` string with no port (hostname-only match)", () => {
        expect(
          shouldIgnoreOutgoingRequest({ host: "[::1]" }, literalAuthorities),
        ).toBe(true);
      });
    });

    it("does not ignore a different IPv6 destination", () => {
      expect(
        shouldIgnoreOutgoingRequest({ hostname: "2001:db8::1", port: 443 }, ipv6Authorities),
      ).toBe(false);
    });
  });
});
