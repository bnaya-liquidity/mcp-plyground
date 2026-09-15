import { Global, Module, type DynamicModule } from "@nestjs/common";
import { initTelemetry } from "@playground/otel-extensions";
import { TelemetryShutdownService } from "./telemetry-shutdown.service.js";

export interface McpTelemetryOptions {
  /** Default `service.name` for the OTel resource (overridden by `OTEL_SERVICE_NAME`). */
  serviceName: string;
}

/** DI token whose factory eagerly boots the OTel SDK during module init. */
const TELEMETRY_BOOTSTRAP = Symbol("MCP_TELEMETRY_BOOTSTRAP");

/**
 * Global module that boots the OTel SDK and owns its shutdown. Imported
 * automatically by `McpModule.forFeature()`, so any MCP server built on this
 * framework is instrumented with no extra wiring. The SDK is a process-wide
 * singleton, so importing this module more than once (e.g. read + write
 * endpoints) initializes telemetry exactly once.
 */
@Global()
@Module({})
export class McpTelemetryModule {
  static forRoot(options: McpTelemetryOptions): DynamicModule {
    return {
      module: McpTelemetryModule,
      providers: [
        TelemetryShutdownService,
        {
          provide: TELEMETRY_BOOTSTRAP,
          useFactory: (shutdownSvc: TelemetryShutdownService) => {
            shutdownSvc.register(initTelemetry(options.serviceName));
            return true;
          },
          inject: [TelemetryShutdownService],
        },
      ],
      exports: [TelemetryShutdownService],
    };
  }
}
