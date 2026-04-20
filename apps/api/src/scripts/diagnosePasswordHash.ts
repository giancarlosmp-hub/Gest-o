import { prisma } from "../config/prisma.js";
import { verifyPassword, isValidPasswordHashFormat } from "../utils/password.js";

async function main() {
  const email = (process.env.ADMIN_DIAG_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_DIAG_PASSWORD || "";

  // ===============================
  // MODO 1: DIAGNÓSTICO VIA BANCO
  // ===============================
  if (email) {
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        email: true,
        role: true,
        isActive: true,
        passwordHash: true
      }
    });

    if (!user) {
      console.log(JSON.stringify({
        ok: false,
        reason: "user_not_found",
        email
      }, null, 2));
      process.exit(1);
    }

    const passwordMatches = await verifyPassword(password, user.passwordHash);

    console.log(JSON.stringify({
      mode: "db_lookup",
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      hashPrefix: user.passwordHash.slice(0, 4),
      hashLength: user.passwordHash.length,
      isValidFormat: isValidPasswordHashFormat(user.passwordHash),
      passwordMatches
    }, null, 2));

    return;
  }

  // ===============================
  // MODO 2: TESTE MANUAL
  // ===============================
  const hashArg = process.argv[2];
  const passwordArg = process.argv[3];

  if (!hashArg) {
    console.error("Uso: npm run auth:diagnose-hash -- '<hash>' '<senha>'");
    process.exit(1);
  }

  const passwordMatches = passwordArg
    ? await verifyPassword(passwordArg, hashArg)
    : null;

  console.log(JSON.stringify({
    mode: "manual",
    hashPrefix: hashArg.slice(0, 4),
    hashLength: hashArg.length,
    isValidFormat: isValidPasswordHashFormat(hashArg),
    passwordMatches
  }, null, 2));
}

main()
  .catch((err) => {
    console.error("diagnose failed", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });