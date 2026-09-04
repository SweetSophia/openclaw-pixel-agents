# syntax=docker/dockerfile:1.7

# Pin both stages to the Node 22.22.2 alpine *index* digest so a rebuilt
# floating tag cannot silently change the build or runtime image.
# Dependabot's docker ecosystem refreshes these FROM lines.

# ---- Builder stage -----------------------------------------------------------
# Full dev deps + source, produces the compiled output in /app/dist.
FROM node:26.8.1-alpine@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3 AS builder
WORKDIR /app
# .npmrc carries engine-strict=true; copy it before `npm ci` so the Node floor
# (22.22.2 on this Node 22 image) is enforced during the image build.
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Runtime stage -----------------------------------------------------------
# Production deps only + compiled dist. No source, no dev deps, no .git.
FROM node:26.8.1-alpine@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3
WORKDIR /app
ENV NODE_ENV=production

# .npmrc copied here too, so engine-strict guards the runtime install as well.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Non-root user. BusyBox adduser takes -h for the home dir (not GNU's -d) —
# this -d was a pre-existing floating-base-image regression that broke the build.
RUN addgroup -S appuser && adduser -S -G appuser -h /app -s /sbin/nologin appuser \
    && mkdir -p /app/data && chown -R appuser:appuser /app

USER appuser
ENV PORT=3001 DATA_SOURCE=ingest DATA_DIR=/app/data
EXPOSE 3001

# Node 22 has global fetch — no wget/curl in the alpine image.
# Read PORT from the same env the server binds (default 3001).
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/server/server/index.js"]
