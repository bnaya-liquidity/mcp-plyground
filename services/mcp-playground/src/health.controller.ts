import { Controller, Get } from "@nestjs/common";

export interface HealthStatus {
  status: "ok";
}

/**
 * Liveness and readiness endpoints for the Kubernetes probes and the Helm test
 * (`.deploy/k8s/helm/mcp-playground`).
 *
 * Both are unconditional 200s, and deliberately so: this service has no
 * downstream dependency to check. A readiness probe that cannot fail is only
 * honest while that stays true — the moment this service talks to a database or
 * another API, `ready` must actually verify it, or Kubernetes will keep routing
 * traffic to a pod that cannot serve it.
 *
 * Path note: `/health` is also what `healthTracingMiddleware` (in
 * `@playground/nestjs-mcp`) matches on to suppress span creation, and what the
 * collector's `filter/drop_probe_noise` processor drops. Renaming these routes
 * means updating both, or every probe becomes a span again.
 */
@Controller("health")
export class HealthController {
  @Get()
  live(): HealthStatus {
    return { status: "ok" };
  }

  @Get("ready")
  ready(): HealthStatus {
    return { status: "ok" };
  }
}
