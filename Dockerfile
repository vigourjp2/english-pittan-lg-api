FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends link-grammar \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY README*.md ./

ENV NODE_ENV=production
CMD ["npm", "start"]
