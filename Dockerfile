FROM node:latest

RUN apt-get update && \
    apt-get install -y pigz pv && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir /XChainUtxoTracker/
RUN mkdir /data/
COPY ./package.json /XChainUtxoTracker/package.json
WORKDIR /XChainUtxoTracker
RUN npm install

COPY ./src /XChainUtxoTracker/src
COPY ./.en[v] /XChainUtxoTracker/.env

CMD ["npm", "run", "api"]