import bcrypt from "bcryptjs";

const BCRYPT_COST = 10;
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

export async function hashPassword(password: string) {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(password: string, passwordHash: string) {
  if (!isValidPasswordHashFormat(passwordHash)) return false;
  return bcrypt.compare(password, passwordHash);
}

export function isValidPasswordHashFormat(passwordHash: string) {
  return BCRYPT_HASH_PATTERN.test(passwordHash);
}
