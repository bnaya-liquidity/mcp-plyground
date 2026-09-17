import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { McpTool } from "@playground/nestjs-mcp";
import {
  createSpanHelpers,
  injectContext,
  type MessageHeaders,
} from "@playground/otel-extensions";
import { z } from "zod";

const spans = createSpanHelpers("@playground/mcp-playground");

const fireForgetInput = z.object({
  message: z.string().min(1).describe("Payload to hand to the detached job."),
  delayMs: z
    .number()
    .int()
    .min(0)
    .max(60_000)
    .optional()
    .describe("Simulated work duration, in milliseconds. Defaults to 0."),
});

export type FireForgetInput = z.infer<typeof fireForgetInput>;

export interface FireForgetResult {
  accepted: true;
  jobId: string;
}

@Injectable()
export class FireForgetTools implements OnModuleDestroy {
  private readonly logger = new Logger(FireForgetTools.name);

  /**
   * Tracks the in-flight detached jobs so tests and graceful shutdown
   * (`onModuleDestroy`) can await them. Entries remove themselves on settle,
   * so an idle process holds none.
   */
  private readonly inFlight = new Set<Promise<void>>();

  @McpTool({
    name: "fire-forget",
    description:
      "Queue a message for detached processing. Returns immediately with a job id; " +
      "the work runs after the response is sent and is never awaited by the caller.",
    inputSchema: fireForgetInput,
  })
  async fireForget(input: FireForgetInput): Promise<FireForgetResult> {
    const jobId = randomUUID();

    // Capture the CALLER's span context now, while the `tool.fire-forget` span
    // is still active. Once this method returns, the request span ends and the
    // active context is gone — reading it from inside the detached job would
    // yield whatever (if anything) happens to be active on that turn of the
    // event loop.
    const carrier: MessageHeaders = {};
    injectContext(carrier);

    const job1 = this.runDetached(jobId, input, carrier);
    this.inFlight.add(job1);

    await new Promise((resolve) => setTimeout(resolve, 300));

    const job2 = this.runDetached(
      jobId,
      { ...input, delayMs: input.delayMs ?? 0 + 500 },
      carrier,
    );
    this.inFlight.add(job2);
    void job1.finally(() => this.inFlight.delete(job1));
    void job2.finally(() => this.inFlight.delete(job2));

    this.logger.log(`fire-forget accepted job ${jobId}`);
    return { accepted: true, jobId };
  }

  /** Resolves once every job accepted so far has settled. Test seam, also used for graceful shutdown. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  /** Nest calls this on SIGTERM (via `app.enableShutdownHooks()` in main.ts) so in-flight jobs finish before the process exits. */
  async onModuleDestroy(): Promise<void> {
    await this.drain();
  }

  /**
   * The detached half. Uses `withConsumerSpan`, so the job gets a ROOT span
   * carrying a LINK back to the accepting request rather than becoming its
   * child: a parent span cannot end before its children, so parenting here
   * would stretch the HTTP request span across the job's entire lifetime and
   * corrupt every latency percentile derived from it.
   *
   * Errors are logged and swallowed. That is the fire-and-forget contract —
   * the caller already has its response and there is nobody left to throw to;
   * an escaping rejection would be an unhandled rejection, not a useful signal.
   */
  private async runDetached(
    jobId: string,
    input: FireForgetInput,
    carrier: MessageHeaders,
  ): Promise<void> {
    await spans.withConsumerSpan(
      {
        operation: "fire-forget-job",
        destination: `fire-forget-job ${jobId}`,
        headers: carrier,
        system: "in_process",
        attributes: { "job.id": jobId, "job.delay_ms": input.delayMs ?? 0 },
      },
      async () => {
        try {
          if (input.delayMs) {
            await new Promise((resolve) => setTimeout(resolve, input.delayMs));
          }
          this.logger.log(
            `fire-forget job ${jobId} processed: ${input.message}`,
          );
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.logger.error(
            `fire-forget job ${jobId} failed: ${error.message}`,
            error.stack,
          );
        }
      },
    );
  }
}
