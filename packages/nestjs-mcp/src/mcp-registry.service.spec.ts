// libs/nestjs-mcp/src/mcp-registry.service.spec.ts
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { MetadataScanner } from "@nestjs/core";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpTool } from "./mcp-tool.decorator.js";
import { McpRegistryService } from "./mcp-registry.service.js";
import { MCP_TOOL_PROVIDERS } from "./mcp.constants.js";

@Injectable()
class GreetTools {
  @McpTool({
    name: "greet",
    description: "Greet",
    inputSchema: z.object({ name: z.string() }),
  })
  greet(input: { name: string }): { text: string } {
    return { text: `hi ${input.name}` };
  }
}

describe("McpRegistryService", () => {
  it("discovers @McpTool methods once and invokes with validation", async () => {
    const greetTools = new GreetTools();
    const moduleRef = await Test.createTestingModule({
      providers: [
        MetadataScanner,
        McpRegistryService,
        { provide: MCP_TOOL_PROVIDERS, useValue: [greetTools] },
      ],
    }).compile();
    await moduleRef.init();

    const registry = moduleRef.get(McpRegistryService);
    const tools = registry.getTools();
    expect(tools.map((t) => t.name)).toEqual(["greet"]);
    expect(tools[0].jsonSchema).toHaveProperty("type", "object");

    await expect(registry.getTool("greet")!.invoke({ name: "Ada" })).resolves.toEqual({
      text: "hi Ada",
    });
    await expect(registry.getTool("greet")!.invoke({})).rejects.toThrow(/input/i);
  });
});
