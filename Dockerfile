# syntax=docker/dockerfile:1.7

# ---- Builder stage -----------------------------------------------------------
# Full dev deps + source, produces the compiled output in /app/dist.
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Runtime stage -----------------------------------------------------------
# Production deps only + compiled dist. No source, no dev deps, no .git.
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Non-root user
RUN addgroup -S appuser && adduser -S -G appuser -d /app -s /sbin/nologin appuser \
    && mkdir -p /app/data && chown -R appuser:appuser /app

USER appuser
ENV PORT=3001 DATA_SOURCE=ingest DATA_DIR=/app/data
EXPOSE 3001

CMD ["node", "dist/server/server/index.js"]
