ARG PLAYWRIGHT_IMAGE
FROM ${PLAYWRIGHT_IMAGE} AS runtime

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY services/browser-executor ./services/browser-executor
RUN npm ci --include=dev --ignore-scripts

ENV NODE_ENV=production
USER pwuser
CMD ["node", "--experimental-strip-types", "services/browser-executor/src/main.ts"]
