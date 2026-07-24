import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const output = fileURLToPath(new URL("../apps/api/dist/build-info.json", import.meta.url));
const buildInfo = {
  commit: String(process.env.APP_COMMIT || "unknown").trim(),
  version: String(process.env.APP_VERSION || process.env.npm_package_version || "1.0.0").trim(),
  builtAt: String(process.env.APP_BUILT_AT || "unknown").trim()
};

mkdirSync(fileURLToPath(new URL("../apps/api/dist", import.meta.url)), { recursive: true });
writeFileSync(output, `${JSON.stringify(buildInfo, null, 2)}\n`, { mode: 0o644 });
