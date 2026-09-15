import { Module, type DynamicModule } from "@nestjs/common";

/**
 * Jest-only stand-in for `nestjs-pino`, wired in via `moduleNameMapper`.
 *
 * WHY: `nestjs-pino@5` is CJS-only and `@nestjs/common@12` is ESM-only, and
 * nestjs-pino's `index.js -> InjectPinoLogger.js` graph `require()`s
 * `@nestjs/common` in a cycle. jest-runtime rejects `require(esm)` in a cycle;
 * real Node imports the same graph without complaint. So this is a test-runtime
 * limitation, NOT a production defect — `@playground/nestjs-mcp` carries the
 * same quarantine note in its own jest config.
 *
 * Merely importing anything from the `@playground/nestjs-mcp` barrel drags
 * nestjs-pino in, because the barrel re-exports `McpLoggerModule` and `Logger`.
 * These specs exercise the MCP request path, which does not involve logging, so
 * the stub is loaded instead of the real package.
 *
 * LIMIT: nothing here asserts anything about logging. Log wiring is verified by
 * running the service for real (`pnpm --filter @playground/mcp-playground start`),
 * not by this suite. Delete this file once nestjs-pino ships an ESM build.
 */
@Module({})
export class LoggerModule {
  static forRoot(): DynamicModule {
    return { module: LoggerModule };
  }
}

/** Matches the subset of `nestjs-pino`'s Logger that the barrel re-exports. */
export class Logger {
  log(): void {}
  error(): void {}
  warn(): void {}
  debug(): void {}
  verbose(): void {}
}

export class PinoLogger {
  log(): void {}
  error(): void {}
  warn(): void {}
  debug(): void {}
}

export type Params = Record<string, unknown>;
