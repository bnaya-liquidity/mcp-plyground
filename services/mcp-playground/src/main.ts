import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@playground/nestjs-mcp";
import { AppModule, MCP_ROUTE } from "./app.module.js";

const DEFAULT_PORT = 3000;

async function bootstrap(): Promise<void> {
  // bufferLogs + useLogger: without both, McpLoggerModule configures pino but
  // Nest keeps its own console logger and nothing reaches the OTel log stream.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  await app.listen(port);
  app.get(Logger).log(`MCP endpoint listening on http://localhost:${port}/${MCP_ROUTE}`);
}

void bootstrap();
