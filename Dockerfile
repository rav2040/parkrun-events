FROM node:20-alpine

WORKDIR /usr/src/app

USER node

COPY lib/server.cjs .

EXPOSE 3000

CMD node lib/server.cjs
