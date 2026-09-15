#!/usr/bin/env bash
# Removes both Helm releases and the namespace.
#
# Deleting the namespace takes everything in it with it, so the context guard
# applies here exactly as it does to the deploy scripts — arguably more, since
# this is the irreversible direction.
source "$(dirname "${BASH_SOURCE[0]}")/_guard.sh"
require_local_context

echo "==> Uninstalling releases in namespace '$NAMESPACE'"
# --ignore-not-found keeps this idempotent: running it twice, or after a partial
# install, should report the end state rather than fail.
helm uninstall mcp-playground --namespace "$NAMESPACE" --ignore-not-found
helm uninstall mcp-playground-servers --namespace "$NAMESPACE" --ignore-not-found

echo "==> Deleting namespace '$NAMESPACE'"
kubectl delete namespace "$NAMESPACE" --ignore-not-found --wait=false

echo "==> Done. Namespace deletion runs in the background:"
echo "    kubectl get ns $NAMESPACE"
