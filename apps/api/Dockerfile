FROM node:20-alpine AS build
WORKDIR /app

RUN apk add --no-cache openssl ca-certificates

COPY package*.json ./
COPY apps/api/package*.json ./apps/api/
COPY packages/shared/package*.json ./packages/shared/
RUN npm install

COPY . .
RUN npm run build -w @salesforce-pro/shared \
  && npm run prisma:generate -w @salesforce-pro/api \
  && npm run build -w @salesforce-pro/api

FROM node:20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache openssl ca-certificates tini

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package*.json ./apps/api/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/packages/shared/package*.json ./packages/shared/
COPY --from=build /app/packages/shared/dist ./packages/shared/dist

EXPOSE 4000
ENTRYPOINT ["tini", "--"]
CMD ["npm", "run", "docker:start", "-w", "@salesforce-pro/api"]
