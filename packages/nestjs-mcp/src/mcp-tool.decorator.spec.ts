import "reflect-metadata";
import { z } from "zod";
import { McpTool } from "./mcp-tool.decorator.js";
import { MCP_TOOL_METADATA } from "./mcp.constants.js";
import type { McpToolMetadata } from "./mcp-tool.types.js";

class Sample {
  @McpTool({
    name: "echo",
    description: "Echo input",
    inputSchema: z.object({ msg: z.string() }),
  })
  echo(input: { msg: string }): { msg: string } {
    return input;
  }
}

describe("McpTool", () => {
  it("attaches tool metadata to the decorated method", () => {
    const meta = Reflect.getMetadata(MCP_TOOL_METADATA, Sample.prototype, "echo") as
      McpToolMetadata | undefined;
    expect(meta).toBeDefined();
    expect(meta?.name).toBe("echo");
    expect(meta?.description).toBe("Echo input");
    expect(meta?.methodName).toBe("echo");
    expect(meta?.inputSchema.safeParse({ msg: "hi" }).success).toBe(true);
  });
});
