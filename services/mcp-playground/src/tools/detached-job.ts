import type { Logger } from "@nestjs/common";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  getMcpRequestContext,
  writeMcpResponse,
  type McpRequestContext,
} from "@playground/nestjs-mcp";
import {
  createSpanHelpers,
  type MessageHeaders,
} from "@playground/otel-extensions";

const spans = createSpanHelpers("@playground/mcp-playground");

export interface DetachedJobInput {
  message: string;
  delayMs?: number;
}

export type DetachedJobResult = {
  message: string;
  delayMs?: number;
  jobId: string;
};

export interface DetachedJobOptions {
  /** Tool name, used as the span operation prefix and in log lines (e.g. `fire-forget`). */
  name: string;
  jobId: string;
  message: string;
  delayMs?: number;
  /** Caller span context, captured with `injectContext` while the tool span was still active. */
  carrier: MessageHeaders;
  logger: Logger;
  /**
   * When true, the job writes the `tools/call` result straight to the HTTP
   * response once it finishes (see `writeMcpResponse`), and records an
   * `mcp.response.emitted` span event on the job span. The calling tool must
   * then return `DEFERRED_RESPONSE`. Defaults to false.
   */
  emitResponse?: boolean;
}

/**
 * The detached half shared by every tool. Uses `withConsumerSpan`, so the job
 * gets a ROOT span carrying a LINK back to the accepting request rather than
 * becoming its child: a parent span cannot end before its children, so
 * parenting here would stretch the HTTP request span across the job's entire
 * lifetime and corrupt every latency percentile derived from it.
 *
 * Errors are logged and swallowed. That is the fire-and-forget contract —
 * the caller already has its response and there is nobody left to throw to;
 * an escaping rejection would be an unhandled rejection, not a useful signal.
 */
export async function runDetached({
  name,
  jobId,
  message,
  delayMs,
  carrier,
  logger,
  emitResponse = false,
}: DetachedJobOptions): Promise<DetachedJobResult> {
  // Captured now, while the caller's request context is certainly active, so
  // the write below targets this call's response.
  const requestContext = emitResponse ? getMcpRequestContext() : undefined;
  await spans.withAsyncSpan(
    `${name}-job: ${delayMs ?? 0}ms`,
    //await spans.withConsumerSpan(
    // {
    //   operation: ,
    //   destination: `${name}-job ${jobId}`,
    //   headers: carrier,
    //   system: "in_process",
    //   attributes: { "job.id": jobId, "job.delay_ms": input.delayMs ?? 0 },
    // },
    async () => {
      let failure: Error | undefined;
      try {
        if (delayMs) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        logger.log(`${name} job ${jobId} processed: ${message}`);
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
        logger.error(
          `${name} job ${jobId} failed: ${failure.message}`,
          failure.stack,
          carrier,
        );
      }
      if (emitResponse) {
        // A failed job still answers: with the tool returning
        // DEFERRED_RESPONSE, nothing else ever will.
        const result: CallToolResult = failure
          ? {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ code: "INTERNAL_ERROR", message: failure.message }),
                },
              ],
              isError: true,
            }
          : {
              content: [
                { type: "text", text: `Job ${jobId}: ${message} completed in ${delayMs ?? 0} ms` },
              ],
            };
        await emitJobResponse(result, requestContext, name, jobId, logger);
      }
    },
  );
  return { message, delayMs, jobId };
}

/** Writes the job's response; never throws (see the fire-and-forget contract above). */
async function emitJobResponse(
  result: CallToolResult,
  requestContext: McpRequestContext | undefined,
  name: string,
  jobId: string,
  logger: Logger,
): Promise<void> {
  try {
    const written = await writeMcpResponse(result, requestContext);
    if (!written) {
      logger.debug(`${name} job ${jobId}: response already written or client gone`);
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error(`${name} job ${jobId} could not write response: ${error.message}`, error.stack);
  }
}
