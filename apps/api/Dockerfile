FROM node:20-alpine AS build
WORKDIR /app

ARG APP_COMMIT=unknown
ARG APP_VERSION=1.0.0
ARG APP_BUILT_AT=unknown
ARG PREVIEW_OWNER_REPOSITORY=""
ARG PREVIEW_OWNER_PR=""
ARG PREVIEW_OWNER_RUN_ID=""
ARG PREVIEW_OWNER_RUN_ATTEMPT=""
ARG PREVIEW_OWNER_WORKFLOW=""
ARG PREVIEW_OWNER_SERVICE=""
ARG PREVIEW_OWNER_PROJECT=""
ENV APP_COMMIT=$APP_COMMIT APP_VERSION=$APP_VERSION APP_BUILT_AT=$APP_BUILT_AT
LABEL org.opencontainers.image.revision=$APP_COMMIT \
      org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.created=$APP_BUILT_AT \
      com.gesto.preview.repository=$PREVIEW_OWNER_REPOSITORY \
      com.gesto.preview.pr=$PREVIEW_OWNER_PR \
      com.gesto.preview.run-id=$PREVIEW_OWNER_RUN_ID \
      com.gesto.preview.run-attempt=$PREVIEW_OWNER_RUN_ATTEMPT \
      com.gesto.preview.workflow=$PREVIEW_OWNER_WORKFLOW \
      com.gesto.preview.commit=$APP_COMMIT \
      com.gesto.preview.service=$PREVIEW_OWNER_SERVICE \
      com.gesto.preview.project=$PREVIEW_OWNER_PROJECT

RUN apk add --no-cache openssl ca-certificates

COPY package*.json ./
COPY apps/api/package*.json ./apps/api/
COPY packages/shared/package*.json ./packages/shared/
RUN npm install

COPY apps/api/prisma ./apps/api/prisma
COPY . .
RUN npm run build -w @salesforce-pro/shared \
  && npx prisma generate --schema=apps/api/prisma/schema.prisma \
  && npm run build -w @salesforce-pro/api

FROM node:20-alpine AS runtime
WORKDIR /app

ARG APP_COMMIT=unknown
ARG APP_VERSION=1.0.0
ARG APP_BUILT_AT=unknown
ARG PREVIEW_OWNER_REPOSITORY=""
ARG PREVIEW_OWNER_PR=""
ARG PREVIEW_OWNER_RUN_ID=""
ARG PREVIEW_OWNER_RUN_ATTEMPT=""
ARG PREVIEW_OWNER_WORKFLOW=""
ARG PREVIEW_OWNER_SERVICE=""
ARG PREVIEW_OWNER_PROJECT=""
ENV APP_COMMIT=$APP_COMMIT APP_VERSION=$APP_VERSION APP_BUILT_AT=$APP_BUILT_AT
LABEL org.opencontainers.image.revision=$APP_COMMIT \
      org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.created=$APP_BUILT_AT \
      com.gesto.preview.repository=$PREVIEW_OWNER_REPOSITORY \
      com.gesto.preview.pr=$PREVIEW_OWNER_PR \
      com.gesto.preview.run-id=$PREVIEW_OWNER_RUN_ID \
      com.gesto.preview.run-attempt=$PREVIEW_OWNER_RUN_ATTEMPT \
      com.gesto.preview.workflow=$PREVIEW_OWNER_WORKFLOW \
      com.gesto.preview.commit=$APP_COMMIT \
      com.gesto.preview.service=$PREVIEW_OWNER_SERVICE \
      com.gesto.preview.project=$PREVIEW_OWNER_PROJECT

RUN apk add --no-cache openssl ca-certificates tini \
  && mkdir -p apps/api/dist/public/brand

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/apps/api/package*.json ./apps/api/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/public/brand/demetra-logo-dark.png ./apps/api/dist/public/brand/demetra-logo-dark.png
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/packages/shared/package*.json ./packages/shared/
COPY --from=build /app/packages/shared/dist ./packages/shared/dist

EXPOSE 4000
ENTRYPOINT ["tini", "--"]
CMD ["npm", "run", "docker:start", "-w", "@salesforce-pro/api"]
