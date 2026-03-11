import { Role } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { hashPassword } from "../utils/password.js";

type EnsureUserArgs = {
  name: string;
  email: string;
  password: string;
  role: Role;
  region: string;
};

const REQUIRED_ARGS = ["name", "email", "password", "role", "region"] as const;

function parseRawArgs(argv: string[]) {
  const parsed: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;

    const withoutPrefix = token.slice(2);
    const equalIndex = withoutPrefix.indexOf("=");

    if (equalIndex >= 0) {
      const key = withoutPrefix.slice(0, equalIndex);
      const value = withoutPrefix.slice(equalIndex + 1).trim();
      if (key) parsed[key] = value;
      continue;
    }

    const key = withoutPrefix;
    const next = argv[i + 1];
    if (key && next && !next.startsWith("--")) {
      parsed[key] = next.trim();
      i += 1;
    }
  }

  return parsed;
}

function toRole(roleRaw: string) {
  const normalized = roleRaw.trim().toLowerCase();
  const allowedRoles = Object.values(Role);

  if (!allowedRoles.includes(normalized as Role)) {
    throw new Error(`Parâmetro inválido: --role deve ser um dos valores: ${allowedRoles.join(", ")}`);
  }

  return normalized as Role;
}

function parseArgs(argv: string[]): EnsureUserArgs {
  const raw = parseRawArgs(argv);
  const missing = REQUIRED_ARGS.filter((arg) => !raw[arg] || raw[arg].trim().length === 0);

  if (missing.length > 0) {
    throw new Error(`Parâmetros obrigatórios ausentes: ${missing.map((arg) => `--${arg}`).join(", ")}`);
  }

  return {
    name: raw.name.trim(),
    email: raw.email.trim().toLowerCase(),
    password: raw.password,
    role: toRole(raw.role),
    region: raw.region.trim()
  };
}

async function ensureUser(args: EnsureUserArgs) {
  const passwordHash = await hashPassword(args.password);

  const existingUser = await prisma.user.findUnique({ where: { email: args.email }, select: { id: true } });

  if (!existingUser) {
    await prisma.user.create({
      data: {
        name: args.name,
        email: args.email,
        passwordHash,
        role: args.role,
        region: args.region,
        isActive: true
      }
    });

    console.log(`✅ Usuário criado com sucesso: ${args.email}`);
    return;
  }

  await prisma.user.update({
    where: { id: existingUser.id },
    data: {
      name: args.name,
      passwordHash,
      role: args.role,
      region: args.region,
      isActive: true
    }
  });

  console.log(`✅ Usuário atualizado com sucesso: ${args.email}`);
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    await ensureUser(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro inesperado ao garantir usuário administrativo";
    console.error(`❌ ${message}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
