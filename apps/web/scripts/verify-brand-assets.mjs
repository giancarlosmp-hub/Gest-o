import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const distRoot = new URL("../dist", import.meta.url).pathname;
const brandDir = join(distRoot, "brand");

const expectedDistFiles = ["favicon.png", "manifest.webmanifest"];
const expectedBrandFiles = ["demetra-logo-dark.png", "demetra-logo-light.png"];

const listDir = (path) => {
  if (!existsSync(path)) {
    console.log(`[verify-brand-assets] missing directory: ${path}`);
    return [];
  }

  const entries = readdirSync(path).sort();
  console.log(`[verify-brand-assets] ${path}`);

  if (entries.length === 0) {
    console.log("  (empty)");
  } else {
    for (const entry of entries) {
      console.log(`  - ${entry}`);
    }
  }

  return entries;
};

const distEntries = listDir(distRoot);
const brandEntries = listDir(brandDir);

const missingDistFiles = expectedDistFiles.filter((file) => !distEntries.includes(file));
const missingBrandFiles = expectedBrandFiles.filter((file) => !brandEntries.includes(file));

if (missingDistFiles.length > 0) {
  console.warn(`[verify-brand-assets] missing expected files in dist/: ${missingDistFiles.join(", ")}`);
}

if (missingBrandFiles.length > 0) {
  console.warn(
    `[verify-brand-assets] missing expected files in dist/brand/: ${missingBrandFiles.join(", ")}`,
  );
}
