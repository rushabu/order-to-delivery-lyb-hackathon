// One helper to declare every route: method, path, allowed roles, Zod schemas and handler.
// It authenticates, checks the role, validates input, validates output (outside production),
// and records the route for /openapi.json. Every route must declare `roles` (DESIGN.md 9.1).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, forbidden, unauthorized, validationFailed } from './errors';
import type { AuthUser } from '../auth/policy';
import type { Ctx } from '../ctx';
import { verifyToken } from '../auth/token';
import { audit } from '../audit';

export type RoleName = 'COORDINATOR' | 'DRIVER' | 'CUSTOMER';

export interface RouteDef<P, Q, B> {
  method: 'GET' | 'POST';
  url: string; // relative to /api/v1
  roles: 'PUBLIC' | RoleName[];
  summary: string;
  params?: z.ZodType<P>;
  query?: z.ZodType<Q>;
  body?: z.ZodType<B>;
  /** Response schemas by status code. */
  responses: Record<number, z.ZodType>;
  handler: (req: {
    user: AuthUser | null;
    params: P;
    query: Q;
    body: B;
    raw: FastifyRequest;
    reply: FastifyReply;
  }) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown };
}

export interface RegisteredRoute {
  method: string;
  url: string;
  roles: 'PUBLIC' | RoleName[];
  summary: string;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  responses: Record<number, z.ZodType>;
}

export const API_PREFIX = '/api/v1';

export function defineRoute<P = Record<string, never>, Q = Record<string, never>, B = undefined>(
  app: FastifyInstance,
  ctx: Ctx,
  registry: RegisteredRoute[],
  def: RouteDef<P, Q, B>,
): void {
  registry.push(def as unknown as RegisteredRoute);
  app.route({
    method: def.method,
    url: API_PREFIX + def.url,
    handler: async (request, reply) => {
      const user = def.roles === 'PUBLIC' ? null : authenticate(ctx, request);
      if (user && def.roles !== 'PUBLIC' && !def.roles.includes(user.role)) {
        audit(ctx.db, ctx.clock.nowIso(), user.id, 'ACCESS_DENIED', 'route', null, {
          path: request.url,
          method: request.method,
        });
        throw forbidden();
      }
      const params = parse(def.params, request.params, 'path parameters') as P;
      const query = parse(def.query, request.query, 'query') as Q;
      const body = parse(def.body, request.body, 'body') as B;
      const result = await def.handler({ user, params, query, body, raw: request, reply });
      if (reply.sent) return reply; // streaming routes write to the socket themselves
      const schema = def.responses[result.status];
      if (ctx.config.validateResponses) {
        if (!schema) throw new Error(`No response schema for ${def.method} ${def.url} ${result.status}`);
        const check = schema.safeParse(result.body);
        if (!check.success) {
          request.log.error({ issues: check.error.issues }, 'response failed its schema');
          throw new Error(`Response for ${def.method} ${def.url} does not match its schema`);
        }
      }
      return reply.status(result.status).send(result.body);
    },
  });
}

function parse(schema: z.ZodType | undefined, value: unknown, where: string): unknown {
  if (!schema) return value;
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw validationFailed(`Invalid ${where}`, {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

function authenticate(ctx: Ctx, request: FastifyRequest): AuthUser {
  const header = request.headers.authorization ?? '';
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) throw unauthorized();
  const claims = verifyToken(m[1], ctx.config.jwtSecret, Date.now());
  if (!claims) throw unauthorized('Token is invalid or expired');
  const row = ctx.db
    .prepare('SELECT id, name, email, role, customer_id, transporter_id FROM users WHERE id = ?')
    .get(claims.sub) as AuthUser | undefined;
  // After a demo reset the user ids are the same, so tokens stay valid; an unknown id is refused.
  if (!row || row.role !== claims.role) throw unauthorized('Token is invalid or expired');
  return row;
}

export { ApiError };
