FROM node:20-alpine AS build
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
WORKDIR /app
COPY package*.json ./
COPY apps/web/package*.json ./apps/web/
COPY packages/shared/package*.json ./packages/shared/
RUN npm install
COPY . .
RUN npm run build -w @salesforce-pro/shared \
  && npm run build -w @salesforce-pro/web

FROM nginx:alpine
ARG APP_COMMIT=unknown
ARG APP_VERSION=unknown
ARG APP_BUILT_AT=unknown
LABEL org.opencontainers.image.revision=$APP_COMMIT \
      org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.created=$APP_BUILT_AT
RUN apk add --no-cache curl
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
RUN printf '{"version":"%s","commit":"%s","builtAt":"%s"}\n' "$APP_VERSION" "$APP_COMMIT" "$APP_BUILT_AT" > /usr/share/nginx/html/build-info.json
EXPOSE 80
