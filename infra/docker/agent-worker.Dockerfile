ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
COPY services/model-gateway ./services/model-gateway
COPY services/agent-worker ./services/agent-worker
COPY skills ./skills

RUN npm ci --omit=dev --ignore-scripts

USER node
CMD ["node", "--experimental-strip-types", "services/agent-worker/src/main.ts"]
