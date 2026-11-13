// GET /dashboard/on-time, GET /dashboard/delay-causes, GET /metrics/impact. Coordinators only.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx';
import { defineRoute, type RegisteredRoute } from '../http/route';
import { DelayCausesResponse, GroupBy, ImpactResponse, OnTimeResponse } from '../http/schemas';
import { delayCauses, impact, onTime } from './queries';

const Query = z.object({ group_by: GroupBy.default('route') });

export function registerDashboardRoutes(app: FastifyInstance, ctx: Ctx, reg: RegisteredRoute[]) {
  defineRoute<Record<string, never>, { group_by: 'route' | 'transporter' }>(app, ctx, reg, {
    method: 'GET',
    url: '/dashboard/on-time',
    roles: ['COORDINATOR'],
    summary: 'On-time counts and percentage by route or transporter, against the original promise',
    query: Query,
    responses: { 200: OnTimeResponse },
    handler: ({ query }) => ({ status: 200, body: onTime(ctx, query.group_by) }),
  });

  defineRoute<Record<string, never>, { group_by: 'route' | 'transporter' }>(app, ctx, reg, {
    method: 'GET',
    url: '/dashboard/delay-causes',
    roles: ['COORDINATOR'],
    summary: 'Delay minutes by cause, grouped by route or transporter',
    query: Query,
    responses: { 200: DelayCausesResponse },
    handler: ({ query }) => ({ status: 200, body: delayCauses(ctx, query.group_by) }),
  });

  defineRoute(app, ctx, reg, {
    method: 'GET',
    url: '/metrics/impact',
    roles: ['COORDINATOR'],
    summary: 'Impact indicators from DESIGN.md 10.3, with their kind and assumptions',
    responses: { 200: ImpactResponse },
    handler: () => ({ status: 200, body: impact(ctx) }),
  });
}
