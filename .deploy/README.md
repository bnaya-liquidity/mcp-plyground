# Deploy

Two ways to run `mcp-playground` with its observability stack: Docker Compose for
local work, Helm for a local Kubernetes cluster.

## What gets deployed

| Component        | What it is                                      | Container ports               | Compose host ports |
| ---------------- | ----------------------------------------------- | ----------------------------- | ------------------ |
| `mcp-playground` | NestJS HTTP MCP server, one tool: `fire-forget` | `3000`                        | `3100`             |
| `otelcol`        | OpenTelemetry Collector (contrib)               | `4317` (gRPC), `4318` (HTTP)  | `4417`, `4418`     |
| `aspire`         | .NET Aspire dashboard (traces, metrics, logs)   | `18888` (web), `18889` (OTLP) | `18988`, `18989`   |

Compose publishes on the shifted host ports on purpose: the defaults (3000,
4317, 4318, 18888, 18889) are what every other OTel stack binds, so this
playground would refuse to start whenever one of those is already up. Container
ports never change, so the Helm chart is unaffected.

The app exports OTLP to the collector, which forwards everything to the Aspire
dashboard and derives per-tool metrics from the spans (`spanmetrics` connector,
split by `mcp.tool` and `mcp.endpoint`).

## Build the image

The build context is the **monorepo root**, not the service directory — the image
compiles the two workspace packages (`@playground/nestjs-mcp`,
`@playground/otel-extensions`) from source, so a service-scoped context cannot
see the code it needs.

```bash
pnpm run deploy:image                      # mcp-playground:dev
IMAGE_TAG=$(git rev-parse --short HEAD) pnpm run deploy:image
```

Or directly:

```bash
docker build -f services/mcp-playground/Dockerfile -t mcp-playground:dev .
```

The result is a ~85 MB `node:24-slim` image running as the unprivileged `node`
user.

## Run with Docker Compose

```bash
pnpm run docker:up      # build + start all three services
pnpm run docker:logs    # follow the app log
pnpm run docker:down    # stop and remove
```

Then:

- MCP endpoint — `http://localhost:3100/mcp`
- Aspire dashboard — `http://localhost:18988`

Call the tool:

```bash
curl -X POST http://localhost:3100/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fire-forget","arguments":{"message":"hello","delayMs":1500}}}'
```

It returns `{"accepted":true,"jobId":"…"}` immediately; the job finishes 1.5 s
later. In the Aspire dashboard the job appears as its own root span carrying a
link back to the request — not as a child of it. See
[services/mcp-playground/README.md](../services/mcp-playground/README.md) for why.

`docker compose -f .deploy/docker/docker-compose.yml watch mcp-playground`
rebuilds and recreates the container whenever the service or the workspace
packages change.

### Port conflicts

If a host port is still taken, Compose fails with `port is already allocated`.
Override it — note that Compose **merges** `ports` lists across files, so an
override needs the `!override` tag or you end up with both bindings and the same
failure:

```yaml
# ports-override.yml
services:
  mcp-playground:
    ports: !override ["3200:3000"]
```

```bash
docker compose -f .deploy/docker/docker-compose.yml -f ports-override.yml up -d
```

## Deploy to Kubernetes

### Prerequisites

1. **Docker Desktop with Kubernetes enabled.** The deploy scripts accept the
   `docker-desktop` context and nothing else (see below).

2. **Ingress-nginx** — optional. If your cluster can pull `registry.k8s.io`:

   ```bash
   helm upgrade --install ingress-nginx ingress-nginx \
     --repo https://kubernetes.github.io/ingress-nginx \
     --namespace ingress-nginx --create-namespace
   ```

   Some environments cannot reach `registry.k8s.io` at all — it is the only
   registry publishing that controller image. Skip this step and use
   `kubectl port-forward` instead (below).

3. **`/etc/hosts`** entry, only if you installed the ingress controller:

   ```
   127.0.0.1  mcp.playground.local aspire.playground.local
   ```

### Deploy

```bash
pnpm run deploy:k8s:lint      # render the chart, no cluster needed
pnpm run install:k8s          # both releases, in order — the usual entry point
pnpm run uninstall:k8s        # remove both releases and the namespace
```

The two halves can also be driven separately, which is the point of the
two-release split — redeploy the app without restarting the collector:

```bash
pnpm run deploy:k8s:servers   # otelcol + aspire
pnpm run deploy:k8s:mcp       # build the image + deploy the app
```

Environment overrides, on any of these scripts:

| Variable     | Default          | Effect                                  |
| ------------ | ---------------- | --------------------------------------- |
| `NAMESPACE`  | `mcp-playground` | Namespace to install into or remove     |
| `IMAGE_REPO` | `mcp-playground` | Image name to build and deploy          |
| `IMAGE_TAG`  | `dev`            | Image tag; use a git SHA for a real one |

```bash
NAMESPACE=mcp-alt pnpm run install:k8s
NAMESPACE=mcp-alt pnpm run uninstall:k8s
```

Each namespace is a **fully independent copy** of the stack, and several can run
side by side. In-cluster DNS is namespace-scoped, so an app always resolves the
`mcp-playground-otelcol` in its own namespace — never another namespace's
collector, even though every release uses the same
`fullnameOverride`. `NAMESPACE` must be a valid RFC 1123 label (lowercase
letters, digits and `-`); the scripts reject anything else up front rather than
letting it fail deeper inside kubectl.

Pass the same `NAMESPACE` to `uninstall:k8s` that you passed to `install:k8s` —
the default removes the default namespace, not the one you last deployed to.

The stack is **two Helm releases of one chart**, so the app redeploys without
restarting the collector or losing the dashboard's trace history:

| Release                  | Values file           | Renders          |
| ------------------------ | --------------------- | ---------------- |
| `mcp-playground-servers` | `values-servers.yaml` | otelcol, aspire  |
| `mcp-playground`         | `values-mcp.yaml`     | the MCP server   |

Both pin `fullnameOverride: mcp-playground`, so in-cluster DNS
(`mcp-playground-otelcol:4318`) does not depend on the release name and the app
resolves the collector across the release boundary. **Change that value in only
one of the two files and the app→collector wiring breaks silently** — the chart
still lints, traces just stop arriving.

Every deploy script refuses to run unless `kubectl config current-context` is
exactly `docker-desktop`:

```bash
kubectl config use-context docker-desktop
```

This is a hard allowlist of one, because the same kubeconfig usually carries EKS
contexts — production among them — and a `helm upgrade` aimed at one of those by
accident cannot be undone by re-running the script. `ALLOW_CONTEXT=1` overrides
it; use that only if you are certain.

`deploy:k8s:mcp` runs `kubectl rollout restart` after every `helm upgrade`. That
is deliberate: `IMAGE_TAG` defaults to the mutable `dev`, so a rebuilt image
leaves the PodSpec byte-identical and Kubernetes would perform no rollout at all
— the freshly built image would never reach the running pod. Deploying an
immutable tag (a git SHA) makes the restart unnecessary.

### Verify

```bash
kubectl get pods -n mcp-playground
helm test mcp-playground -n mcp-playground   # checks /health, /health/ready, and tools/list
```

Expected:

```text
NAME                                READY   STATUS
mcp-playground-aspire-...           1/1     Running
mcp-playground-mcp-...              1/1     Running
mcp-playground-otelcol-...          1/1     Running
```

### Access

With an ingress controller:

| URL                              | What              |
| -------------------------------- | ----------------- |
| `http://mcp.playground.local`    | MCP server        |
| `http://aspire.playground.local` | Aspire dashboard  |

Without one, port-forward — this is a supported path, not a fallback:

```bash
# Local ports shifted like the Compose stack, so these work while it is running.
kubectl port-forward -n mcp-playground svc/mcp-playground-mcp 3100:3000
kubectl port-forward -n mcp-playground svc/mcp-playground-aspire 18988:18888
```

### Teardown

```bash
pnpm run uninstall:k8s
```

This removes both releases and deletes the namespace, taking everything in it
along. It is guarded by the same `docker-desktop`-only check as the deploy
scripts — more importantly so, since this is the irreversible direction. It is
idempotent: running it against an already-clean cluster exits 0.

The equivalent by hand:

```bash
helm uninstall mcp-playground mcp-playground-servers -n mcp-playground
kubectl delete namespace mcp-playground
```

## Health endpoints

| Path            | Used by                                  |
| --------------- | ---------------------------------------- |
| `/health`       | Kubernetes liveness, Compose healthcheck |
| `/health/ready` | Kubernetes readiness                     |

Both return `200 {"status":"ok"}` unconditionally, because this service has no
downstream dependency to check. That is only honest while it stays true: if the
service ever talks to a database or another API, `/health/ready` must verify it,
or Kubernetes will keep routing traffic to a pod that cannot serve it.

These paths are a contract with two other places: `healthTracingMiddleware` in
`@playground/nestjs-mcp` suppresses span creation for them, and the collector's
`filter/drop_probe_noise` processor drops any that slip through (HTTP
auto-instrumentation opens its server span before Express middleware runs, so
app-side suppression alone cannot catch them). Rename a path without updating
both and every probe becomes a span again — roughly one per pod every 10 seconds,
forever.

## Troubleshooting

**`This site can't be reached` for a `.playground.local` URL.** Check
`/etc/hosts` resolves the name to `127.0.0.1`, then check the controller is up
(`kubectl get svc -n ingress-nginx`) and the Ingress has an address
(`kubectl get ingress -n mcp-playground`). If there is no controller, use
port-forward.

**No traces in Aspire.** Confirm the app's `OTEL_EXPORTER_OTLP_ENDPOINT` points
at a reachable collector (`kubectl exec deploy/mcp-playground-mcp -n
mcp-playground -- env | grep OTEL`), and check the collector's own logs for
export failures. `OTEL_SDK_DISABLED=true` in `mcp.env` silences telemetry
entirely — worth ruling out first.

**Collector logs `"otlp" alias is deprecated; use "otlp_grpc" instead`.** Cosmetic,
from collector 0.152. The config still works; renaming the exporter and connector
keys clears it.
