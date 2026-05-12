import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const FORMAT_PREFIX = "v1";

const deriveKey = () => {
  if (!env.erpCredentialEncryptionKey) {
    throw new Error("ERP_CREDENTIAL_ENCRYPTION_KEY não configurada para criptografar credenciais ERP.");
  }
  return createHash("sha256").update(env.erpCredentialEncryptionKey).digest();
};

export function encryptErpCredential(plainText: string) {
  const normalized = plainText.trim();
  if (!normalized) return null;
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveKey(), iv, { authTagLength: AUTH_TAG_LENGTH_BYTES });
  const encrypted = Buffer.concat([cipher.update(normalized, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_PREFIX, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(":");
}

export function decryptErpCredential(cipherText: string) {
  const [version, ivValue, tagValue, encryptedValue] = cipherText.split(":");
  if (version !== FORMAT_PREFIX || !ivValue || !tagValue || !encryptedValue) {
    throw new Error("Formato inválido da credencial ERP criptografada.");
  }
  const decipher = createDecipheriv(ALGORITHM, deriveKey(), Buffer.from(ivValue, "base64url"), { authTagLength: AUTH_TAG_LENGTH_BYTES });
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
}

export function isErpCredentialEncryptionConfigured() {
  return Boolean(env.erpCredentialEncryptionKey);
}
