import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { McpModule } from "@playground/nestjs-mcp";
import request from "supertest";
import { ResponseWriteTools } from "../src/tools/response-write.tools.js";
import { MCP_ROUTE, SERVER_INFO } from "../src/app.module.js";

// See fire-forget.e2e.spec.ts for why AppModule itself is not used here.
const ACCEPT = "application/json, text/event-stream";

interface JsonRpcResponse {
  id: number;
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

describe("mcp-playground response-write endpoint", () => {
  let app: INestApplication;
  let tools: ResponseWriteTools;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        McpModule.forFeature({
          route: MCP_ROUTE,
          serverInfo: SERVER_INFO,
          toolProviders: [ResponseWriteTools],
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    tools = app.get(ResponseWriteTools);
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

  it("answers at once with a job id when emitResponse is false", async () => {
    const res = await post(
      rpc("tools/call", {
        name: "response-write",
        arguments: { message: "hello", emitResponse: false },
      }),
    );
    expect(res.status).toBe(200);

    const { content, isError } = parseBody(res.text).result;
    expect(isError).toBeUndefined();
    expect(JSON.parse(content![0]!.text)).toMatchObject({ accepted: true });

    await tools.drain();
  });

  it.each([
    { label: "omitted (default)", delayMs: 0, emitResponse: undefined },
    { label: "true", delayMs: 0, emitResponse: true },
    { label: "true", delayMs: 300, emitResponse: true },
  ])(
    "writes the job's result directly to the response when emitResponse is $label (delay $delayMs ms)",
    async ({ delayMs, emitResponse }) => {
      const res = await post(
        rpc("tools/call", {
          name: "response-write",
          arguments: { message: "hello", delayMs, emitResponse },
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
      // Exactly one response: the direct write, never a second one from the SDK.
      expect(res.text.match(/event: message/g)).toHaveLength(1);

      const body = parseBody(res.text);
      expect(body.id).toBe(1);
      expect(body.result.isError).toBeUndefined();
      expect(body.result.content![0]!.text).toMatch(
        new RegExp(`^Job [0-9a-f-]{36}: hello completed in ${delayMs} ms$`),
      );

      await tools.drain();
    },
  );

  it("still answers a later call normally after a direct write", async () => {
    const res = await post(
      rpc("tools/call", {
        name: "response-write",
        arguments: { message: "again", emitResponse: false },
      }),
    );
    expect(parseBody(res.text).result.isError).toBeUndefined();
    await tools.drain();
  });
});
