FROM node:20-alpine

USER node

COPY lib/server.cjs /usr/src/app/server.cjs

EXPOSE 3000

CMD node /usr/src/app/server.cjs
