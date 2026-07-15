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
COPY ./.en[v] /XChainUtxoTracker/.env

CMD ["npm", "run", "api"]