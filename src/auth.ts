import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import jwt, { type SignOptions } from "jsonwebtoken";
import { z } from "zod";
import { config } from "./config.js";
import { prisma } from "./db.js";
import type { AuthUser } from "./types.js";

const tokenPayloadSchema = z.object({
  sub: z.coerce.number(),
  sid: z.string(),
  email: z.string().email(),
  name: z.string(),
  role: z.string(),
  csrfToken: z.string()
});

export function createCsrfToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function signAuthToken(user: Omit<AuthUser, "csrfToken">, csrfToken = createCsrfToken()) {
  return jwt.sign(
    { sub: user.id, sid: user.sessionId, email: user.email, name: user.name, role: user.role, csrfToken },
    config.JWT_SECRET,
    { expiresIn: config.JWT_EXPIRES_IN as SignOptions["expiresIn"] }
  );
}

export function authCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.COOKIE_SECURE,
    path: "/"
  };
}

export function readToken(req: Request) {
  const authHeader = req.header("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }
  return typeof req.cookies?.auth_token === "string" ? req.cookies.auth_token : null;
}

export function decodeAuthToken(token: string): AuthUser | null {
  try {
    const payload = tokenPayloadSchema.parse(jwt.verify(token, config.JWT_SECRET));
    return {
      id: payload.sub,
      sessionId: payload.sid,
      email: payload.email,
      name: payload.name,
      role: payload.role,
      csrfToken: payload.csrfToken
    };
  } catch {
    return null;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = readToken(req);
  const user = token ? decodeAuthToken(token) : null;
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const exists = await prisma.user.findUnique({ where: { id: user.id } });
  const session = await prisma.adminSession.findUnique({ where: { sessionId: user.sessionId } });
  if (!exists || !session || session.revokedAt) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  (req as Request & { user: AuthUser }).user = user;
  next();
}

export function requireRole(roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as Request & { user?: AuthUser }).user;
    if (!user || !roles.includes(user.role)) {
      res.status(403).json({ error: "Insufficient role" });
      return;
    }
    next();
  };
}

export function requireCsrf(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }
  const user = (req as Request & { user?: AuthUser }).user;
  const headerToken = req.header("x-csrf-token");
  if (!user || !headerToken || headerToken !== user.csrfToken) {
    res.status(403).json({ error: "Valid CSRF token required" });
    return;
  }
  next();
}
