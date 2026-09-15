/** The client identity an MCP `initialize` request advertises. */
export interface McpClientInfo {
  name: string;
  version: string;
}

/** What the telemetry layers need to know about one MCP POST body. */
export interface McpRequestSummary {
  /** JSON-RPC method, e.g. `initialize`, `tools/list`, `tools/call`. */
  method?: string;
  /** Tool name, present only for a `tools/call`. */
  toolName?: string;
  /** Client identity, present only for an `initialize`. */
  clientInfo?: McpClientInfo;
}

interface RawBody {
  readonly method?: unknown;
  readonly params?: { readonly name?: unknown; readonly clientInfo?: unknown };
}

function readClientInfo(value: unknown): McpClientInfo | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { name, version } = value as { name?: unknown; version?: unknown };
  return typeof name === "string" && typeof version === "string"
    ? { name, version }
    : undefined;
}

/**
 * Parses an MCP POST body into the fields the telemetry layers need.
 *
 * This is the SINGLE body-inspection point in the package. Both the pino-http
 * message builder and the controller's span/log enrichment read from it — two
 * independent sniffers would drift, and the drift would be invisible because
 * each would keep satisfying its own caller.
 *
 * Returns an empty summary (never throws) for anything that is not a
 * well-formed JSON-RPC object: health probes and the 405 fallback flow through
 * here too.
 */
export function parseMcpBody(body: unknown): McpRequestSummary {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const { method, params } = body as RawBody;
  if (typeof method !== "string") return {};

  const summary: McpRequestSummary = { method };
  if (method === "tools/call" && typeof params?.name === "string") {
    summary.toolName = params.name;
  }
  if (method === "initialize") {
    const clientInfo = readClientInfo(params?.clientInfo);
    if (clientInfo) summary.clientInfo = clientInfo;
  }
  return summary;
}
