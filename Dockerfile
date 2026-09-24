FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=1234 DATA_DIR=/data
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --from=build /app/server/dist server/dist
COPY package.json .
VOLUME /data
EXPOSE 1234
CMD ["node", "server/dist/index.js"]
