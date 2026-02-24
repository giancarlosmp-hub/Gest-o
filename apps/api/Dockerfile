FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
COPY apps/api/package*.json ./apps/api/
COPY packages/shared/package*.json ./packages/shared/
RUN npm install

COPY . .

RUN npm run prisma:generate -w @salesforce-pro/api \
  && npm run build -w @salesforce-pro/api

EXPOSE 4000

CMD ["sh", "-c", "until npm run prisma:push -w @salesforce-pro/api; do echo 'Aguardando Postgres...'; sleep 2; done; npm run prisma:seed -w @salesforce-pro/api; node apps/api/dist/server.js"]
