import {
  Global,
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { healthTracingMiddleware } from "./health-tracing.middleware.js";
import { buildPinoOptions } from "./pino-otel.js";

/**
 * Global module that routes NestJS's logger through pino and, when the OTLP log
 * path is enabled, bridges it into the OTel `LoggerProvider` (see `pino-otel.ts`).
 *
 * Import this **once at the app root** (not via `McpModule.forFeature`): it
 * registers pino-http's request-logging middleware, which must be installed
 * exactly once — importing it per MCP endpoint would log every request twice.
 * It also registers `healthTracingMiddleware`, which suppresses span creation
 * for health-probe requests app-wide (see that file's docs).
 *
 * The host app must also call `NestFactory.create(AppModule, { bufferLogs: true })`
 * and `app.useLogger(app.get(Logger))` for this to take effect — otherwise pino
 * is configured but Nest keeps its default console logger.
 */
@Global()
@Module({})
export class McpLoggerModule implements NestModule {
  static forRoot(): DynamicModule {
    return {
      module: McpLoggerModule,
      imports: [LoggerModule.forRoot(buildPinoOptions())],
      exports: [LoggerModule],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(healthTracingMiddleware).forRoutes("*");
  }
}
