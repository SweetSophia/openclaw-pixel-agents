FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install && npm cache clean --force

COPY . .

RUN npm run build

RUN rm -rf node_modules && npm install --omit=dev && npm cache clean --force

# Run as non-root user
RUN groupadd -r appuser && useradd -r -g appuser -d /app -s /sbin/nologin appuser

ENV PORT=3400
ENV DATA_SOURCE=ingest
ENV DATA_DIR=/app/data
EXPOSE 3400

# Create data dir owned by appuser
RUN mkdir -p /app/data && chown -R appuser:appuser /app/data /app

USER appuser

CMD ["node", "dist/server/server/index.js"]
