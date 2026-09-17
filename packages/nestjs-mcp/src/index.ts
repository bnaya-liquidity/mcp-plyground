import "reflect-metadata";

export { McpTool } from "./mcp-tool.decorator.js";
export type { McpToolOptions, McpToolMetadata } from "./mcp-tool.types.js";
export { McpModule } from "./mcp.module.js";
export type { McpFeatureOptions } from "./mcp.module.js";
export { McpRegistryService, McpToolInputError } from "./mcp-registry.service.js";
export type { RegisteredTool } from "./mcp-registry.service.js";
export type { McpServerInfo } from "./mcp-server.factory.js";
export {
  runWithRequestContext,
  getMcpRequestContext,
  getRequestHeader,
  getMcpTransport,
  getMcpRequestId,
} from "./mcp-request-context.js";
export type { McpRequestContext } from "./mcp-request-context.js";
export { DEFERRED_RESPONSE, isDeferredResponse } from "./mcp-deferred-response.js";
export { initTelemetry, otelLogsEnabled, OtelPinoStream } from "@playground/otel-extensions";
export type { TelemetryShutdown } from "@playground/otel-extensions";
export { McpTelemetryModule } from "./telemetry/mcp-telemetry.module.js";
export type { McpTelemetryOptions } from "./telemetry/mcp-telemetry.module.js";
export { TelemetryShutdownService } from "./telemetry/telemetry-shutdown.service.js";
export { McpLoggerModule } from "./telemetry/mcp-logger.module.js";
export { buildPinoOptions } from "./telemetry/pino-otel.js";
// Re-export nestjs-pino's Logger so host apps can `app.useLogger(app.get(Logger))`.
export { Logger } from "nestjs-pino";
export { parseMcpBody } from "./mcp-jsonrpc-body.js";
export type { McpClientInfo, McpRequestSummary } from "./mcp-jsonrpc-body.js";
export { endpointLabel } from "./mcp-server.factory.js";
