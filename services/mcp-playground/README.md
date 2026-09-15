# @playground/mcp-playground

MCP service built on `@playground/nestjs-mcp`, exposing a single tool: `fire-forget`.

## Run

```bash
pnpm install
pnpm run build
PORT=3000 pnpm --filter @playground/mcp-playground run start
```

The MCP endpoint is `POST http://localhost:3000/mcp`. `GET` and `DELETE` return 405 —
the transport is stateless Streamable HTTP, no sessions and no SSE stream.

Telemetry boots automatically (`McpModule.forFeature` imports `McpTelemetryModule`).
Set `OTEL_SDK_DISABLED=true` to run without an OTLP endpoint, or point
`OTEL_EXPORTER_OTLP_ENDPOINT` at a collector.

## The `fire-forget` tool

| Field     | Type                  | Required | Notes                             |
| --------- | --------------------- | -------- | --------------------------------- |
| `message` | string, min length 1  | yes      | Payload handed to the job.        |
| `delayMs` | integer, 0–60000      | no       | Simulated work duration.          |

Returns `{ "accepted": true, "jobId": "<uuid>" }` immediately. The work runs after the
response is sent and is never awaited by the caller.

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fire-forget","arguments":{"message":"hello","delayMs":1500}}}'
```

### Trace shape

The detached job gets its own ROOT span carrying a LINK back to the accepting request —
not a child span. A parent span cannot end before its children, so parenting the job to
the request would stretch the request span across the job's whole lifetime and corrupt
every latency percentile derived from it. See `withConsumerSpan` in
`@playground/otel-extensions`.

Invalid input never reaches the handler: the Zod schema is validated first and the call
returns `isError: true` with `{"code":"VALIDATION_ERROR","httpStatusHint":422}`.

## Health endpoints

`GET /health` (liveness) and `GET /health/ready` (readiness) return
`200 {"status":"ok"}`. Both are unconditional because this service has no
downstream dependency to check — see [.deploy/README.md](../../.deploy/README.md)
for why that matters and what else depends on these exact paths.

## Deployment

Docker image, Compose stack and Helm chart: [.deploy/README.md](../../.deploy/README.md).

```bash
pnpm run docker:up          # app + otelcol + aspire on localhost
pnpm run install:k8s        # Docker Desktop Kubernetes
pnpm run uninstall:k8s      # tear it down again
```

## Tests

```bash
pnpm --filter @playground/mcp-playground run test
```

`test/nestjs-pino.stub.ts` replaces `nestjs-pino` under jest — the real package is
CJS-only, `@nestjs/common@12` is ESM-only, and their `require(esm)` cycle is rejected by
jest-runtime (real Node loads it fine). **Log wiring is therefore not covered by these
tests**; verify it by running the service.
