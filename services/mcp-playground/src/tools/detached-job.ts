import type { Logger } from "@nestjs/common";
import {
  createSpanHelpers,
  type MessageHeaders,
} from "@playground/otel-extensions";

const spans = createSpanHelpers("@playground/mcp-playground");

export interface DetachedJobInput {
  message: string;
  delayMs?: number;
}

export type DetachedJobResult<TInput extends DetachedJobInput> = TInput & {
  jobId: string;
};

export interface DetachedJobOptions<TInput extends DetachedJobInput> {
  /** Tool name, used as the span operation prefix and in log lines (e.g. `fire-forget`). */
  name: string;
  jobId: string;
  input: TInput;
  /** Caller span context, captured with `injectContext` while the tool span was still active. */
  carrier: MessageHeaders;
  logger: Logger;
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
export async function runDetached<TInput extends DetachedJobInput>({
  name,
  jobId,
  input,
  carrier,
  logger,
}: DetachedJobOptions<TInput>): Promise<DetachedJobResult<TInput>> {
  await spans.withAsyncSpan(
    `${name}-job: ${input.delayMs ?? 0}ms`,
    //await spans.withConsumerSpan(
    // {
    //   operation: ,
    //   destination: `${name}-job ${jobId}`,
    //   headers: carrier,
    //   system: "in_process",
    //   attributes: { "job.id": jobId, "job.delay_ms": input.delayMs ?? 0 },
    // },
    async () => {
      try {
        if (input.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, input.delayMs));
        }
        logger.log(`${name} job ${jobId} processed: ${input.message}`);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error(
          `${name} job ${jobId} failed: ${error.message}`,
          error.stack,
          carrier,
        );
      }
    },
  );
  return { ...input, jobId };
}
