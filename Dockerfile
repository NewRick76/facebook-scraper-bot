FROM ghcr.io/puppeteer/puppeteer:23.6.0

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 10000

CMD [ "node", "index.js" ]
