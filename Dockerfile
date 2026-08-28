ARG NODE_IMAGE=node:22.23.2-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
ARG BUILDPLATFORM=linux/amd64
# Keep dependency installation and bundling native; the target stage below has no RUN instructions.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS dependencies

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN node --help | grep -q -- '--use-env-proxy' \
  && corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS production-dependencies

# Keep only the API production dependency closure. The workspace contract is
# copied as its own runtime layer below so contract-only changes stay tiny.
RUN pnpm --filter @x-router/api deploy --prod /prod/api \
  && pnpm --filter @x-router/contracts deploy --prod /prod/contracts \
  && contract_dir="$(readlink -f /prod/api/node_modules/@x-router/contracts)" \
  && case "$contract_dir" in \
    /prod/api/node_modules/.pnpm/*/node_modules/@x-router/contracts) ;; \
    *) printf 'Unexpected injected contracts path: %s\n' "$contract_dir" >&2; exit 1 ;; \
  esac \
  && rm -rf -- "$contract_dir" \
  && rm -f /prod/api/node_modules/@x-router/contracts \
  && for deployed_dir in /prod/api /prod/contracts; do \
    rm -f \
      "$deployed_dir/node_modules/.modules.yaml" \
      "$deployed_dir/node_modules/.pnpm-workspace-state-v1.json" \
      "$deployed_dir/node_modules/.pnpm/lock.yaml"; \
  done \
  && ln -s ../../../../packages/contracts /prod/api/node_modules/@x-router/contracts

FROM dependencies AS builder

COPY apps/api apps/api
COPY apps/web apps/web
COPY packages/contracts packages/contracts
RUN pnpm --filter @x-router/contracts build \
  && pnpm --filter @x-router/api build \
  && pnpm --filter @x-router/web build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
ENV NODE_USE_ENV_PROXY=1
ENV WEB_ROOT=/app/apps/web/dist
WORKDIR /app

COPY --from=production-dependencies --chown=node:node /prod/api/node_modules ./apps/api/node_modules
COPY --from=builder --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=production-dependencies --chown=node:node /prod/contracts/node_modules ./packages/contracts/node_modules
COPY --from=builder --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=builder --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=node:node /app/apps/web/dist ./apps/web/dist

ARG BUILD_SHA=development
ENV BUILD_SHA=$BUILD_SHA

USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=5s --retries=10 --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4000/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/index.js"]
