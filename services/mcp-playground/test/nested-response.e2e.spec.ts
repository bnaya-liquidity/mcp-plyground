import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { McpModule } from "@playground/nestjs-mcp";
import request from "supertest";
import { NestedResponseTools } from "../src/tools/nested-response.tools.js";
import { MCP_ROUTE, SERVER_INFO } from "../src/app.module.js";

// See fire-forget.e2e.spec.ts for why AppModule itself is not used here.
const ACCEPT = "application/json, text/event-stream";

interface JsonRpcResponse {
  result: {
    content?: { type: string; text: string }[];
    isError?: boolean;
  };
}

const rpc = (
  method: string,
  params: Record<string, unknown> = {},
): Record<string, unknown> => ({ jsonrpc: "2.0", id: 1, method, params });

function parseBody(text: string): JsonRpcResponse {
  if (!text.includes("event:")) return JSON.parse(text) as JsonRpcResponse;
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(line!.slice("data:".length).trim()) as JsonRpcResponse;
}

describe("mcp-playground nested-response endpoint", () => {
  let app: INestApplication;
  let tools: NestedResponseTools;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        McpModule.forFeature({
          route: MCP_ROUTE,
          serverInfo: SERVER_INFO,
          toolProviders: [NestedResponseTools],
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    tools = app.get(NestedResponseTools);
  });

  afterAll(async () => {
    await tools.drain();
    await app.close();
  });

  const post = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post(`/${MCP_ROUTE}`)
      .set("Accept", ACCEPT)
      .set("Content-Type", "application/json")
      .send(body);

  it("answers with the first detached job's result, written directly to the transport", async () => {
    const res = await post(
      rpc("tools/call", { name: "nested-response", arguments: { message: "hello" } }),
    );
    expect(res.status).toBe(200);

    const { content, isError } = parseBody(res.text).result;
    expect(isError).toBeUndefined();
    // jobId 1 has no artificial delay; jobId 2 is forced to 500ms, so job 1
    // always wins the race to answer the call.
    expect(content![0]!.text).toMatch(/^Root: Job jobId 1: hello completed in 0 ms$/);

    await tools.drain();
  });

  it("rejects invalid input without accepting a call", async () => {
    const res = await post(
      rpc("tools/call", { name: "nested-response", arguments: { message: "" } }),
    );
    expect(res.status).toBe(200);

    const { content, isError } = parseBody(res.text).result;
    expect(isError).toBe(true);
    const payload = JSON.parse(content![0]!.text) as {
      code: string;
      httpStatusHint: number;
    };
    expect(payload).toMatchObject({ code: "VALIDATION_ERROR", httpStatusHint: 422 });
  });
});
