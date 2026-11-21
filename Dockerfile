# STRINGER — self-hosted news archive & bias-aware reader. No npm dependencies: just Node 22 (node:sqlite).
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY lib ./lib
COPY public ./public
COPY server.js ./

# everything the server writes (outlets, accounts, the archive) lives in /data — mount a volume there
RUN mkdir -p /data && chown node:node /data
VOLUME /data
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=1337 \
    DATA_DIR=/data
EXPOSE 1337

USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:1337/api/health >/dev/null || exit 1

# bin/run.js supervises server.js and restarts it if it ever exits unexpectedly
CMD ["node", "bin/run.js"]
