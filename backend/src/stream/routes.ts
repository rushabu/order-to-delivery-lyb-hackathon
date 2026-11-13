// GET /stream: server-sent events carrying change hints (DESIGN.md 5.8). Bearer token in the header.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx';
import { defineRoute, type RegisteredRoute } from '../http/route';

export function registerStreamRoutes(app: FastifyInstance, ctx: Ctx, reg: RegisteredRoute[]) {
  defineRoute(app, ctx, reg, {
    method: 'GET',
    url: '/stream',
    roles: ['COORDINATOR', 'DRIVER', 'CUSTOMER'],
    summary: 'Server-sent events: `event: change` with {entity, id, version, kinds}; a comment line every 15 s',
    responses: { 200: z.string().describe('text/event-stream') },
    handler: ({ user, raw, reply }) => {
      const origin = raw.headers.origin;
      const headers: Record<string, string> = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      };
      // reply.hijack bypasses the CORS plugin, so repeat its allowlist check here.
      if (origin && ctx.config.corsOrigins.includes(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers.Vary = 'Origin';
      }
      reply.hijack();
      reply.raw.writeHead(200, headers);
      reply.raw.write(': connected\n\n');
      const unsubscribe = ctx.hub.subscribe({ user: user!, write: (chunk) => reply.raw.write(chunk) });
      raw.raw.on('close', unsubscribe);
      return { status: 200, body: '' };
    },
  });
}
