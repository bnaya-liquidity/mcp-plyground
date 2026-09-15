#!/usr/bin/env bash
# Verifies the chart renders, with no cluster required.
source "$(dirname "${BASH_SOURCE[0]}")/_guard.sh"

helm lint "$CHART_DIR" --values "$CHART_DIR/values-servers.yaml"
helm lint "$CHART_DIR" --values "$CHART_DIR/values-mcp.yaml"
helm template mcp-playground-servers "$CHART_DIR" --values "$CHART_DIR/values-servers.yaml" >/dev/null
helm template mcp-playground "$CHART_DIR" --values "$CHART_DIR/values-mcp.yaml" >/dev/null
echo "==> Chart renders for both value overlays"
