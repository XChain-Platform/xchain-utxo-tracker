FROM node:22-bookworm

RUN apt-get update && \
    apt-get install -y pigz pv && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir /XChainUtxoTracker/
RUN mkdir /data/
COPY ./package.json /XChainUtxoTracker/package.json
COPY ./package-lock.json /XChainUtxoTracker/package-lock.json
WORKDIR /XChainUtxoTracker
RUN npm ci --omit=dev

COPY ./src /XChainUtxoTracker/src
# BigInt-aware 64-bit reader patch (DOGE outputs can exceed 2^53-1 sat). Belt-and-
# braces: the same patch is also applied in-process at require time
# (src/applyBufferutilsPatch.js), so non-Docker runs are covered without this COPY.
COPY ./src/bufferutils.js /XChainUtxoTracker/node_modules/bitcoinjs-lib/src/bufferutils.js
# No .env is baked in: configuration reaches the container as environment
# (xchain-node at `docker run`, docker-compose.yml via env_file). An optional
# `COPY ./.en[v]` glob here builds only under BuildKit.

# Exec-form node, not `npm run api` (which is this exact command). npm builds an
# npm -> sh -c -> node tree and no wrapper forwards signals, so `docker stop`
# killed npm while node was never told anything and the container exited 1.
# This image registers real drain work on SIGTERM (src/shutdown.js: stop the
# block loop at a boundary, close the listener and the store), which only runs
# when node is PID 1 and receives the signal itself. --max-old-space-size is
# carried verbatim from the package.json `api` script.
CMD ["node", "--max-old-space-size=4096", "./src/api.js"]