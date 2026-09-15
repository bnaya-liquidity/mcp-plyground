# Build context MUST be the monorepo root, not this directory:
#   docker build -f services/mcp-playground/Dockerfile -t mcp-playground:dev .
# The service depends on two workspace packages (@playground/nestjs-mcp,
# @playground/otel-extensions) that are built from source here, so a
# service-scoped context cannot see the code it needs.

FROM node:24-slim AS builder
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo

# Manifests first: this layer is cached until a dependency actually changes,
# so editing source does not re-run the install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/otel-extensions/package.json packages/otel-extensions/
COPY packages/nestjs-mcp/package.json packages/nestjs-mcp/
COPY services/mcp-playground/package.json services/mcp-playground/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json turbo.json ./
COPY packages packages
COPY services services
RUN pnpm run build

# `pnpm deploy` resolves the workspace links into a real, self-contained
# node_modules tree. --legacy is required from pnpm 10 on unless the workspace
# uses the hoisted node-linker; without it the command refuses to run.
RUN pnpm --filter @playground/mcp-playground deploy --prod --legacy /app

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder --chown=node:node /app /app

# Drop root. node:24-slim ships an unprivileged `node` user for exactly this.
USER node

EXPOSE 3000
CMD ["node", "dist/main.js"]
