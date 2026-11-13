// Demo endpoints (DESIGN.md 5.5, 10.4). Registered only when DEMO_MODE=true; coordinators only.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx';
import { notFound } from '../http/errors';
import { defineRoute, type RegisteredRoute } from '../http/route';
import { DemoClockRequest, DemoState, ErrorResponse } from '../http/schemas';
import type { SimulatedClock } from './clock';
import type { Simulator } from './simulator';

/**
 * Demo state as the web app reads it. A replay stopped on one of the scenario's pause beats reports
 * WAITING_FOR_PRESENTER with that beat's label.
 */
export function demoState(sim: Simulator, clock: SimulatedClock, pauseLabels: Record<string, string> = {}) {
  const now = clock.nowIso();
  const atBeat = sim.status === 'PAUSED' && now in pauseLabels;
  return {
    clock: now,
    speed: clock.speed,
    paused: clock.paused,
    mode: clock.mode,
    scenario_id: sim.scenarioId,
    scenario_status: atBeat ? ('WAITING_FOR_PRESENTER' as const) : sim.status,
    waiting_for: atBeat ? pauseLabels[now] : null,
    next_pause_at: sim.nextPauseAt,
  };
}

export function registerDemoRoutes(app: FastifyInstance, ctx: Ctx, reg: RegisteredRoute[], sim?: Simulator, clock?: SimulatedClock) {
  defineRoute(app, ctx, reg, {
    method: 'GET',
    url: '/demo/state',
    roles: ['COORDINATOR'],
    summary: 'Clock time, speed and scenario status',
    responses: { 200: DemoState },
    handler: () => ({ status: 200, body: sim && clock ? demoState(sim, clock, ctx.fixtures.scenario.pause_labels ?? {}) : {
      clock: ctx.clock.nowIso(), speed: 1, paused: false, mode: 'REAL' as const, scenario_id: null,
      scenario_status: 'IDLE' as const, waiting_for: null, next_pause_at: null,
    } }),
  });
  if (!sim || !clock) return;
  const state = () => demoState(sim, clock, ctx.fixtures.scenario.pause_labels ?? {});
  const publishDemo = (kind: string) =>
    ctx.hub.publish([{ hint: { entity: 'demo', id: 'main', kinds: [kind] }, audience: { kind: 'all' } }]);

  defineRoute(app, ctx, reg, {
    method: 'POST',
    url: '/demo/reset',
    roles: ['COORDINATOR'],
    summary: 'Stop the replay, restore the seed, set the clock to 08:50 IST paused',
    responses: { 200: DemoState },
    handler: ({ user }) => {
      sim.reset(user!.id);
      return { status: 200, body: state() };
    },
  });

  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'POST',
    url: '/demo/scenarios/:id/start',
    roles: ['COORDINATOR'],
    summary: 'Start (or resume) the replay at the configured speed',
    params: z.object({ id: z.string().min(1).max(40) }),
    responses: { 200: DemoState, 404: ErrorResponse },
    handler: ({ params }) => {
      if (params.id !== ctx.fixtures.scenario.scenario_id) throw notFound('Scenario not found');
      sim.start(params.id);
      publishDemo('started');
      return { status: 200, body: state() };
    },
  });

  defineRoute<Record<string, never>, Record<string, never>, { speed?: number; paused?: boolean }>(app, ctx, reg, {
    method: 'POST',
    url: '/demo/clock',
    roles: ['COORDINATOR'],
    summary: 'Set replay speed (simulated seconds per real second) and pause or resume',
    body: DemoClockRequest,
    responses: { 200: DemoState },
    handler: ({ body }) => {
      sim.setClock(body);
      publishDemo('clock');
      return { status: 200, body: state() };
    },
  });

}
