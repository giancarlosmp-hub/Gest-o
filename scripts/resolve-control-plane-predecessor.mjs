#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMigration } from "./production-schema-migrations.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tokens = ["model Tenant", "model TenantMembership", "enum TenantStatus", "enum TenantMembershipStatus", "enum TenantRole"];
const containsToken = (schema, token) => new RegExp(`(^|\\n)\\s*${token.replace(" ", "\\s+")}\\s*\\{`, "m").test(schema);
const git = (cwd, args, encoding = "utf8") => execFileSync("git", args, { cwd, encoding, stdio: ["ignore", "pipe", "pipe"] });

export function resolveControlPlanePredecessor({ cwd = root, migration = resolveMigration("20260802120000_tenancy_control_plane") } = {}) {
  const { introCommit, predecessor } = migration;
  if (!introCommit || !predecessor?.commit || !predecessor.schemaPath || !predecessor.schemaSha256) throw new Error("PREDECESSOR_REGISTRY_INCOMPLETE");
  for (const commit of [introCommit, predecessor.commit]) {
    try { git(cwd, ["cat-file", "-e", `${commit}^{commit}`]); } catch { throw new Error(`COMMIT_NOT_FOUND:${commit}`); }
  }
  let introParent;
  try { introParent = git(cwd, ["rev-parse", `${introCommit}^`]).trim(); } catch { throw new Error("INTRO_PARENT_MISMATCH"); }
  if (introParent !== predecessor.commit) throw new Error("INTRO_PARENT_MISMATCH");
  try { git(cwd, ["merge-base", "--is-ancestor", predecessor.commit, introCommit]); } catch { throw new Error("INTRO_NOT_DESCENDANT_OF_PREDECESSOR"); }
  const paths = git(cwd, ["ls-tree", "-r", "--name-only", predecessor.commit]).split("\n").filter(path => /(^|\/)schema\.prisma$/.test(path));
  if (paths.length !== 1) throw new Error(`PREDECESSOR_SCHEMA_AMBIGUOUS:${paths.length}`);
  if (paths[0] !== predecessor.schemaPath) throw new Error(`PREDECESSOR_SCHEMA_PATH_MISMATCH:${paths[0]}`);
  try { git(cwd, ["cat-file", "-e", `${predecessor.commit}:${predecessor.schemaPath}`]); } catch { throw new Error("PREDECESSOR_SCHEMA_NOT_IN_COMMIT"); }
  const schema = git(cwd, ["show", `${predecessor.commit}:${predecessor.schemaPath}`]);
  for (const token of tokens) if (containsToken(schema, token)) throw new Error(`CONTROL_PLANE_TOKEN_IN_PREDECESSOR:${token}`);
  const introSchema = git(cwd, ["show", `${introCommit}:${predecessor.schemaPath}`]);
  for (const token of tokens) if (!containsToken(introSchema, token)) throw new Error(`CONTROL_PLANE_TOKEN_MISSING_FROM_INTRO:${token}`);
  const checksum = createHash("sha256").update(schema).digest("hex");
  const introSchemaSha256 = createHash("sha256").update(introSchema).digest("hex");
  if (checksum !== predecessor.schemaSha256) throw new Error("PREDECESSOR_SCHEMA_CHECKSUM_MISMATCH");
  const migrationPath = migration.path;
  try { git(cwd, ["cat-file", "-e", `${introCommit}:${migrationPath}`]); } catch { throw new Error("CONTROL_PLANE_MIGRATION_MISSING_FROM_INTRO"); }
  const migrations = git(cwd, ["ls-tree", "-r", "--name-only", predecessor.commit]).split("\n")
    .filter(path => /^apps\/api\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(path))
    .map(path => path.split("/").at(-2)).sort();
  const lastMigration = migrations.at(-1);
  if (lastMigration !== predecessor.lastMigration) throw new Error(`LAST_MIGRATION_MISMATCH:${lastMigration}`);
  return { introCommit, predecessorCommit: predecessor.commit, predecessorSchemaPath: predecessor.schemaPath, predecessorSchemaSha256: checksum, introSchemaSha256, lastMigration, schema, introSchema };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = resolveControlPlanePredecessor();
    const outputIndex = process.argv.indexOf("--write-schema");
    if (outputIndex !== -1) {
      const output = process.argv[outputIndex + 1];
      if (!output) throw new Error("WRITE_SCHEMA_PATH_REQUIRED");
      writeFileSync(output, result.schema, { flag: "wx", mode: 0o600 });
    }
    const introOutputIndex = process.argv.indexOf("--write-intro-schema");
    if (introOutputIndex !== -1) {
      const output = process.argv[introOutputIndex + 1];
      if (!output) throw new Error("WRITE_INTRO_SCHEMA_PATH_REQUIRED");
      writeFileSync(output, result.introSchema, { flag: "wx", mode: 0o600 });
    }
    const { schema: _schema, introSchema: _introSchema, ...metadata } = result;
    process.stdout.write(`${JSON.stringify(metadata)}\n`);
  } catch (error) { console.error(error.message); process.exit(2); }
}
