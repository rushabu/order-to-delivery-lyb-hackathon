// Phase 0 exit criterion: the sample payloads in DESIGN.md 5.7 validate against the Zod schemas.
import { describe, expect, it } from 'vitest';
import { DecisionRequest, DecisionResponse, EtaSnapshot, EventRequest, EventResponse, OptionSet } from '../src/http/schemas';
import { makeApp } from './helpers';

describe('DESIGN.md 5.7 sample payloads', () => {
  it('5.7.1 shipment update request and response', () => {
    expect(
      EventRequest.parse({
        event_id: '5f0c2c1e-8a4b-4f6d-9a57-2f3f1f0b7a11',
        type: 'DISRUPTION_REPORTED',
        payload: {
          disruption_id: '9b1d6c70-3c55-4f0e-8d0a-6f1f5a2c4e22',
          category: 'ACCIDENT',
          expected_delay_min: 60,
          at_km: 75,
          note: 'Accident ahead, one lane closed',
        },
      }).type,
    ).toBe('DISRUPTION_REPORTED');
    EventResponse.parse({
      event_id: '5f0c2c1e-8a4b-4f6d-9a57-2f3f1f0b7a11',
      apply_status: 'APPLIED',
      shipment_id: 'SHP-1001',
      shipment_version: 42,
      occurred_at: '2026-11-16T04:00:00Z',
      eta_snapshot_id: 'ETA-000318',
    });
    for (const e of [
      { type: 'POSITION', payload: { lat: 18.9, lng: 73.3, speed_kmph: 40 } },
      { type: 'MILESTONE', payload: { to_status: 'IN_TRANSIT' } },
      { type: 'DISRUPTION_CLEARED', payload: { disruption_id: '9b1d6c70-3c55-4f0e-8d0a-6f1f5a2c4e22' } },
    ]) {
      EventRequest.parse({ event_id: '5f0c2c1e-8a4b-4f6d-9a57-2f3f1f0b7a11', ...e });
    }
  });

  it('5.7.2 ETA snapshot', () => {
    EtaSnapshot.parse({
      id: 'ETA-000318',
      shipment_id: 'SHP-1001',
      computed_at: '2026-11-16T04:00:00Z',
      trigger_event_id: '5f0c2c1e-8a4b-4f6d-9a57-2f3f1f0b7a11',
      route_id: 'RTE-01',
      progress_km: 60,
      remaining_km: 90,
      eta: '2026-11-16T06:55:00Z',
      eta_window: { earliest: '2026-11-16T06:35:00Z', latest: '2026-11-16T07:15:00Z' },
      promised_by: '2026-11-16T06:15:00Z',
      slack_min: -40,
      margin_min: 20,
      risk_score: 100,
      risk_level: 'HIGH',
      confidence: 'HIGH',
      position_age_min: 0,
      factors: [
        { code: 'BASE_TRAVEL', label: 'Remaining drive at normal speed', minutes: 100 },
        { code: 'DWELL', label: 'Checkpoint stop at km 100', minutes: 15 },
        { code: 'ACCIDENT', label: 'Accident ahead at km 75 (driver estimate)', minutes: 60 },
      ],
      headline: 'Expected 40 min late: accident ahead at km 75 adds 60 min',
    });
  });

  it('5.7.3 options, decision request and response', () => {
    OptionSet.parse({
      id: 'OPS-0001',
      alert_id: 'ALT-0001',
      shipment_id: 'SHP-1001',
      generated_at: '2026-11-16T04:00:00Z',
      based_on_snapshot_id: 'ETA-000318',
      valid_until: '2026-11-16T04:10:00Z',
      recommended_option_id: 'OPT-REROUTE-RTE-01B',
      recommendation_reason: 'Reroute via Khalapur bypass (RTE-01B) improves arrival by 46 min.',
      options: [
        {
          id: 'OPT-REROUTE-RTE-01B', type: 'REROUTE', feasible: true, label: 'Reroute via Khalapur bypass (RTE-01B)',
          projected_eta: '2026-11-16T06:09:00Z', projected_late_min: 0, projected_risk_level: 'MEDIUM', improvement_min: 46,
          added_km: 16, added_cost_inr: 720, params: { alt_route_id: 'RTE-01B' },
        },
        {
          id: 'OPT-CONTINUE', type: 'CONTINUE', feasible: true, label: 'Continue on current route and monitor',
          projected_eta: '2026-11-16T06:55:00Z', projected_late_min: 40, projected_risk_level: 'HIGH', improvement_min: 0,
          added_km: 0, added_cost_inr: 0, params: {},
        },
        {
          id: 'OPT-RESCHEDULE', type: 'RESCHEDULE', feasible: true, label: 'Accept delay and agree a new delivery time with the customer',
          projected_eta: '2026-11-16T06:55:00Z', projected_late_min: 40, projected_risk_level: 'LOW', improvement_min: 0,
          added_km: 0, added_cost_inr: 0, params: { new_agreed_delivery_by: '2026-11-16T07:15:00Z' },
        },
        { id: 'OPT-SPLIT', type: 'SPLIT_SHIPMENT', feasible: false, infeasible_reason: 'Load is already in transit on one vehicle', label: 'Split shipment' },
      ],
    });
    DecisionRequest.parse({
      decision_id: 'c2a4e9d0-7b1f-4c3a-b6e2-0d9f8a7c6b55',
      option_set_id: 'OPS-0001',
      option_id: 'OPT-REROUTE-RTE-01B',
      note: 'Bypass clear per transporter desk',
    });
    DecisionResponse.parse({
      id: 'DEC-0001',
      decision_id: 'c2a4e9d0-7b1f-4c3a-b6e2-0d9f8a7c6b55',
      shipment_id: 'SHP-1001',
      option_type: 'REROUTE',
      decided_by: 'USR-COORD-01',
      decided_at: '2026-11-16T04:01:00Z',
      shipment_version: 43,
      eta_snapshot_id: 'ETA-000319',
      notifications_created: 2,
      predicted: { chosen_eta: '2026-11-16T06:09:00Z', no_action_eta: '2026-11-16T06:55:00Z' },
      outcome: null,
    });
  });

  it('serves /health, /openapi.json and the error format', async () => {
    const t = await makeApp();
    try {
      expect((await t.req('GET', '/health')).status).toBe(200);
      const api = await t.req('GET', '/openapi.json');
      expect(api.status).toBe(200);
      expect(api.body.paths['/api/v1/shipments/{id}/events'].post).toBeDefined();
      const r = await t.req('GET', '/shipments/SHP-1001');
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: { code: 'UNAUTHORIZED', message: expect.any(String), details: {} } });
    } finally {
      await t.close();
    }
  });
});
