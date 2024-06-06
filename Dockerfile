FROM node:latest

RUN mkdir /XChainAddressIndexer/
COPY ./package.json /XChainAddressIndexer/package.json
WORKDIR /XChainAddressIndexer
RUN npm install

COPY ./src /XChainAddressIndexer/src
COPY ./.en[v] /XChainAddressIndexer/.env

CMD ["npm", "run", "api"]