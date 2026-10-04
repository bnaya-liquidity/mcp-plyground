import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { McpTool } from "@playground/nestjs-mcp";
import {
  injectContext,
  type MessageHeaders,
} from "@playground/otel-extensions";
import { z } from "zod";
import { runDetached, type DetachedJobResult } from "./detached-job.js";

const awaitResponseInput = z.object({
  message: z.string().min(1).describe("Payload to hand to the detached job."),
  delayMs: z
    .number()
    .int()
    .min(0)
    .max(60_000)
    .optional()
    .describe("Simulated work duration, in milliseconds. Defaults to 0."),
});

export type AwaitResponseInput = z.infer<typeof awaitResponseInput>;
export type ToolResponse = DetachedJobResult;

@Injectable()
export class AwaitResponseTools implements OnModuleDestroy {
  private readonly logger = new Logger(AwaitResponseTools.name);

  /**
   * Tracks the in-flight detached jobs so tests and graceful shutdown
   * (`onModuleDestroy`) can await them. Entries remove themselves on settle,
   * so an idle process holds none.
   */
  private readonly inFlight = new Set<Promise<ToolResponse>>();

  @McpTool({
    name: "await-response",
    description: "produce the response via a nested job.",
    inputSchema: awaitResponseInput,
  })
  async nestedResponse(input: AwaitResponseInput): Promise<string> {
    const jobId = randomUUID();

    // Capture the CALLER's span context now, while the `tool.await-response` span
    // is still active. Once this method returns, the request span ends and the
    // active context is gone — reading it from inside the detached job would
    // yield whatever (if anything) happens to be active on that turn of the
    // event loop.
    const carrier: MessageHeaders = {};
    injectContext(carrier);

    const job1 = this.runJob("jobId 1", input.message, input.delayMs, carrier);
    this.inFlight.add(job1);

    await new Promise((resolve) => setTimeout(resolve, 300));

    const job2 = this.runJob(
      "jobId 2",
      input.message,
      (input.delayMs ?? 0) + 500,
      carrier,
    );
    this.inFlight.add(job2);
    void job1.finally(() => this.inFlight.delete(job1));
    void job2.finally(() => this.inFlight.delete(job2));

    this.logger.log(`await-response accepted job ${jobId}`);
    const r = await Promise.race([job1, job2]);
    return `Root: ${r.message} completed in ${r.delayMs ?? 0} ms (jobId: ${r.jobId})`;
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
    message: string,
    delayMs: number | undefined,
    carrier: MessageHeaders,
  ): Promise<ToolResponse> {
    return runDetached({
      name: "await-response",
      jobId,
      message,
      delayMs,
      carrier,
      logger: this.logger,
    });
  }
}
