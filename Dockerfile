FROM node:22-alpine AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile

COPY apps/api apps/api
COPY apps/web apps/web
COPY packages/contracts packages/contracts
RUN pnpm --filter @x-router/contracts build \
  && pnpm --filter @x-router/api build \
  && pnpm --filter @x-router/web build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV NODE_USE_ENV_PROXY=1
ENV WEB_ROOT=/app/apps/web/dist
WORKDIR /app
RUN node --help | grep -q -- '--use-env-proxy' \
  && addgroup -S xrouter \
  && adduser -S xrouter -G xrouter

COPY --from=builder --chown=xrouter:xrouter /app/node_modules ./node_modules
COPY --from=builder --chown=xrouter:xrouter /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder --chown=xrouter:xrouter /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder --chown=xrouter:xrouter /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=xrouter:xrouter /app/apps/web/dist ./apps/web/dist
COPY --from=builder --chown=xrouter:xrouter /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=builder --chown=xrouter:xrouter /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=builder --chown=xrouter:xrouter /app/packages/contracts/dist ./packages/contracts/dist

USER xrouter
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=5s --retries=10 --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4000/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/index.js"]
