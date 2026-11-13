// POST /auth/login and GET /me (DESIGN.md 5.5, 9.1).
import type { FastifyInstance } from 'fastify';
import { audit } from '../audit';
import type { Ctx } from '../ctx';
import { ApiError } from '../http/errors';
import { defineRoute, type RegisteredRoute } from '../http/route';
import { ErrorResponse, LoginRequest, LoginResponse, User } from '../http/schemas';
import { verifyPassword } from './password';
import type { AuthUser } from './policy';
import { issueToken } from './token';
import { z } from 'zod';

const DemoAccounts = z.array(
  z.object({ id: z.string(), name: z.string(), role: z.enum(['COORDINATOR', 'DRIVER', 'CUSTOMER']), org: z.string() }),
);

/** Login attempts allowed per client address per minute (real time, in memory). */
export const LOGIN_LIMIT_PER_MIN = 10;

export class LoginRateLimiter {
  private hits = new Map<string, number[]>();
  allow(key: string, nowMs: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => nowMs - t < 60_000);
    if (recent.length >= LOGIN_LIMIT_PER_MIN) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(nowMs);
    this.hits.set(key, recent);
    return true;
  }
}

export const toPublicUser = (u: AuthUser) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  customer_id: u.customer_id,
  transporter_id: u.transporter_id,
});

export function registerAuthRoutes(app: FastifyInstance, ctx: Ctx, reg: RegisteredRoute[]) {
  const limiter = new LoginRateLimiter();

  defineRoute<Record<string, never>, Record<string, never>, { email: string; password: string }>(app, ctx, reg, {
    method: 'POST',
    url: '/auth/login',
    roles: 'PUBLIC',
    summary: 'Sign in; returns a bearer token valid for 8 hours',
    body: LoginRequest,
    responses: { 200: LoginResponse, 401: ErrorResponse, 429: ErrorResponse },
    handler: ({ body, raw }) => {
      if (!limiter.allow(raw.ip, Date.now())) {
        throw new ApiError(429, 'RATE_LIMITED', 'Too many sign-in attempts. Try again in a minute.');
      }
      const email = body.email.trim().toLowerCase();
      const row = ctx.db
        .prepare('SELECT id, name, email, role, customer_id, transporter_id, password_hash FROM users WHERE email = ?')
        .get(email) as (AuthUser & { password_hash: string }) | undefined;
      const now = ctx.clock.nowIso();
      if (!row || !verifyPassword(body.password, row.password_hash)) {
        audit(ctx.db, now, row?.id ?? null, 'LOGIN_FAILED', 'user', row?.id ?? null, { email });
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
      }
      audit(ctx.db, now, row.id, 'LOGIN_SUCCEEDED', 'user', row.id, {});
      const { password_hash: _ignored, ...user } = row;
      return { status: 200, body: { token: issueToken(user.id, user.role, ctx.config.jwtSecret, Date.now()), user: toPublicUser(user) } };
    },
  });

  // Demo mode only: one-tap sign-in for the seeded fictional accounts, so a presenter can switch roles
  // without typing passwords. These two routes do not exist when DEMO_MODE is off.
  if (ctx.config.demoMode) {
    defineRoute(app, ctx, reg, {
      method: 'GET',
      url: '/auth/demo-accounts',
      roles: 'PUBLIC',
      summary: 'Demo mode only: the seeded accounts offered for one-tap sign-in',
      responses: { 200: DemoAccounts },
      handler: () => {
        const rows = ctx.db
          .prepare(
            `SELECT u.id, u.name, u.role, COALESCE(c.name, t.name, 'Plant X') AS org
             FROM users u LEFT JOIN customers c ON c.id = u.customer_id LEFT JOIN transporters t ON t.id = u.transporter_id
             ORDER BY CASE u.role WHEN 'COORDINATOR' THEN 0 WHEN 'DRIVER' THEN 1 ELSE 2 END, u.name`,
          )
          .all();
        return { status: 200, body: rows as z.infer<typeof DemoAccounts> };
      },
    });

    defineRoute<Record<string, never>, Record<string, never>, { user_id: string }>(app, ctx, reg, {
      method: 'POST',
      url: '/auth/demo-login',
      roles: 'PUBLIC',
      summary: 'Demo mode only: sign in as a seeded account without a password',
      body: z.object({ user_id: z.string().min(1).max(80) }),
      responses: { 200: LoginResponse, 404: ErrorResponse, 429: ErrorResponse },
      handler: ({ body, raw }) => {
        if (!limiter.allow(raw.ip, Date.now())) {
          throw new ApiError(429, 'RATE_LIMITED', 'Too many sign-in attempts. Try again in a minute.');
        }
        const user = ctx.db
          .prepare('SELECT id, name, email, role, customer_id, transporter_id FROM users WHERE id = ?')
          .get(body.user_id) as AuthUser | undefined;
        if (!user) throw new ApiError(404, 'NOT_FOUND', 'No such demo account');
        audit(ctx.db, ctx.clock.nowIso(), user.id, 'DEMO_LOGIN', 'user', user.id, {});
        return { status: 200, body: { token: issueToken(user.id, user.role, ctx.config.jwtSecret, Date.now()), user: toPublicUser(user) } };
      },
    });
  }

  defineRoute(app, ctx, reg, {
    method: 'GET',
    url: '/me',
    roles: ['COORDINATOR', 'DRIVER', 'CUSTOMER'],
    summary: 'Current user',
    responses: { 200: User },
    handler: ({ user }) => ({ status: 200, body: toPublicUser(user!) }),
  });
}
