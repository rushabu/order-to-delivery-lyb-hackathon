// GET /weather/routes: live forecast along every route (Open-Meteo). Coordinators only.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../ctx';
import { defineRoute, type RegisteredRoute } from '../http/route';
import { RouteWeatherResponse } from '../http/schemas';

export function registerWeatherRoutes(app: FastifyInstance, ctx: Ctx, reg: RegisteredRoute[]) {
  defineRoute(app, ctx, reg, {
    method: 'GET',
    url: '/weather/routes',
    roles: ['COORDINATOR'],
    summary: 'Live weather along each route from Open-Meteo, graded by the seed thresholds',
    responses: { 200: RouteWeatherResponse },
    handler: async () => {
      const w = await ctx.weather.refresh();
      return {
        status: 200,
        body: {
          // In demo mode the forecast is shown only; in live mode it also adds an ETA factor.
          mode: ctx.config.demoMode ? ('ADVISORY' as const) : ('LIVE' as const),
          source: 'Open-Meteo (open-meteo.com), hourly forecast',
          thresholds: ctx.weather.cfg,
          ...w,
        },
      };
    },
  });
}
