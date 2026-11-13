// New orders and the truck they travel on (load consolidation at dispatch).
//   GET  /orders/new    what the form needs: customers, products, the current time
//   POST /orders/plan   every candidate truck for an order, with reasons; changes nothing
//   POST /orders        the approved choice; rechecked before it is applied
// Coordinators order for any customer and may share a planned truck. A customer orders only for their own
// company and picks one of the idle drivers (separate-truck options only).
import type { FastifyInstance } from 'fastify';
import type { AuthUser } from '../auth/policy';
import type { Ctx } from '../ctx';
import { forbidden } from '../http/errors';
import { defineRoute, type RegisteredRoute } from '../http/route';
import { ErrorResponse, NewOrderForm, OrderCreate, OrderCreated, OrderDraft, OrderPlan } from '../http/schemas';
import { createOrder, planOrder, validateOrder } from './plan';

/** A customer may only order for their own company. */
function ownOrder(user: AuthUser, customerId: string) {
  if (user.role === 'CUSTOMER' && user.customer_id !== customerId) throw forbidden('You can only order for your own company');
}

export function registerOrderRoutes(app: FastifyInstance, ctx: Ctx, reg: RegisteredRoute[]) {
  const { db } = ctx;

  defineRoute(app, ctx, reg, {
    method: 'GET',
    url: '/orders/new',
    roles: ['COORDINATOR', 'CUSTOMER'],
    summary: 'Customers and products for the new-order form (a customer sees only their own company)',
    responses: { 200: NewOrderForm },
    handler: ({ user }) => {
      const alternatives = new Set(ctx.fixtures.alternatives.map((a) => a.alt_route_id));
      const all = db.prepare('SELECT id, name FROM customers ORDER BY id').all() as { id: string; name: string }[];
      const customers = all.flatMap((c) => {
        if (user!.role === 'CUSTOMER' && c.id !== user!.customer_id) return [];
        const primary = ctx.fixtures.routes.find((r) => r.destination_customer_id === c.id && !alternatives.has(r.id));
        return primary ? [{ ...c, deliver_to: primary.destination }] : [];
      });
      const products = [...new Set([...ctx.fixtures.scenario.orders, ...ctx.fixtures.history].map((o) => o.product))].sort();
      const visibleCustomers = new Set(customers.map((c) => c.id));
      const routes = ctx.fixtures.routes.flatMap((r) => r.destination_customer_id && visibleCustomers.has(r.destination_customer_id) && !r.restrictions.closed
        ? [{ id: r.id, name: r.name, customer_id: r.destination_customer_id, max_gross_t: r.restrictions.max_gross_t ?? null }]
        : []);
      return { status: 200, body: { now: ctx.clock.nowIso(), customers, products, routes } };
    },
  });

  defineRoute<Record<string, never>, Record<string, never>, OrderDraft>(app, ctx, reg, {
    method: 'POST',
    url: '/orders/plan',
    roles: ['COORDINATOR', 'CUSTOMER'],
    summary: 'Candidate trucks for a new order: share a planned truck to the same customer (coordinator), or an idle driver with a free truck',
    body: OrderDraft,
    responses: { 200: OrderPlan, 403: ErrorResponse, 422: ErrorResponse },
    handler: ({ user, body }) => {
      ownOrder(user!, body.customer_id);
      const now = ctx.clock.nowIso();
      validateOrder(ctx, body, now);
      const { options, recommended_option_id } = planOrder(ctx, body, now, user!.role === 'CUSTOMER' ? 'CUSTOMER' : 'COORDINATOR');
      return { status: 200, body: { options, recommended_option_id } };
    },
  });

  defineRoute<Record<string, never>, Record<string, never>, OrderCreate>(app, ctx, reg, {
    method: 'POST',
    url: '/orders',
    roles: ['COORDINATOR', 'CUSTOMER'],
    summary: 'Create the order on the truck chosen',
    body: OrderCreate,
    responses: { 201: OrderCreated, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
    handler: ({ user, body }) => {
      const { option_id, ...order } = body;
      ownOrder(user!, order.customer_id);
      return { status: 201, body: createOrder(ctx, user!, order, option_id) };
    },
  });
}
