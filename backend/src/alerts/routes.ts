// GET /alerts: the coordinator's attention queue, highest current risk first.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx';
import { defineRoute, type RegisteredRoute } from '../http/route';
import { Alert, AlertStatus, RiskLevel } from '../http/schemas';
import { alertToApi, type AlertRow } from './alerts';

export const AlertListItem = Alert.extend({
  current_risk_score: z.number().int().nullable(),
  current_risk_level: RiskLevel.nullable(),
  current_headline: z.string().nullable(),
});

export function registerAlertRoutes(app: FastifyInstance, ctx: Ctx, reg: RegisteredRoute[]) {
  defineRoute<Record<string, never>, { status?: string }>(app, ctx, reg, {
    method: 'GET',
    url: '/alerts',
    roles: ['COORDINATOR'],
    summary: 'Alerts (filter by status), sorted by the shipment’s current risk score',
    query: z.object({ status: AlertStatus.optional() }),
    responses: { 200: z.array(AlertListItem) },
    handler: ({ query }) => {
      const rows = ctx.db
        .prepare(
          `SELECT a.*, e.risk_score AS current_risk_score, e.risk_level AS current_risk_level, e.headline AS current_headline
           FROM alerts a JOIN shipments s ON s.id = a.shipment_id
           LEFT JOIN eta_snapshots e ON e.id = s.current_eta_snapshot_id
           WHERE (? IS NULL OR a.status = ?)
           ORDER BY COALESCE(e.risk_score, -1) DESC, a.id`,
        )
        .all(query.status ?? null, query.status ?? null) as (AlertRow & {
        current_risk_score: number | null;
        current_risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | null;
        current_headline: string | null;
      })[];
      return {
        status: 200,
        body: rows.map((r) => ({
          ...alertToApi(r),
          current_risk_score: r.current_risk_score,
          current_risk_level: r.current_risk_level,
          current_headline: r.current_headline,
        })),
      };
    },
  });
}
