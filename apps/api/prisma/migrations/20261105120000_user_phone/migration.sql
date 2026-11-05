-- Celular/WhatsApp do usuário (55 + DDD + número, só dígitos). Somente aditiva.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "phone" TEXT;
