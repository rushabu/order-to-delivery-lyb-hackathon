// GET /notifications and POST /notifications/:id/read: the caller's own notifications only.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx';
import { notFound } from '../http/errors';
import { defineRoute, type RegisteredRoute } from '../http/route';
import { ErrorResponse, Notification } from '../http/schemas';

const COLS = 'id, user_id, shipment_id, kind, title, body, created_at, read_at';

export function registerNotificationRoutes(app: FastifyInstance, ctx: Ctx, reg: RegisteredRoute[]) {
  defineRoute(app, ctx, reg, {
    method: 'GET',
    url: '/notifications',
    roles: ['COORDINATOR', 'DRIVER', 'CUSTOMER'],
    summary: "The caller's notifications, newest first",
    responses: { 200: z.array(Notification) },
    handler: ({ user }) => ({
      status: 200,
      body: ctx.db.prepare(`SELECT ${COLS} FROM notifications WHERE user_id = ? ORDER BY seq DESC`).all(user!.id),
    }),
  });

  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'POST',
    url: '/notifications/:id/read',
    roles: ['COORDINATOR', 'DRIVER', 'CUSTOMER'],
    summary: 'Mark one of the caller’s notifications as read',
    params: z.object({ id: z.string().min(1).max(40) }),
    responses: { 200: Notification, 404: ErrorResponse },
    handler: ({ user, params }) => {
      const found = ctx.db.prepare('SELECT 1 FROM notifications WHERE id = ? AND user_id = ?').get(params.id, user!.id);
      if (!found) throw notFound('Notification not found');
      ctx.db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?').run(ctx.clock.nowIso(), params.id);
      return { status: 200, body: ctx.db.prepare(`SELECT ${COLS} FROM notifications WHERE id = ?`).get(params.id) };
    },
  });
}
