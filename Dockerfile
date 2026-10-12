# syntax=docker/dockerfile:1
# Base image pinned by digest: the multi-arch index of node:24-slim, read from the Docker Hub registry on 2026-10-11.
# Dependabot (docker ecosystem) proposes digest updates for these FROM lines.
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
# NOTE: this image does NOT include the official `proton-drive` CLI, which the
# server shells out to. Provide it separately: bind-mount the binary and set
# PROTON_DRIVE_BIN, or extend this image with a layer that installs it.
USER node
CMD ["node", "dist/index.js"]
