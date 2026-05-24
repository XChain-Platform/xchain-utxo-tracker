FROM node:22-bookworm

RUN apt-get update && \
    apt-get install -y pigz pv && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir /XChainUtxoTracker/
RUN mkdir /data/
COPY ./package.json /XChainUtxoTracker/package.json
WORKDIR /XChainUtxoTracker
RUN npm install

COPY ./src /XChainUtxoTracker/src
COPY ./src/bufferutils.js /XChainUtxoTracker/node_modules/bitcoinjs-lib/src/bufferutils.js
COPY ./.en[v] /XChainUtxoTracker/.env

CMD ["npm", "run", "api"]