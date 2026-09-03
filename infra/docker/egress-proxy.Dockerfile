ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY services/egress-proxy ./services/egress-proxy

USER node
EXPOSE 3128
CMD ["node", "--experimental-strip-types", "services/egress-proxy/src/main.ts"]
