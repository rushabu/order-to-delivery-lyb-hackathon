import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx';
import { defineRoute, type RegisteredRoute } from '../http/route';
import { ErrorResponse, EvPreview, EvPreviewInput, LiveRouteGenerate, LiveRouteStart, LiveRouteState, LiveRouteTrip, LiveShipmentDraft } from '../http/schemas';
import type { LiveRouteDemo } from './demo';
import type { DemoArea } from './scenarios';

export function registerLiveRouteDemo(app: FastifyInstance, ctx: Ctx, reg: RegisteredRoute[], demo: LiveRouteDemo) {
  defineRoute(app, ctx, reg, {
    method: 'GET', url: '/demo/live-route', roles: ['COORDINATOR'],
    summary: 'Live truck route demonstration state', responses: { 200: LiveRouteState },
    handler: () => ({ status: 200, body: demo.state() }),
  });
  defineRoute<Record<string, never>, { seed?: number; area?: DemoArea }>(app, ctx, reg, {
    method: 'GET', url: '/demo/live-route/generate', roles: ['COORDINATOR'],
    summary: 'Preview a generated fictional shipment without calling the routing provider', query: LiveRouteGenerate,
    responses: { 200: LiveShipmentDraft, 422: ErrorResponse, 503: ErrorResponse },
    handler: ({ query }) => ({ status: 200, body: demo.generate(query.seed, query.area) }),
  });
  defineRoute<Record<string, never>, Record<string, never>, LiveRouteStart>(app, ctx, reg, {
    method: 'POST', url: '/demo/live-route/start', roles: ['COORDINATOR'],
    summary: 'Calculate a truck route and start the fictional shipment',
    body: LiveRouteStart,
    responses: { 200: LiveRouteTrip, 409: ErrorResponse, 422: ErrorResponse, 502: ErrorResponse, 503: ErrorResponse },
    handler: async ({ body }) => ({ status: 200, body: await demo.start(body) }),
  });
  defineRoute<Record<string, never>, Record<string, never>, EvPreviewInput>(app, ctx, reg, {
    method: 'POST', url: '/demo/live-route/ev-preview', roles: ['COORDINATOR'],
    summary: 'Estimate charge at arrival and charging stops for a Mumbai demo shipment',
    body: EvPreviewInput,
    responses: { 200: EvPreview, 422: ErrorResponse, 502: ErrorResponse, 503: ErrorResponse },
    handler: async ({ body }) => ({ status: 200, body: await demo.previewEv(body) }),
  });
  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'POST', url: '/demo/live-route/:id/refresh', roles: ['COORDINATOR'],
    summary: 'Refresh traffic and ETA for the assigned live truck route',
    params: z.object({ id: z.string().min(1).max(40) }),
    responses: { 200: LiveRouteTrip, 409: ErrorResponse, 502: ErrorResponse },
    handler: async ({ params }) => ({ status: 200, body: await demo.refresh(params.id) }),
  });
}
