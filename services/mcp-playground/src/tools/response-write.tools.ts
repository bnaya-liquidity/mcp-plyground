import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { DEFERRED_RESPONSE, McpTool } from "@playground/nestjs-mcp";
import {
  injectContext,
  type MessageHeaders,
} from "@playground/otel-extensions";
import { z } from "zod";
import { runDetached, type DetachedJobResult } from "./detached-job.js";

const responseWriteInput = z.object({
  message: z.string().min(1).describe("Payload to hand to the detached job."),
  delayMs: z
    .number()
    .int()
    .min(0)
    .max(60_000)
    .optional()
    .describe("Simulated work duration, in milliseconds. Defaults to 0."),
  emitResponse: z
    .boolean()
    .optional()
    .describe(
      "When true, the detached job writes the result straight to the HTTP response " +
        "and records an `mcp.response.emitted` span event. When false, the call returns " +
        "at once with a job id. Defaults to true.",
    ),
});

export type ResponseWriteInput = z.infer<typeof responseWriteInput>;

export interface ResponseWriteResult {
  accepted: true;
  jobId: string;
}

@Injectable()
export class ResponseWriteTools implements OnModuleDestroy {
  private readonly logger = new Logger(ResponseWriteTools.name);

  /**
   * Tracks the in-flight detached jobs so tests and graceful shutdown
   * (`onModuleDestroy`) can await them. Entries remove themselves on settle,
   * so an idle process holds none.
   */
  private readonly inFlight = new Set<Promise<DetachedJobResult>>();

  /**
   * By default (`emitResponse` omitted or true), the detached job writes the
   * `tools/call` result itself, straight to the raw HTTP response it reaches
   * through the request context — no response object is passed down. This
   * method then returns `DEFERRED_RESPONSE` so the SDK sends nothing of its
   * own. With `emitResponse: false`, the job runs fire-and-forget and the
   * call is answered at once.
   */
  @McpTool({
    name: "response-write",
    description:
      "Run a detached job. By default the job writes the tool result directly to the " +
      "HTTP response when it finishes; with emitResponse false the call returns at once with a job id.",
    inputSchema: responseWriteInput,
  })
  responseWrite(
    input: ResponseWriteInput,
  ): ResponseWriteResult | typeof DEFERRED_RESPONSE {
    const jobId = randomUUID();
    const emitResponse = input.emitResponse ?? true;

    // Capture the CALLER's span context now, while the `tool.response-write`
    // span is still active; the job links back to it.
    const carrier: MessageHeaders = {};
    injectContext(carrier);

    const job = runDetached({
      name: "response-write",
      jobId,
      message: input.message,
      delayMs: input.delayMs,
      carrier,
      logger: this.logger,
      emitResponse,
    });
    this.inFlight.add(job);
    void job.finally(() => this.inFlight.delete(job));

    const job1 = runDetached({
      name: "response-write",
      jobId,
      message: input.message,
      delayMs: (input.delayMs ?? 0) + 1000,
      carrier,
      logger: this.logger,
      emitResponse,
    });
    this.inFlight.add(job1);
    void job1.finally(() => this.inFlight.delete(job1));

    this.logger.log(
      `response-write accepted job ${jobId} (emitResponse: ${emitResponse})`,
    );
    return emitResponse ? DEFERRED_RESPONSE : { accepted: true, jobId };
  }

  /** Resolves once every job accepted so far has settled. Test seam, also used for graceful shutdown. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  /** Nest calls this on SIGTERM (via `app.enableShutdownHooks()` in main.ts) so in-flight jobs finish before the process exits. */
  async onModuleDestroy(): Promise<void> {
    await this.drain();
  }
}
