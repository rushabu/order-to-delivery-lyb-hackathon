// GET /alerts/:id/options, POST /shipments/:id/decisions, GET /decisions, GET /decisions/:id. Coordinators only.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AlertRow } from '../alerts/alerts';
import type { Ctx } from '../ctx';
import { notFound } from '../http/errors';
import { defineRoute, type RegisteredRoute } from '../http/route';
import { DecisionRequest, DecisionResponse, ErrorResponse, LedgerEntry, OptionSet } from '../http/schemas';
import { currentOptionSet, optionSetToApi } from '../options/service';
import { decide, type DecisionInput } from './decide';

const IdParams = z.object({ id: z.string().min(1).max(40) });

function ledgerEntry(ctx: Ctx, row: Record<string, string | null>) {
  const set = ctx.db.prepare('SELECT * FROM option_sets WHERE id = ?').get(row.option_set_id) as Parameters<typeof optionSetToApi>[0];
  return {
    ...JSON.parse(row.result!),
    option_set_id: row.option_set_id,
    option_id: row.option_id,
    note: row.note,
    options: JSON.parse(set.options),
    option_set: optionSetToApi(set),
    outcome: row.outcome ? JSON.parse(row.outcome) : null,
  };
}

export function registerDecisionRoutes(app: FastifyInstance, ctx: Ctx, reg: RegisteredRoute[]) {
  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'GET',
    url: '/alerts/:id/options',
    roles: ['COORDINATOR'],
    summary: 'Current option set for the alert; generates one if none is valid',
    params: IdParams,
    responses: { 200: OptionSet, 404: ErrorResponse },
    handler: ({ user, params }) => {
      const alert = ctx.db.prepare('SELECT * FROM alerts WHERE id = ?').get(params.id) as AlertRow | undefined;
      if (!alert) throw notFound('Alert not found');
      return { status: 200, body: optionSetToApi(currentOptionSet(ctx, alert, user!.id)) };
    },
  });

  defineRoute<{ id: string }, Record<string, never>, DecisionInput>(app, ctx, reg, {
    method: 'POST',
    url: '/shipments/:id/decisions',
    roles: ['COORDINATOR'],
    summary: 'Approve one option. Idempotent on decision_id',
    params: IdParams,
    body: DecisionRequest,
    responses: { 200: DecisionResponse, 201: DecisionResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
    handler: ({ user, params, body }) => decide(ctx, user!, params.id, body),
  });

  defineRoute<Record<string, never>, { shipment_id?: string }>(app, ctx, reg, {
    method: 'GET',
    url: '/decisions',
    roles: ['COORDINATOR'],
    summary: 'Decision ledger, newest first',
    query: z.object({ shipment_id: z.string().max(40).optional() }),
    responses: { 200: z.array(LedgerEntry) },
    handler: ({ query }) => {
      const rows = ctx.db
        .prepare('SELECT * FROM decisions WHERE (? IS NULL OR shipment_id = ?) ORDER BY id DESC')
        .all(query.shipment_id ?? null, query.shipment_id ?? null) as Record<string, string | null>[];
      return { status: 200, body: rows.map((r) => ledgerEntry(ctx, r)) };
    },
  });

  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'GET',
    url: '/decisions/:id',
    roles: ['COORDINATOR'],
    summary: 'One ledger entry: options considered, choice, prediction and outcome',
    params: IdParams,
    responses: { 200: LedgerEntry, 404: ErrorResponse },
    handler: ({ params }) => {
      const row = ctx.db.prepare('SELECT * FROM decisions WHERE id = ?').get(params.id) as Record<string, string | null> | undefined;
      if (!row) throw notFound('Decision not found');
      return { status: 200, body: ledgerEntry(ctx, row) };
    },
  });
}
