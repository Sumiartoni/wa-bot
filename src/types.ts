import type { Request } from "express";

export type AuthUser = {
  id: number;
  sessionId: string;
  email: string;
  name: string;
  role: string;
  csrfToken: string;
};

export type AuthedRequest = Request & { user: AuthUser };
