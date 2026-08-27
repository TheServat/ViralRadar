# Optional container image. `npm start` on the host is the supported path;
# this exists for anyone who prefers to run it in Docker.
#
#   docker build -f infrastructure/docker/Dockerfile -t viral-radar .
#   docker run --rm -p 7788:7788 -v viral-radar-data:/app/data --env-file .env viral-radar
#
# There is nothing else to orchestrate: no database server, no cache, no broker.
FROM node:24-alpine

WORKDIR /app

# Only TypeScript and @types/node, and only for `npm run typecheck`.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY .env.example ./.env.example

# The database lives on a volume so it survives image rebuilds.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV HOST=0.0.0.0 PORT=7788 LOG_FORMAT=json
EXPOSE 7788

# HOST=0.0.0.0 means the server requires API_TOKEN; it refuses to start without one.
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:7788/api/v1/system/health?token='+(process.env.API_TOKEN??'')).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/main.ts", "serve"]
