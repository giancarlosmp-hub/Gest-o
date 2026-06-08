import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "../config/env.js";

const accessTokenOptions: SignOptions = { expiresIn: env.jwtAccessExpiresIn as SignOptions["expiresIn"] };

export const signAccessToken = (payload: object) => jwt.sign(payload, env.jwtAccessSecret, accessTokenOptions);
export const signRefreshToken = (payload: object) => jwt.sign(payload, env.jwtRefreshSecret, { expiresIn: "7d" });

export const verifyAccessToken = (token: string) => jwt.verify(token, env.jwtAccessSecret);
export const verifyRefreshToken = (token: string) => jwt.verify(token, env.jwtRefreshSecret);
