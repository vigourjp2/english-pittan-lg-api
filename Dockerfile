FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends link-grammar \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json server.js ./
EXPOSE 8787
CMD ["npm","start"]
