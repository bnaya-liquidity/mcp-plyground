#!/usr/bin/env bash
# Deploys the observability stack (otelcol + aspire) as the
# "mcp-playground-servers" release. Separate from the app release so the app can
# be rebuilt and redeployed without restarting the collector or losing the
# dashboard's trace history.
source "$(dirname "${BASH_SOURCE[0]}")/_guard.sh"
require_local_context

helm upgrade --install mcp-playground-servers "$CHART_DIR" \
  --namespace "$NAMESPACE" --create-namespace \
  --values "$CHART_DIR/values-servers.yaml" \
  --wait --timeout 5m

echo "==> Servers deployed. Aspire dashboard:"
echo "    kubectl -n $NAMESPACE port-forward svc/mcp-playground-aspire 18988:18888"
