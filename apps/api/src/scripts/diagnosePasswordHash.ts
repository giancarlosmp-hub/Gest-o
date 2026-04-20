import { prisma } from "../config/prisma.js";
import { verifyPassword } from "../utils/password.js";

async function main() {
  const email = (process.env.ADMIN_DIAG_EMAIL || "admin@preview.local").trim().toLowerCase();
  const password = process.env.ADMIN_DIAG_PASSWORD || "123456";

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      role: true,
      isActive: true,
      passwordHash: true,
      createdAt: true
    }
  });

  if (!user) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          reason: "user_not_found",
          email
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const passwordMatches = await verifyPassword(password, user.passwordHash);

  console.log(
    JSON.stringify(
      {
        ok: passwordMatches,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
        passwordHashPrefix: user.passwordHash.slice(0, 12),
        passwordHashLength: user.passwordHash.length,
        passwordMatches
      },
      null,
      2
    )
  );

  if (!passwordMatches) {
    process.exit(2);
  }
}

main()
  .catch((error) => {
    console.error("[admin:diagnose-hash] failed", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });