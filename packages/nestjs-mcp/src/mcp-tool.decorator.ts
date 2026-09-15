import "reflect-metadata";
import { MCP_TOOL_METADATA } from "./mcp.constants.js";
import type { McpToolMetadata, McpToolOptions } from "./mcp-tool.types.js";

/**
 * Marks a provider method as an MCP tool. The method receives the validated
 * input object and returns a JSON-serializable result (or throws).
 */
export function McpTool(options: McpToolOptions): MethodDecorator {
  return (target, propertyKey) => {
    const metadata: McpToolMetadata = { ...options, methodName: String(propertyKey) };
    Reflect.defineMetadata(MCP_TOOL_METADATA, metadata, target, propertyKey);
  };
}
