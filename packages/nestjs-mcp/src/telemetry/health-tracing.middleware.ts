import type { NextFunction, Request, Response } from "express";
import { withSuppressedTracing } from "@playground/otel-extensions";

/**
 * Suppresses span creation for the whole lifetime of a health-probe request
 * (liveness `/health` and readiness `/health/ready`), regardless of outcome —
 * a k8s probe hitting these every few seconds would otherwise flood the trace
 * backend with e.g. `neo4j.ping` spans that carry no signal. Applied as global
 * middleware (see `mcp-logger.module.ts`) so it covers spans started deep in
 * the request's async chain (a dependency ping) without those call sites
 * knowing anything about the caller's intent to suppress.
 *
 * Failures are still visible — see `pino-otel.ts`'s `customLogLevel`, which
 * logs (but does not trace) a failing health check.
 *
 * This middleware is NOT redundant with `initTelemetry`'s
 * `ignoreIncomingRequestHook`, which also special-cases `/health`. They cover
 * opposite sides of the same request: the hook prevents the SERVER span from
 * ever being created (it is opened before any middleware runs, so it is out of
 * this middleware's reach), while this suppresses spans started DOWNSTREAM
 * inside the handler. Deleting either one leaves a real hole.
 */
export function healthTracingMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const path = (req.url ?? "").split("?")[0] ?? "";
  if (!path.startsWith("/health")) {
    next();
    return;
  }
  withSuppressedTracing(next);
}
