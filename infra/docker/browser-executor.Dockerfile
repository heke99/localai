ARG PLAYWRIGHT_IMAGE
FROM ${PLAYWRIGHT_IMAGE} AS deps

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services
RUN npm ci --ignore-scripts \
  && node -e "const major=Number(process.versions.node.split('.')[0]); if (major < 24) throw new Error('Node 24+ required')" \
  && node -e "const p=require('@playwright/test/package.json'); if (p.version !== '1.62.1') throw new Error('Playwright 1.62.1 required')"

FROM ${PLAYWRIGHT_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./package.json
COPY services/browser-executor ./services/browser-executor

USER pwuser
CMD ["node", "--experimental-strip-types", "services/browser-executor/src/main.ts"]
