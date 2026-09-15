// QUARANTINED — this suite is excluded from the Jest run via
// `testPathIgnorePatterns` in jest.config.mjs. It fails at import time under
// jest-runtime: @nestjs/common@12 is ESM-only, nestjs-pino@5 is CJS-only and
// require()s it in a cycle. Real Node loads the same graph fine, so production
// is unaffected. While parked it is type-checked by NOTHING — see
// jest.config.mjs for the full rationale, the coverage hole, and re-enable steps.
// libs/nestjs-mcp/src/telemetry/mcp-logger.module.spec.ts
import { Test } from "@nestjs/testing";
import { logs } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { Logger } from "nestjs-pino";
import { McpLoggerModule } from "./mcp-logger.module.js";

const ORIGINAL_ENV = { ...process.env };

describe("McpLoggerModule (integration)", () => {
  let exporter: InMemoryLogRecordExporter;
  let provider: LoggerProvider;

  beforeEach(() => {
    // OTLP log path on (default) so buildPinoOptions wires the OtelPinoStream.
    delete process.env.OTEL_LOGS_EXPORTER;
    delete process.env.OTEL_SDK_DISABLED;
    exporter = new InMemoryLogRecordExporter();
    provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter })],
    });
    logs.setGlobalLoggerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    logs.disable();
    process.env = { ...ORIGINAL_ENV };
  });

  it("routes a NestJS log through pino into the OTel LoggerProvider", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [McpLoggerModule.forRoot()],
    }).compile();
    const app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useLogger(app.get(Logger));
    await app.init();

    app.get(Logger).log("hello from nest", "IntegrationTest");

    await provider.forceFlush();
    const records = exporter.getFinishedLogRecords();
    const match = records.find((r) => r.body === "hello from nest");
    expect(match).toBeDefined();

    await app.close();
  });
});
