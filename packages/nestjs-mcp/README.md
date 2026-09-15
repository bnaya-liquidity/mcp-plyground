# @playground/nestjs-mcp

Auth-free NestJS ⇄ MCP integration on the official SDK, stateless Streamable HTTP.

---

## Install

```bash
npm i @playground/nestjs-mcp
```

**Peer dependencies** (install separately):

```bash
npm i @nestjs/common @nestjs/core reflect-metadata rxjs
```

---

## Quick start

```typescript
import { Injectable, Module } from "@nestjs/common";
import { McpTool, McpModule } from "@playground/nestjs-mcp";
import { z } from "zod";

@Injectable()
class CalcTools {
  @McpTool({
    name: "add",
    description: "Add two numbers",
    inputSchema: z.object({ a: z.number(), b: z.number() }),
  })
  add(input: { a: number; b: number }): { sum: number } {
    return { sum: input.a + input.b };
  }
}

@Module({
  imports: [
    McpModule.forFeature({
      route: "calc/mcp",
      serverInfo: { name: "calc", version: "1.0.0" },
    }),
  ],
  providers: [CalcTools],
})
export class CalcModule {}
```

Then `POST /calc/mcp` with a JSON-RPC `tools/list` or `tools/call` body and
`Accept: application/json, text/event-stream`.

---

## The `inputSchema` contract

Each `@McpTool` decorator accepts an `inputSchema` property that must be a **Zod schema**
(typically `z.object({ … })`).

The library uses this schema in two ways:

1. **`tools/list`** — the schema is converted to JSON Schema (via `zod-to-json-schema`) and
   advertised as the tool's `inputSchema` in the MCP response.
2. **`tools/call`** — the incoming arguments are validated against the same Zod schema before
   the handler is invoked. Invalid input returns an MCP error (code `-32602 Invalid params`)
   instead of reaching your handler.

### `z.union` → `anyOf`

When your schema uses `z.union([…])`, the JSON Schema emitted for `tools/list` will contain
an `anyOf` array. MCP clients that follow the JSON Schema spec will accept input matching
any of the union branches; validation at call time applies the same Zod union logic.

```typescript
const schema = z.object({
  value: z.union([z.string(), z.number()]),
});
// tools/list advertises: { "value": { "anyOf": [{ "type": "string" }, { "type": "number" }] } }
```

---

## Request lifecycle

```
Module init (once)
  └── McpRegistryService discovers all @McpTool-decorated providers
        and caches the tool list.

POST /your/route
  └── McpController receives the JSON-RPC request.
        ├── Creates a fresh MCP Server instance (no shared state).
        ├── Attaches a stateless StreamableHTTPServerTransport.
        ├── Handles the request (tools/list or tools/call).
        └── Sends the response and discards the Server + transport.

GET  /your/route  →  405 Method Not Allowed
DELETE /your/route →  405 Method Not Allowed
```

Key properties:

- **Discovery is performed once** at module initialisation (NestJS `OnModuleInit`) and the
  result is cached for the lifetime of the process. No per-request reflection.
- **Each POST creates a fresh `Server` + transport.** There is no session, no persistent
  connection, and no in-memory state carried between requests.
- **`GET` and `DELETE` are rejected with 405.** SSE streaming and session-based transports
  are not supported.

---

## Non-goals

This library intentionally ships **no authentication, no guards, and no sessions**.

- **No auth middleware** — the library does not inspect tokens, API keys, or any
  credential. Authentication belongs to the gateway (reverse proxy, API gateway, or a
  NestJS global guard you register yourself).
- **No sessions / SSE** — every request is fully stateless. Long-running streaming
  connections are out of scope.
- **No built-in guards or interceptors** — the MCP route is a plain NestJS controller.
  You MAY attach your own `@UseGuards(…)` or `@UseInterceptors(…)` to the feature module
  or at the application level; the library does not conflict with them.

If you need per-route auth, wrap the module in a NestJS guard at the application level or
use your infrastructure layer.

---

## Attribution

Design inspired by [`@rekog/mcp-nest`](https://github.com/rekog-labs/MCP-Nest) (MIT).
This is a clean-room implementation built directly on the
[official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk),
not a fork or copy of `@rekog/mcp-nest`.
