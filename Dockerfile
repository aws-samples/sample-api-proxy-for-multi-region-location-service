FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# Run as the unprivileged built-in `node` user (defense-in-depth: a process
# compromise doesn't get root in the container). /app is owned by root but
# world-readable, which is fine — the app only reads its own files.
USER node
EXPOSE 3000
# Hit the app's own /health endpoint using Node (no curl/wget in node:*-alpine).
# The ALB has its own health check; this satisfies scanners (CKV_DOCKER_2) and
# helps runtimes/orchestrators that read container health.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
CMD ["node", "server.js"]
