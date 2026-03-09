import dotenv from "dotenv";

dotenv.config();

function toBoolean(value: string | undefined, defaultValue = false) {
  if (value == null) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 4000),
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || "access-secret",
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || "refresh-secret",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
  seedOnBootstrap: toBoolean(process.env.SEED_ON_BOOTSTRAP, false)
};
