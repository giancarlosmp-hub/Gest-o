import { isValidPasswordHashFormat, verifyPassword } from "../utils/password.js";

const hashArg = process.argv[2] || process.env.DIAG_PASSWORD_HASH || "";
const passwordArg = process.argv[3] || process.env.DIAG_PASSWORD || "";

async function main() {
  if (!hashArg) {
    console.error("Uso: npm run auth:diagnose-hash -w @salesforce-pro/api -- '<hash>' '<senhaTeste>'");
    process.exitCode = 1;
    return;
  }

  const isValidFormat = isValidPasswordHashFormat(hashArg);
  const hashPrefix = hashArg.slice(0, 4);
  const hashLength = hashArg.length;

  console.log(
    JSON.stringify(
      {
        hashPrefix,
        hashLength,
        isValidFormat
      },
      null,
      2
    )
  );

  if (!passwordArg) {
    return;
  }

  const compareResult = await verifyPassword(passwordArg, hashArg);
  console.log(JSON.stringify({ compareResult }, null, 2));
}

void main();
