import {
  Controller,
  Inject,
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
  type Type,
} from "@nestjs/common";
import { MetadataScanner } from "@nestjs/core";
import { McpController } from "./mcp.controller.js";
import { McpRegistryService } from "./mcp-registry.service.js";
import { MCP_FEATURE_OPTIONS, MCP_TOOL_PROVIDERS } from "./mcp.constants.js";
import type { McpServerInfo } from "./mcp-server.factory.js";
import { McpTelemetryModule } from "./telemetry/mcp-telemetry.module.js";
import { McpRequestContextMiddleware } from "./mcp-request-context.middleware.js";

export interface McpFeatureOptions {
  /** HTTP route the MCP endpoint binds to, e.g. "read/mcp". No leading slash. */
  route: string;
  /** Identity advertised in the MCP initialize handshake. */
  serverInfo: McpServerInfo;
  /** Tool provider classes to register with this MCP endpoint (scoped to this module). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolProviders?: Type<any>[];
}

@Module({})
export class McpModule implements NestModule {
  constructor(@Inject(MCP_FEATURE_OPTIONS) private readonly options: McpFeatureOptions) {}

  /**
   * Binds the request context (headers + raw `res`) for this endpoint's
   * route, so tools can write their response directly (`writeMcpResponse`).
   * Each `forFeature` import is its own module instance with its own options,
   * so every endpoint binds only its own route.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(McpRequestContextMiddleware).forRoutes(this.options.route);
  }

  static forFeature(options: McpFeatureOptions): DynamicModule {
    @Controller(options.route)
    class RouteBoundMcpController extends McpController {}

    const { toolProviders = [] } = options;

    return {
      module: McpModule,
      // Telemetry is a built-in capability: importing an MCP feature auto-boots
      // the OTel SDK (idempotent — safe across multiple endpoints in one process).
      // Logging (McpLoggerModule) is imported once at the app root instead — its
      // pino-http middleware must register exactly once, not per endpoint.
      imports: [McpTelemetryModule.forRoot({ serviceName: options.serverInfo.name })],
      controllers: [RouteBoundMcpController],
      providers: [
        MetadataScanner,
        ...toolProviders,
        McpRegistryService,
        { provide: MCP_FEATURE_OPTIONS, useValue: options },
        {
          provide: MCP_TOOL_PROVIDERS,
          useFactory: (...instances: object[]) => instances,
          inject: toolProviders,
        },
      ],
      exports: [McpRegistryService],
    };
  }
}
