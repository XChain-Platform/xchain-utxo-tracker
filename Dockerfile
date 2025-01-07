FROM node:latest

RUN mkdir /XChainUtxoTracker/
RUN mkdir /data/
COPY ./package.json /XChainUtxoTracker/package.json
WORKDIR /XChainUtxoTracker
RUN npm install

COPY ./src /XChainUtxoTracker/src
COPY ./.en[v] /XChainUtxoTracker/.env

CMD ["npm", "run", "api"]