import type { IncomingMessage, ServerResponse } from "node:http";
import { Injectable, type NestMiddleware } from "@nestjs/common";
import { runWithRequestContext } from "./mcp-request-context.js";

/**
 * Binds the request's headers and raw HTTP response to the MCP request
 * context (AsyncLocalStorage) before the controller runs — the Node analogue
 * of .NET's `AsyncLocal<HttpContext>`. Everything further down the request's
 * async chain, including detached jobs it spawns, can then reach `res` via
 * `getMcpRequestContext()` without it being passed as a parameter.
 *
 * Applied to the MCP route by `McpModule.forFeature`; host apps do not wire it.
 */
@Injectable()
export class McpRequestContextMiddleware
  implements NestMiddleware<IncomingMessage, ServerResponse>
{
  use(req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void {
    runWithRequestContext({ headers: req.headers, res }, () => next());
  }
}
