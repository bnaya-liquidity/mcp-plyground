import { Module } from "@nestjs/common";
import { McpLoggerModule, McpModule } from "@playground/nestjs-mcp";
import { FireForgetTools } from "./fire-forget.tools.js";
import { HealthController } from "./health.controller.js";

export const SERVER_INFO = {
  name: "mcp-playground",
  version: "0.1.0",
} as const;

/** HTTP route the MCP endpoint binds to. No leading slash. */
export const MCP_ROUTE = "mcp";

@Module({
  imports: [
    // Logging is registered once at the app root: its pino-http middleware must
    // install exactly once, unlike telemetry which McpModule.forFeature boots.
    McpLoggerModule.forRoot(),
    McpModule.forFeature({
      route: MCP_ROUTE,
      serverInfo: SERVER_INFO,
      toolProviders: [FireForgetTools],
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
