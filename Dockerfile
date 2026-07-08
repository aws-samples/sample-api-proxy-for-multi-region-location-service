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
CMD ["node", "server.js"]
