import 'express';

/** Authenticated principal attached by the auth middleware. */
export interface AuthContext {
  userId: string;
  organizationId: string;
  role: string;
}

/** Config the app needs (injected into buildApp so tests can supply their own). */
export interface AppConfig {
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  jwtAccessTtlSec: number;
  jwtRefreshTtlSec: number;
  bcryptRounds: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      /** Parsed & validated inputs (populated by the validate() middleware). */
      validated: { body: unknown; query: unknown; params: unknown };
    }
  }
}
