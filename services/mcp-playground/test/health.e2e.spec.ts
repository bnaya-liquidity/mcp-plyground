import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { HealthController } from "../src/health.controller.js";

// These paths are contracts with three other places: the Kubernetes probes and
// the Helm test in .deploy/k8s/helm/mcp-playground, healthTracingMiddleware's
// span suppression, and the collector's filter/drop_probe_noise processor.
// Changing a path here without changing those turns every probe into a span.
describe("health endpoints", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ["liveness", "/health"],
    ["readiness", "/health/ready"],
  ])("serves %s at %s", async (_name, path) => {
    const res = await request(app.getHttpServer()).get(path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
