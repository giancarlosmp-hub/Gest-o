import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { stripSqlComments } from "../sql-strip-comments.mjs";

// Comments disappear, everything PostgreSQL reads as a string, identifier or body stays.
for (const [name, sql, expected] of [
  ["line comment", 'CREATE TABLE "T" ("id" TEXT); -- comentário\n', 'CREATE TABLE "T" ("id" TEXT);  \n'],
  ["block comment", "SELECT /* x */ 1;", "SELECT   1;"],
  ["nested block comment", "/* a /* b */ DELETE FROM x; */ SELECT 1;", "  SELECT 1;"],
  ["block comment keeps line breaks", "/*\n UPDATE\n*/\nSELECT 1;", " \n\n\nSELECT 1;"],
  ["block comment separates words", "DELETE/**/FROM x;", "DELETE FROM x;"],
  ["-- inside string", "DEFAULT 'a--b'; DELETE FROM x;", "DEFAULT 'a--b'; DELETE FROM x;"],
  ["doubled quote", "DEFAULT 'it''s--x'; UPDATE x;", "DEFAULT 'it''s--x'; UPDATE x;"],
  ["escape string", "DEFAULT E'a\\'--b'; DELETE FROM x;", "DEFAULT E'a\\'--b'; DELETE FROM x;"],
  ["backslash in plain string ends nothing", "DEFAULT 'a\\'; -- x", "DEFAULT 'a\\';  "],
  ["identifier ending in E is not an escape string", "SELECT nome'a\\'; -- x", "SELECT nome'a\\';  "],
  ["unicode string", "SELECT U&'d--x';", "SELECT U&'d--x';"],
  ["-- inside identifier", 'CREATE TABLE "a--b" ("id" TEXT);', 'CREATE TABLE "a--b" ("id" TEXT);'],
  ["doubled quote in identifier", 'SELECT "a""--b";', 'SELECT "a""--b";'],
  ["-- inside block comment", "/* -- */ DELETE FROM x;", "  DELETE FROM x;"],
  ["-- inside $$", "DO $$ BEGIN NULL; END -- $$; DELETE FROM x;", "DO $$ BEGIN NULL; END -- $$; DELETE FROM x;"],
  ["-- inside $tag$", "DO $fx$ BEGIN -- $$ x $fx$; TRUNCATE x;", "DO $fx$ BEGIN -- $$ x $fx$; TRUNCATE x;"],
  ["comments stay inside bodies", "DO $$ BEGIN -- sem DELETE aqui\n NULL; END $$;", "DO $$ BEGIN -- sem DELETE aqui\n NULL; END $$;"],
  ["positional parameter is not a tag", "SELECT $1; -- x", "SELECT $1;  "],
  ["$ inside an identifier is not a tag", "SELECT a$b$ -- x", "SELECT a$b$  "]
]) assert.equal(stripSqlComments(sql), expected, name);

assert.equal(stripSqlComments('CREATE TABLE "data update" ("x""y" TEXT);', { blankIdentifiers: true }), 'CREATE TABLE "" ("" TEXT);');
assert.equal(stripSqlComments("SELECT 'a \"b\" c';", { blankIdentifiers: true }), "SELECT 'a \"b\" c';", "strings keep their double quotes");

// Anything the lexer cannot close, and the setting that changes how strings are read, fails closed.
for (const [name, sql, message] of [
  ["unterminated string", "SELECT 'a;", /string sem fechamento/],
  ["unterminated escape string", "SELECT E'a\\';", /string sem fechamento/],
  ["unterminated identifier", 'SELECT "a;', /identificador sem fechamento/],
  ["unterminated block comment", "/* /* */ SELECT 1;", /comentário \/\* sem fechamento/],
  ["unterminated $$", "DO $$ BEGIN NULL; END;", /corpo \$\$ sem fechamento/],
  ["unterminated $tag$", "DO $fx$ BEGIN NULL; END $$;", /corpo \$fx\$ sem fechamento/],
  ["standard_conforming_strings", "SET standard_conforming_strings = off;", /standard_conforming_strings/],
  ["standard_conforming_strings in any case", "SELECT set_config('STANDARD_CONFORMING_STRINGS', 'off', false);", /standard_conforming_strings/]
]) assert.throws(() => stripSqlComments(sql), message, name);

// The CLI the gate calls writes the result to stdout and exits non-zero on failure.
const cli = resolve(import.meta.dirname, "../sql-strip-comments.mjs");
const dir = mkdtempSync(resolve(tmpdir(), "gesto-sql-strip-"));
try {
  const file = resolve(dir, "migration.sql");
  writeFileSync(file, 'CREATE TABLE "a--b" ("id" TEXT); -- fim\n');
  const kept = spawnSync(process.execPath, [cli, file], { encoding: "utf8" });
  assert.equal(kept.status, 0, kept.stderr);
  assert.equal(kept.stdout, 'CREATE TABLE "a--b" ("id" TEXT);  \n');
  const blanked = spawnSync(process.execPath, [cli, file, "--blank-identifiers"], { encoding: "utf8" });
  assert.equal(blanked.stdout, 'CREATE TABLE "" ("" TEXT);  \n');
  writeFileSync(file, "SELECT 'a;\n");
  const failed = spawnSync(process.execPath, [cli, file], { encoding: "utf8" });
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /string sem fechamento/);
  assert.equal(spawnSync(process.execPath, [cli, file, "--outra"], { encoding: "utf8" }).status, 2);
} finally {
  rmSync(dir, { recursive: true });
}
console.log("SQL comment stripping passed");
