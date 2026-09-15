// libs/nestjs-mcp/src/telemetry/pino-otel.ts
import { buildPinoDestination, buildPinoLoggerOptions } from "@playground/otel-extensions";
import type { Params } from "nestjs-pino";
import type { LevelWithSilent } from "pino";
import { parseMcpBody } from "../mcp-jsonrpc-body.js";

function isHealthCheckPath(url: string | undefined): boolean {
  return ((url ?? "").split("?")[0] ?? "").startsWith("/health");
}

/**
 * pino-http `customLogLevel` for health-probe requests (liveness `/health`,
 * readiness `/health/ready`): `trace` on success — below `buildPinoLoggerOptions`'s
 * `debug` floor, so it never reaches stdout or the OTel log stream — and
 * `error` on failure, so a failing probe is never silent. Every other route
 * gets `info` unconditionally, matching pino-http's own default when no
 * `customLogLevel` is configured (this function replaces that default
 * app-wide, so it must reproduce it for non-health paths).
 *
 * A pre-response `autoLogging.ignore` (an earlier approach here) can't
 * express "log only on failure": pino-http decides whether to ignore a
 * request before its response — and thus its status — is known, so it can
 * only silence a path outright, swallowing its errors too. Span creation for
 * these requests is suppressed separately by `healthTracingMiddleware`.
 */
function healthAwareLogLevel(
  req: { url?: string },
  res: { statusCode?: number },
  err?: Error,
): LevelWithSilent {
  if (!isHealthCheckPath(req.url)) return "info";
  const failed = Boolean(err) || (res.statusCode ?? 200) >= 400;
  return failed ? "error" : "trace";
}

/**
 * Identifies the JSON-RPC call inside an MCP POST body: the tool name for a
 * `tools/call`, or the bare method (`tools/list`, `initialize`, ...)
 * otherwise. Returns `undefined` for non-MCP requests (health probes, the
 * 405 fallback) so `requestSummary` falls back to just method + URL.
 */
function describeMcpTarget(body: unknown): string | undefined {
  const { method, toolName } = parseMcpBody(body);
  if (method === undefined) return undefined;
  return toolName !== undefined ? `tools/call:${toolName}` : method;
}

/**
 * `${METHOD} ${URL} [target]` used by both success/error messages below, so a
 * DataDog log list (which shows `msg` by default) reads e.g.
 * `POST /read/mcp [tools/call:execute_cypher] completed` instead of the
 * generic pino-http default of just "request completed".
 */
function requestSummary(req: { method?: string; url?: string; body?: unknown }): string {
  const target = describeMcpTarget(req.body);
  const base = `${req.method ?? ""} ${req.url ?? ""}`.trim();
  return target ? `${base} [${target}]` : base;
}

function mcpSuccessMessage(req: {
  method?: string;
  url?: string;
  body?: unknown;
}): string {
  return `${requestSummary(req)} completed`;
}

function mcpErrorMessage(req: { method?: string; url?: string; body?: unknown }): string {
  return `${requestSummary(req)} errored`;
}

/**
 * Builds the `nestjs-pino` params: stdout always, OTel appender when enabled
 * (see `@playground/otel-extensions`'s `buildPinoLoggerOptions`/`buildPinoDestination`
 * for the shared, framework-agnostic logic), plus `healthAwareLogLevel` so
 * routine health-probe traffic doesn't flood the log stream while a failing
 * probe still surfaces, and `mcpSuccessMessage`/`mcpErrorMessage` so the log
 * `msg` names the request's target (path + MCP tool, where applicable)
 * instead of pino-http's generic "request completed"/"request errored".
 *
 * `loggerName: "nestjs-mcp"` preserves the OTel instrumentation-scope name
 * this package has always emitted under.
 */
export function buildPinoOptions(): Params {
  const options = {
    ...buildPinoLoggerOptions(),
    customLogLevel: healthAwareLogLevel,
    customSuccessMessage: mcpSuccessMessage,
    customErrorMessage: mcpErrorMessage,
  };
  return { pinoHttp: [options, buildPinoDestination({ loggerName: "nestjs-mcp" })] };
}
