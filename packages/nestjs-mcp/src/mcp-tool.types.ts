import type { ZodType } from "zod";

export interface McpToolOptions {
  /** Tool name exposed via tools/list. */
  name: string;
  /** Human-facing tool description. */
  description: string;
  /** Zod schema for the tool input; drives JSON Schema + runtime validation. */
  inputSchema: ZodType;
}

export interface McpToolMetadata extends McpToolOptions {
  /** Provider method name the tool dispatches to. */
  methodName: string;
}
