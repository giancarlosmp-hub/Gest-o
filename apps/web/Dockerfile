FROM node:20-alpine AS build
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
WORKDIR /app
COPY package*.json ./
COPY apps/web/package*.json ./apps/web/
COPY packages/shared/package*.json ./packages/shared/
RUN npm ci
COPY . .
RUN npm run build -w @salesforce-pro/shared \
  && npm run build -w @salesforce-pro/web

FROM nginx:alpine
ARG APP_COMMIT=unknown
ARG APP_VERSION=unknown
ARG APP_BUILT_AT=unknown
ARG PREVIEW_OWNER_REPOSITORY=""
ARG PREVIEW_OWNER_PR=""
ARG PREVIEW_OWNER_RUN_ID=""
ARG PREVIEW_OWNER_RUN_ATTEMPT=""
ARG PREVIEW_OWNER_WORKFLOW=""
ARG PREVIEW_OWNER_SERVICE=""
ARG PREVIEW_OWNER_PROJECT=""
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
RUN apk add --no-cache curl
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
RUN printf '{"version":"%s","commit":"%s","builtAt":"%s"}\n' "$APP_VERSION" "$APP_COMMIT" "$APP_BUILT_AT" > /usr/share/nginx/html/build-info.json
EXPOSE 80
