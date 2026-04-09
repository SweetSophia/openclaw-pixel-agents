FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install && npm cache clean --force

COPY . .

RUN npm run build

RUN rm -rf node_modules && npm install --omit=dev && npm cache clean --force

ENV PORT=3400
ENV DATA_SOURCE=ingest
ENV DATA_DIR=/app/data
EXPOSE 3400

CMD ["node", "dist/server/server/index.js"]
