#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Removes SQL comments the way PostgreSQL reads them, so the schema gates never mistake a "--"
// inside a string, identifier or dollar-quoted body for a comment. Strings and dollar-quoted bodies
// are kept verbatim (their content is still checked); comments become a space and keep their line
// breaks, so line-based checks see the same lines. Anything the lexer cannot close fails closed.
const identifierChar = /[A-Za-z0-9_$\u0080-￿]/;
const dollarTag = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;

export function stripSqlComments(sql, { blankIdentifiers = false } = {}) {
  // With standard_conforming_strings off, backslashes escape quotes in plain strings and this lexer
  // would read them differently from PostgreSQL.
  if (/standard_conforming_strings/i.test(sql)) throw new Error("standard_conforming_strings não é permitido");
  let out = "";
  let i = 0;
  const follows = () => i > 0 && identifierChar.test(sql[i - 1]);
  const tagAt = (at) => { dollarTag.lastIndex = at; return dollarTag.exec(sql)?.[0]; };
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") i++;
      out += " ";
    } else if (ch === "/" && next === "*") {
      let depth = 1;
      out += " ";
      i += 2;
      while (depth > 0) {
        if (i >= sql.length) throw new Error("comentário /* sem fechamento");
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
        else { if (sql[i] === "\n" || sql[i] === "\r") out += sql[i]; i++; }
      }
    } else if (ch === "'" || ((ch === "E" || ch === "e") && next === "'" && !follows())) {
      const escapes = ch !== "'";
      const start = i;
      i += escapes ? 2 : 1;
      for (;;) {
        if (i >= sql.length) throw new Error("string sem fechamento");
        if (escapes && sql[i] === "\\") { i += 2; continue; }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += sql.slice(start, i);
    } else if (ch === '"') {
      const start = i;
      i++;
      for (;;) {
        if (i >= sql.length) throw new Error("identificador sem fechamento");
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += blankIdentifiers ? '""' : sql.slice(start, i);
    } else if (ch === "$" && !follows() && tagAt(i)) {
      const tag = tagAt(i);
      const end = sql.indexOf(tag, i + tag.length);
      if (end < 0) throw new Error(`corpo ${tag} sem fechamento`);
      out += sql.slice(i, end + tag.length);
      i = end + tag.length;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, flag] = process.argv.slice(2);
  try {
    if (!file || (flag && flag !== "--blank-identifiers")) throw new Error("uso: sql-strip-comments.mjs ARQUIVO [--blank-identifiers]");
    process.stdout.write(stripSqlComments(readFileSync(file, "utf8"), { blankIdentifiers: flag === "--blank-identifiers" }));
  } catch (error) { console.error(error.message); process.exit(2); }
}
