#!/usr/bin/env bash
# Builds the image and deploys the "mcp-playground" release.
source "$(dirname "${BASH_SOURCE[0]}")/_guard.sh"
require_local_context

"$(dirname "${BASH_SOURCE[0]}")/build-image.sh"

helm upgrade --install mcp-playground "$CHART_DIR" \
  --namespace "$NAMESPACE" --create-namespace \
  --values "$CHART_DIR/values-mcp.yaml" \
  --set "mcp.image.repository=$IMAGE_REPO" \
  --set "mcp.image.tag=$IMAGE_TAG" \
  --wait --timeout 5m

# Force a rollout even when the PodSpec is byte-identical. IMAGE_TAG defaults to
# the mutable "dev", so a rebuilt image changes nothing Kubernetes can see and
# no rollout would happen at all — the freshly built image would never reach the
# running pod. Skip this only when deploying an immutable tag.
echo "==> Restarting the deployment to pick up the rebuilt image"
kubectl -n "$NAMESPACE" rollout restart deployment/mcp-playground-mcp
kubectl -n "$NAMESPACE" rollout status deployment/mcp-playground-mcp --timeout=5m

echo "==> MCP deployed:"
echo "    kubectl -n $NAMESPACE port-forward svc/mcp-playground-mcp 3100:3000"
