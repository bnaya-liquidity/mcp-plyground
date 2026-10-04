import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { McpTool } from "@playground/nestjs-mcp";
import {
  injectContext,
  type MessageHeaders,
} from "@playground/otel-extensions";
import { z } from "zod";
import { runDetached, type DetachedJobResult } from "./detached-job.js";

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
  private readonly inFlight = new Set<
    Promise<DetachedJobResult<FireForgetInput>>
  >();

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

    const job1: Promise<DetachedJobResult<FireForgetInput>> = this.runJob(
      jobId,
      input,
      carrier,
    );
    this.inFlight.add(job1);
    void job1.finally(() => this.inFlight.delete(job1));

    const job2: Promise<DetachedJobResult<FireForgetInput>> = this.runJob(
      jobId,
      { ...input, delayMs: input.delayMs ?? 0 + 1000 },
      carrier,
    );
    this.inFlight.add(job2);
    void job2.finally(() => this.inFlight.delete(job2));

    await new Promise((resolve) => setTimeout(resolve, 100));

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

  private runJob(
    jobId: string,
    input: FireForgetInput,
    carrier: MessageHeaders,
  ): Promise<DetachedJobResult<FireForgetInput>> {
    return runDetached({
      name: "fire-forget",
      jobId,
      input,
      carrier,
      logger: this.logger,
    });
  }
}
