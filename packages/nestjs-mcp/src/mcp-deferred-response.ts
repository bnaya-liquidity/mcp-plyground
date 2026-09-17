/**
 * Sentinel a tool method returns to mean "I'm answering this call myself,
 * later, via `transport.send(..., {relatedRequestId})` — don't send anything
 * for my return value."
 *
 * There is no supported way to make the SDK's `Server` stay silent after a
 * `CallToolRequestSchema` handler settles: it always sends whatever the
 * handler resolves or rejects with. `buildMcpServer` honors this sentinel by
 * never settling its own promise for that call, so the SDK's auto-send never
 * fires — a detached job's own `transport.send` becomes the only response.
 * That means the request's span and the pending promise this leaves behind
 * are permanent for the lifetime of the process; use this only where a job
 * is guaranteed to answer (see `nested-response.tools.ts`).
 */
export const DEFERRED_RESPONSE = Symbol("mcp.deferredResponse");

export function isDeferredResponse(value: unknown): value is typeof DEFERRED_RESPONSE {
  return value === DEFERRED_RESPONSE;
}
