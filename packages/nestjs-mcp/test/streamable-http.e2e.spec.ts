import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { Injectable, type INestApplication } from "@nestjs/common";
import request from "supertest";
import { z } from "zod";
import { McpTool } from "../src/mcp-tool.decorator.js";
import { McpModule } from "../src/mcp.module.js";

@Injectable()
class EchoTools {
  @McpTool({
    name: "echo",
    description: "Echo",
    inputSchema: z.object({ msg: z.string() }),
  })
  echo(input: { msg: string }): { msg: string } {
    return input;
  }
}

const ACCEPT = "application/json, text/event-stream";
const rpc = (method: string, params: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params,
});

describe("McpModule.forFeature (Streamable HTTP)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        McpModule.forFeature({
          route: "demo/mcp",
          serverInfo: { name: "demo", version: "0.0.0" },
          toolProviders: [EchoTools],
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("lists tools over POST", async () => {
    const res = await request(app.getHttpServer())
      .post("/demo/mcp")
      .set("Accept", ACCEPT)
      .set("Content-Type", "application/json")
      .send(rpc("tools/list"));
    expect(res.status).toBe(200);
    const body = res.text.includes("event:") ? parseSse(res.text) : JSON.parse(res.text);
    expect(body.result.tools[0].name).toBe("echo");
  });

  it("rejects GET with 405", async () => {
    const res = await request(app.getHttpServer()).get("/demo/mcp");
    expect(res.status).toBe(405);
  });
});

function parseSse(text: string): { result: { tools: { name: string }[] } } {
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(line!.slice("data:".length).trim());
}
