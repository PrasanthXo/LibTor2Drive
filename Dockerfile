FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends aria2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV ARIA2_RPC_URL=http://127.0.0.1:6800/jsonrpc
ENV ARIA2_DOWNLOAD_DIR=/tmp/downloads

EXPOSE 10000

CMD ["node", "server.js"]
