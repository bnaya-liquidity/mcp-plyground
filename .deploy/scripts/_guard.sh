#!/usr/bin/env bash
# Shared setup for the deploy scripts. Source it, do not run it.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHART_DIR="$REPO_ROOT/.deploy/k8s/helm/mcp-playground"
# Override per invocation:  NAMESPACE=my-ns pnpm run install:k8s
# Each namespace is a fully independent copy of the stack — in-cluster DNS
# (mcp-playground-otelcol) is namespace-scoped, so an app always resolves the
# collector in its own namespace, never another one's.
NAMESPACE="${NAMESPACE:-mcp-playground}"

# Fail here rather than several commands later. An invalid name surfaces deep
# inside a kubectl/helm error that does not name the env var responsible.
if [[ ! "$NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ || ${#NAMESPACE} -gt 63 ]]; then
  echo "Invalid NAMESPACE '$NAMESPACE'." >&2
  echo "Must be an RFC 1123 label: lowercase letters, digits and '-', starting" >&2
  echo "and ending alphanumeric, 63 characters or fewer." >&2
  exit 1
fi
IMAGE_REPO="${IMAGE_REPO:-mcp-playground}"
IMAGE_TAG="${IMAGE_TAG:-dev}"

# Refuse to deploy anywhere except Docker Desktop. This kubeconfig also carries
# EKS contexts including prod, and a helm upgrade aimed at one of those by
# accident is not recoverable by re-running the script — so this guard is
# opt-out, never opt-in, and it allows exactly one context by name.
require_local_context() {
  local ctx
  ctx="$(kubectl config current-context 2>/dev/null || true)"
  if [[ -z "$ctx" ]]; then
    echo "No current kubectl context. Point kubectl at a local cluster first." >&2
    exit 1
  fi
  if [[ "${ALLOW_CONTEXT:-0}" == "1" ]]; then
    echo "==> Context '$ctx' allowed via ALLOW_CONTEXT=1"
    return
  fi
  if [[ "$ctx" != "docker-desktop" ]]; then
    echo "Refusing to deploy: kubectl context is '$ctx', not 'docker-desktop'." >&2
    echo "Switch with:  kubectl config use-context docker-desktop" >&2
    echo "Set ALLOW_CONTEXT=1 to override, only if you are certain." >&2
    exit 1
  fi
  echo "==> Context: $ctx   Namespace: $NAMESPACE"
}
