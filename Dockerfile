# syntax=docker/dockerfile:1.7

# Pin both stages to the Node 26.8.1 alpine *index* digest so a rebuilt
# floating tag cannot silently change the build or runtime image.
# Dependabot's docker ecosystem refreshes these FROM lines.

# ---- Builder stage -----------------------------------------------------------
# Full dev deps + source, produces the compiled output in /app/dist.
FROM node:26.12.0-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5 AS builder
WORKDIR /app
# .npmrc carries engine-strict=true; copy it before `npm ci` so the supported
# Node engine range is enforced on this Node 26.8.1 image during the build.
COPY package.json package-lock.json .npmrc ./
COPY scripts/install-notice.mjs ./scripts/install-notice.mjs
RUN npm ci
COPY . .
RUN npm run build

# ---- Runtime stage -----------------------------------------------------------
# Production deps, compiled app and the standalone key generator; no dev deps or .git.
FROM node:26.12.0-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5
WORKDIR /app
ENV NODE_ENV=production

# .npmrc copied here too, so engine-strict guards the runtime install as well.
COPY package.json package-lock.json .npmrc ./
# Production dependencies do not require install hooks; the npm onboarding
# notice applies to launcher installations, not this compiled-server image.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scripts/generate-control-key.mjs ./scripts/generate-control-key.mjs

# Non-root user. BusyBox adduser takes -h for the home dir (not GNU's -d) —
# this -d was a pre-existing floating-base-image regression that broke the build.
RUN addgroup -S appuser && adduser -S -G appuser -h /app -s /sbin/nologin appuser \
    && mkdir -p /app/data && chown -R appuser:appuser /app

USER appuser
ENV PORT=3001 DATA_SOURCE=ingest DATA_DIR=/app/data
EXPOSE 3001

# Node 26 has global fetch — no wget/curl in the alpine image.
# Read PORT from the same env the server binds (default 3001).
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/server/server/index.js"]
