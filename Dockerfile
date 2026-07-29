# syntax=docker/dockerfile:1.7

# ---- Builder stage -----------------------------------------------------------
# Full dev deps + source, produces the compiled output in /app/dist.
FROM node:22-alpine AS builder
WORKDIR /app
# .npmrc carries engine-strict=true; copy it before `npm ci` so the Node floor
# (22.22.2 on this Node 22 image) is enforced during the image build.
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Runtime stage -----------------------------------------------------------
# Production deps only + compiled dist. No source, no dev deps, no .git.
FROM node:22-alpine
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

CMD ["node", "dist/server/server/index.js"]
