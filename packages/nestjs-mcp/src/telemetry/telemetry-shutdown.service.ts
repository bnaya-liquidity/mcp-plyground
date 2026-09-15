import { Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import type { TelemetryShutdown } from "@playground/otel-extensions";

/**
 * Holds the OTel SDK shutdown handle and flushes it when the Nest application
 * shuts down. Requires `app.enableShutdownHooks()` so `OnApplicationShutdown`
 * fires on SIGTERM/SIGINT.
 */
@Injectable()
export class TelemetryShutdownService implements OnApplicationShutdown {
  private readonly logger = new Logger(TelemetryShutdownService.name);
  private shutdownFn: TelemetryShutdown | null = null;

  register(fn: TelemetryShutdown): void {
    this.shutdownFn = fn;
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Shutting down (${signal ?? "unknown"}); flushing telemetry`);
    if (this.shutdownFn) await this.shutdownFn();
  }
}
