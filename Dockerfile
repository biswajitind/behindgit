# Production image. Git is installed because BehindGit runs real git commands.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
# npm is only used to install dependencies. The server never calls it.
# Drop the global CLI so its own dependency tree is not part of the image.
RUN npm ci --omit=dev \
  && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY server ./server
COPY public ./public
COPY samples ./samples

RUN chown -R node:node /app

USER node

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

EXPOSE 8080

LABEL org.opencontainers.image.source="https://github.com/biswajitind/behindgit" \
      org.opencontainers.image.title="BehindGit" \
      org.opencontainers.image.description="Interactive visualization of Git internals" \
      org.opencontainers.image.licenses="MIT"

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
