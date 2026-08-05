# node:22-alpine, nothing else. There are no dependencies to install — the
# server is one file using only Node's standard library — so the image is the
# base plus a handful of static files.
#
# Nixpacks would work, but it pulls a multi-hundred-megabyte builder to run
# forty lines of Node. This builds in seconds and ships about 60 MB.
FROM node:22-alpine

WORKDIR /app
COPY server.js package.json ./
COPY *.html style.css ./

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER node
CMD ["node", "server.js"]
