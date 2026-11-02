# reqagent: the CLI tools (reqagent, reqagent-revise, reqagent-conduct) and the web UI in one image.
#   web UI (default):  docker run -p 127.0.0.1:3000:3000 -v ./.env:/app/.env:ro -v ./drafts:/app/drafts reqagent
#   CLI:               docker run -it --rm -v ./.env:/app/.env:ro -v ./drafts:/app/drafts reqagent reqagent runs
# docker-compose.yml wraps both. Secrets are never baked into the image: .env is mounted at run time.
FROM node:22-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    REQAGENT_DRAFTS_DIR=/app/drafts

WORKDIR /app

# dependencies first, so code changes don't reinstall them
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY bin ./bin
COPY src ./src
COPY web ./web
COPY test ./test
COPY examples ./examples

# put the three commands on PATH (reqagent, reqagent-revise, reqagent-conduct)
RUN chmod +x bin/*.js && npm link \
 && mkdir -p drafts && chown -R node:node /app/drafts

USER node
VOLUME ["/app/drafts"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "web/server.js"]
