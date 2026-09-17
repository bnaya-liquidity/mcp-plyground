import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  DEFERRED_RESPONSE,
  McpTool,
  getMcpRequestId,
  getMcpTransport,
} from "@playground/nestjs-mcp";
import {
  createSpanHelpers,
  injectContext,
  type MessageHeaders,
} from "@playground/otel-extensions";
import { z } from "zod";

const spans = createSpanHelpers("@playground/mcp-playground");

const nestedRespnseInput = z.object({
  message: z.string().min(1).describe("Payload to hand to the detached job."),
  delayMs: z
    .number()
    .int()
    .min(0)
    .max(60_000)
    .optional()
    .describe("Simulated work duration, in milliseconds. Defaults to 0."),
});

export type NestedResponseInput = z.infer<typeof nestedRespnseInput>;
export type ToolResponse = NestedResponseInput & { jobId: string };

/**
 * Shared by every detached job spawned for one call, so whichever job
 * finishes first can answer the call and every later job can see that
 * happened and stay quiet — only one JSON-RPC response may be sent per
 * request id.
 */
interface CallAnswer {
  transport: Transport;
  requestId: RequestId;
  sent: boolean;
}

@Injectable()
export class NestedResponseTools implements OnModuleDestroy {
  private readonly logger = new Logger(NestedResponseTools.name);

  /**
   * Tracks the in-flight detached jobs so tests and graceful shutdown
   * (`onModuleDestroy`) can await them. Entries remove themselves on settle,
   * so an idle process holds none.
   */
  private readonly inFlight = new Set<Promise<ToolResponse>>();

  /**
   * Returns `DEFERRED_RESPONSE` instead of the tool's actual text: the
   * detached jobs write the real `tools/call` result themselves, straight to
   * the HTTP response stream via `transport.send`, the way an ASP.NET handler
   * writes to `HttpContext.Response` directly instead of returning a value
   * the framework serializes. No promise here is ever awaited across a job
   * boundary — this method returns as soon as the jobs are dispatched.
   */
  @McpTool({
    name: "nested-response",
    description: "produce the response via a nested job.",
    inputSchema: nestedRespnseInput,
  })
  nestedResponse(input: NestedResponseInput): typeof DEFERRED_RESPONSE {
    const jobId = randomUUID();

    // Capture the CALLER's span context now, while the `tool.nested-response` span
    // is still active. Once this method returns, the request span ends and the
    // active context is gone — reading it from inside the detached job would
    // yield whatever (if anything) happens to be active on that turn of the
    // event loop.
    const carrier: MessageHeaders = {};
    injectContext(carrier);

    // Must be read now, synchronously, while the AsyncLocalStorage context for
    // this HTTP request is still active — a detached job runs after this
    // method returns, on its own continuation, where the context is gone.
    const transport = getMcpTransport();
    const requestId = getMcpRequestId();
    if (!transport || requestId === undefined) {
      throw new Error(
        "nested-response requires an MCP request context (transport + request id)",
      );
    }
    const answer: CallAnswer = { transport, requestId, sent: false };

    const job1 = this.runDetached("jobId 1", input, carrier, answer);
    this.inFlight.add(job1);

    const job2 = this.runDetached(
      "jobId 2",
      { ...input, delayMs: 500 },
      carrier,
      answer,
    );

    this.inFlight.add(job2);
    void job1.finally(() => this.inFlight.delete(job1));
    void job2.finally(() => this.inFlight.delete(job2));

    this.logger.log(`nested-response accepted job ${jobId}`);
    return DEFERRED_RESPONSE;
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
    input: NestedResponseInput,
    carrier: MessageHeaders,
    answer: CallAnswer,
  ): Promise<ToolResponse> {
    await spans.withConsumerSpan(
      {
        operation: "nested-response-job",
        destination: `nested-response-job ${jobId}`,
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
            `nested-response job ${jobId} processed: ${input.message}`,
          );
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.logger.error(
            `nested-response job ${jobId} failed: ${error.message}`,
            error.stack,
          );
        }
      },
    );
    await this.answerCall(
      answer,
      `Job ${jobId}: ${input.message} completed in ${input.delayMs ?? 0} ms`,
    );
    this.logger.log(`job ended: ${jobId} processed: ${input.message}`);
    return { ...input, jobId };
  }

  /**
   * Sends the `tools/call` JSON-RPC response directly on the transport,
   * bypassing the `@McpTool` return-value path entirely — mirrors writing to
   * `HttpContext.Response` straight from a background job.
   *
   * Only the first job to finish may answer; a JSON-RPC request may receive
   * exactly one response. `answer.sent` is checked and set synchronously
   * (no `await` in between), so the two jobs racing here can't both pass the
   * check.
   */
  private async answerCall(answer: CallAnswer, text: string): Promise<void> {
    if (answer.sent) return;
    answer.sent = true;
    await answer.transport.send(
      {
        jsonrpc: "2.0",
        id: answer.requestId,
        result: { content: [{ type: "text", text }] },
      },
      { relatedRequestId: answer.requestId },
    );
  }
}
