#!/usr/bin/env node

const rawUrl = process.argv[2] ?? process.env.DATABASE_URL;

if (!rawUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const url = new URL(rawUrl);

// These parameters configure Prisma's connector/pool, but are not valid libpq
// connection parameters. Keep every standard PostgreSQL parameter untouched.
for (const parameter of [
  "schema",
  "connection_limit",
  "pool_timeout",
  "pgbouncer",
  "statement_cache_size",
  "socket_timeout",
]) {
  url.searchParams.delete(parameter);
}

process.stdout.write(url.toString());
