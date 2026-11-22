FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 tmux ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
COPY tmux.conf ./

ENV NODE_ENV=production
ENV SERVERDECK_CONFIG=/data/config.json
VOLUME ["/data"]
EXPOSE 8090

CMD ["node", "src/server.js"]
