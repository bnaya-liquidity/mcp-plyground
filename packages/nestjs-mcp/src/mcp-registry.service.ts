// libs/nestjs-mcp/src/mcp-registry.service.ts
import "reflect-metadata";
import { Inject, Injectable, Logger, Optional, type OnModuleInit } from "@nestjs/common";
import { MetadataScanner } from "@nestjs/core";
import { z, type ZodType } from "zod";
import { MCP_TOOL_METADATA, MCP_TOOL_PROVIDERS } from "./mcp.constants.js";
import type { McpToolMetadata } from "./mcp-tool.types.js";

export class McpToolInputError extends Error {
  readonly code = "VALIDATION_ERROR";
  readonly httpStatusHint = 422;
}

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: ZodType;
  jsonSchema: Record<string, unknown>;
  invoke(args: unknown): Promise<unknown>;
}

@Injectable()
export class McpRegistryService implements OnModuleInit {
  private readonly logger = new Logger(McpRegistryService.name);
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(
    private readonly scanner: MetadataScanner,
    @Optional()
    @Inject(MCP_TOOL_PROVIDERS)
    private readonly toolProviders: object[] | null,
  ) {}

  onModuleInit(): void {
    const providers = this.toolProviders ?? [];
    for (const instance of providers) {
      if (!instance || typeof instance !== "object") continue;
      const prototype = Object.getPrototypeOf(instance) as object;
      if (!prototype) continue;

      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const metadata = Reflect.getMetadata(MCP_TOOL_METADATA, prototype, methodName) as
          McpToolMetadata | undefined;
        if (!metadata) continue;
        this.register(instance as Record<string, (a: unknown) => unknown>, metadata);
      }
    }
    this.logger.log(
      `Discovered ${this.tools.size} MCP tool(s): ${[...this.tools.keys()].join(", ")}`,
    );
  }

  private register(
    instance: Record<string, (a: unknown) => unknown>,
    metadata: McpToolMetadata,
  ): void {
    if (this.tools.has(metadata.name)) {
      throw new Error(`Duplicate MCP tool name: ${metadata.name}`);
    }
    const { inputSchema } = metadata;
    const jsonSchema = z.toJSONSchema(inputSchema, { target: "draft-7" }) as Record<
      string,
      unknown
    >;
    const rawMethod = instance[metadata.methodName];
    if (typeof rawMethod !== "function") {
      throw new Error(
        `MCP tool method "${metadata.methodName}" not found on provider for tool "${metadata.name}"`,
      );
    }
    const method = rawMethod.bind(instance);
    this.tools.set(metadata.name, {
      name: metadata.name,
      description: metadata.description,
      inputSchema,
      jsonSchema,
      invoke: async (args: unknown): Promise<unknown> => {
        const parsed = inputSchema.safeParse(args);
        if (!parsed.success) {
          throw new McpToolInputError(
            `Invalid input for tool "${metadata.name}": ${parsed.error.message}`,
          );
        }
        return await method(parsed.data);
      },
    });
  }

  getTools(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }
}
