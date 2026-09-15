// libs/nestjs-mcp/src/telemetry/mcp-telemetry.module.spec.ts
import "reflect-metadata";
import { jest } from "@jest/globals";
import { Test } from "@nestjs/testing";
import { McpTelemetryModule } from "./mcp-telemetry.module.js";
import { TelemetryShutdownService } from "./telemetry-shutdown.service.js";

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("TelemetryShutdownService", () => {
  it("invokes the registered shutdown fn on application shutdown", async () => {
    const svc = new TelemetryShutdownService();
    const fn = jest.fn(() => Promise.resolve());
    svc.register(fn);

    await svc.onApplicationShutdown("SIGTERM");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when nothing is registered", async () => {
    const svc = new TelemetryShutdownService();
    await expect(svc.onApplicationShutdown()).resolves.toBeUndefined();
  });
});

describe("McpTelemetryModule", () => {
  it("provides TelemetryShutdownService and boots the SDK on init (disabled in test)", async () => {
    process.env.OTEL_SDK_DISABLED = "true";

    const moduleRef = await Test.createTestingModule({
      imports: [McpTelemetryModule.forRoot({ serviceName: "spec-service" })],
    }).compile();
    await moduleRef.init();

    const svc = moduleRef.get(TelemetryShutdownService);
    expect(svc).toBeInstanceOf(TelemetryShutdownService);

    // Shutdown wired by the module flushes cleanly (no-op in disabled mode).
    await expect(moduleRef.close()).resolves.toBeUndefined();
  });
});
