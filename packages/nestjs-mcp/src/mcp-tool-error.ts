// libs/nestjs-mcp/src/mcp-tool-error.ts
/**
 * Structural (duck-typed) check for a tool error carrying a stable code and
 * httpStatusHint. This package must not depend on @playground/mcp-abstractions, so
 * any error shaped this way — regardless of which package defines the
 * class — is recognized without an `instanceof` check across package
 * boundaries.
 */
export interface StructuredToolError {
  code: string;
  httpStatusHint: number;
  message: string;
  details?: Record<string, unknown>;
}

export function isStructuredToolError(err: unknown): err is StructuredToolError {
  return (
    err instanceof Error &&
    typeof (err as { code?: unknown }).code === "string" &&
    typeof (err as { httpStatusHint?: unknown }).httpStatusHint === "number"
  );
}
