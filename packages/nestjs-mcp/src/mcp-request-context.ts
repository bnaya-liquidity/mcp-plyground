import { AsyncLocalStorage } from "node:async_hooks";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";

export interface McpRequestContext {
  headers: Record<string, string | string[] | undefined>;
  /**
   * The transport for the in-flight POST, and the JSON-RPC id of the current
   * `tools/call` request. Set once both are known (the controller creates the
   * transport, `buildMcpServer`'s CallTool handler learns the request id) so a
   * detached job can answer the call directly via `transport.send(...,
   * {relatedRequestId})` instead of through the handler's return value.
   */
  transport?: Transport;
  requestId?: RequestId;
}

const store = new AsyncLocalStorage<McpRequestContext>();

export function runWithRequestContext<T>(ctx: McpRequestContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export function getMcpRequestContext(): McpRequestContext | undefined {
  return store.getStore();
}

/** Returns the transport for the in-flight MCP POST, if one has been set. */
export function getMcpTransport(): Transport | undefined {
  return store.getStore()?.transport;
}

/** Returns the JSON-RPC request id of the current `tools/call`, if known. */
export function getMcpRequestId(): RequestId | undefined {
  return store.getStore()?.requestId;
}

/**
 * Read an HTTP header from the current MCP request context.
 * Returns the raw value — `string`, `string[]`, or `undefined`.
 */
export function getRequestHeader(name: string): string | undefined {
  const ctx = store.getStore();
  if (!ctx) return undefined;

  const value = ctx.headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    const ids = value
      .map((s: string) => {
        const trimmed = s.trim();
        if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
          return trimmed.slice(1, -1);
        }
        return trimmed;
      })
      .filter(Boolean);
    if (ids.length == 0) return undefined;
    return ids.join(",");
  }

  return value;
}
