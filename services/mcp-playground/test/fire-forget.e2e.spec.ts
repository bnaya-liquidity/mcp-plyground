import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { McpModule } from "@playground/nestjs-mcp";
import request from "supertest";
import { FireForgetTools } from "../src/fire-forget.tools.js";
import { MCP_ROUTE, SERVER_INFO } from "../src/app.module.js";

// AppModule itself is deliberately NOT used here: it imports McpLoggerModule,
// whose nestjs-pino -> @nestjs/common graph cannot be loaded by jest-runtime
// (nestjs-pino is CJS-only, @nestjs/common@12 is ESM-only, and the require()
// lands in a cycle). Real Node loads it fine. This suite covers the MCP wiring,
// which is independent of the logger.
const ACCEPT = "application/json, text/event-stream";

interface JsonRpcResponse {
  result: {
    tools?: { name: string; description: string; inputSchema: Record<string, unknown> }[];
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

describe("mcp-playground fire-forget endpoint", () => {
  let app: INestApplication;
  let tools: FireForgetTools;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        McpModule.forFeature({
          route: MCP_ROUTE,
          serverInfo: SERVER_INFO,
          toolProviders: [FireForgetTools],
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    tools = app.get(FireForgetTools);
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

  it("advertises fire-forget with its input schema", async () => {
    const res = await post(rpc("tools/list"));
    expect(res.status).toBe(200);

    const listed = parseBody(res.text).result.tools ?? [];
    expect(listed).toHaveLength(1);
    const [tool] = listed;
    expect(tool!.name).toBe("fire-forget");
    expect(tool!.inputSchema).toMatchObject({
      type: "object",
      required: ["message"],
    });
    expect(Object.keys(tool!.inputSchema.properties as object).sort()).toEqual([
      "delayMs",
      "message",
    ]);
  });

  it("accepts a call and returns a job id", async () => {
    const res = await post(
      rpc("tools/call", { name: "fire-forget", arguments: { message: "hello" } }),
    );
    expect(res.status).toBe(200);

    const { content, isError } = parseBody(res.text).result;
    expect(isError).toBeUndefined();
    const payload = JSON.parse(content![0]!.text) as { accepted: boolean; jobId: string };
    expect(payload.accepted).toBe(true);
    expect(payload.jobId).toMatch(/^[0-9a-f-]{36}$/);

    await tools.drain();
  });

  it("responds before the detached job finishes", async () => {
    const startedAt = Date.now();
    const res = await post(
      rpc("tools/call", {
        name: "fire-forget",
        arguments: { message: "slow", delayMs: 400 },
      }),
    );
    const elapsed = Date.now() - startedAt;

    expect(res.status).toBe(200);
    expect(parseBody(res.text).result.isError).toBeUndefined();
    // The response must not have waited on the 400ms job.
    expect(elapsed).toBeLessThan(300);

    await tools.drain();
  });

  it("rejects invalid input without running a job", async () => {
    const res = await post(
      rpc("tools/call", { name: "fire-forget", arguments: { message: "" } }),
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

  it("rejects GET with 405", async () => {
    const res = await request(app.getHttpServer()).get(`/${MCP_ROUTE}`);
    expect(res.status).toBe(405);
  });
});
