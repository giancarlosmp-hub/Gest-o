#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const input = readFileSync(process.argv[2], "utf8");
const managed = /ErpOrderManualResolution|ErpOrderManualResolutionCategory|ErpOrderManualResolutionTerminalState|supersedesErpOrderSyncId/;
const statements = input
  .replace(/--[^\n]*(?:\n|$)/g, "\n")
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean)
  .filter((statement) => managed.test(statement));
writeFileSync(process.argv[3], statements.map((statement) => `${statement};\n`).join(""));
