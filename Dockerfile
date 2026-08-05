# node:22-alpine, nothing else. There are no dependencies to install, since the
# build script and the server both use only Node's standard library.
#
# Two stages, so the running image carries the site and nothing that made it:
# no templates, no content.json, no build script.
FROM node:24-alpine AS build
WORKDIR /app
COPY content.json build.js ./
COPY src ./src
COPY assets ./assets
RUN node build.js

FROM node:24-alpine
WORKDIR /app
COPY package.json server.js ./
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER node
CMD ["node", "server.js"]
