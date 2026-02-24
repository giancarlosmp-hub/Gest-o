import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export const signAccessToken = (payload: object) => jwt.sign(payload, env.jwtAccessSecret, { expiresIn: "15m" });
export const signRefreshToken = (payload: object) => jwt.sign(payload, env.jwtRefreshSecret, { expiresIn: "7d" });

export const verifyAccessToken = (token: string) => jwt.verify(token, env.jwtAccessSecret);
export const verifyRefreshToken = (token: string) => jwt.verify(token, env.jwtRefreshSecret);
