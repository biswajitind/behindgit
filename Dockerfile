# Production image. Git is installed because BehindGit runs real git commands.
# Digest pinned so a retagged node:22-bookworm-slim cannot change the build.
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

# Upgrade before installing Git. The pinned base still ships apt 2.6.1
# (CVE-2026-109518, fixed in 2.6.2). bookworm-security has the update.
# ARG is visible to this RUN and is not kept in the runtime image.
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends git ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /sandboxes \
  && chown node:node /sandboxes

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

# HOST is explicit here. `npm start` on a workstation stays on 127.0.0.1.
# Publish the container port to the host loopback, not to every interface.
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    BEHINDGIT_SANDBOX_ROOT=/sandboxes

EXPOSE 8080

LABEL org.opencontainers.image.source="https://github.com/biswajitind/behindgit" \
      org.opencontainers.image.title="BehindGit" \
      org.opencontainers.image.description="Interactive visualization of Git internals" \
      org.opencontainers.image.licenses="MIT"

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
