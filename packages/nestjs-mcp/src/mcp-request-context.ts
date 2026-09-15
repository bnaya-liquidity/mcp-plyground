import { AsyncLocalStorage } from "node:async_hooks";

export interface McpRequestContext {
  headers: Record<string, string | string[] | undefined>;
}

const store = new AsyncLocalStorage<McpRequestContext>();

export function runWithRequestContext<T>(ctx: McpRequestContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export function getMcpRequestContext(): McpRequestContext | undefined {
  return store.getStore();
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
