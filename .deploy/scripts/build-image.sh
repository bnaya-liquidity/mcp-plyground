#!/usr/bin/env bash
# Builds the mcp-playground image from the monorepo root.
# Env: IMAGE_REPO (default mcp-playground), IMAGE_TAG (default dev)
source "$(dirname "${BASH_SOURCE[0]}")/_guard.sh"

echo "==> Building $IMAGE_REPO:$IMAGE_TAG"
docker build \
  -f "$REPO_ROOT/services/mcp-playground/Dockerfile" \
  -t "$IMAGE_REPO:$IMAGE_TAG" \
  "$REPO_ROOT"
