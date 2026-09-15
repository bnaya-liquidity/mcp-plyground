// libs/nestjs-mcp/src/mcp-server.factory.spec.ts
import "reflect-metadata";
import { z } from "zod";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer } from "./mcp-server.factory.js";
import type { RegisteredTool } from "./mcp-registry.service.js";

function tool(name: string, fn: (a: unknown) => unknown): RegisteredTool {
  const schema = z.object({ x: z.number() });
  return {
    name,
    description: name,
    inputSchema: schema,
    jsonSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    invoke: async (a) => fn(a),
  };
}

describe("buildMcpServer", () => {
  it("lists tools and calls them, serializing the result", async () => {
    const server = buildMcpServer({ name: "t", version: "0.0.0" }, [
      tool("double", (a) => ({ y: (a as { x: number }).x * 2 })),
    ]);
    // Access the registered handlers via the SDK's internal request handling.
    const list = await (
      server as unknown as {
        _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
      }
    )._requestHandlers.get(ListToolsRequestSchema.shape.method.value)!(
      { method: "tools/list", params: {} },
      {},
    );
    expect((list as { tools: { name: string }[] }).tools[0].name).toBe("double");

    const call = await (
      server as unknown as {
        _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
      }
    )._requestHandlers.get(CallToolRequestSchema.shape.method.value)!(
      { method: "tools/call", params: { name: "double", arguments: { x: 21 } } },
      {},
    );
    expect((call as { content: { text: string }[] }).content[0].text).toContain("42");
  });
});
