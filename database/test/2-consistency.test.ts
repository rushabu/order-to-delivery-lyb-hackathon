// Check 2: consistency rules. Each passes on the committed seed; mutated copies prove the rules can fail.
import { describe, expect, it } from 'vitest';
import { RULES } from '../scripts/validate-seed';
import { data } from './helpers';

const mutated = (change: (d: typeof data) => void) => {
  const copy = structuredClone(data);
  change(copy);
  return copy;
};

describe('consistency rules', () => {
  it.each(Object.keys(RULES))('%s passes on the committed seed', (rule) => {
    expect(RULES[rule](data)).toEqual([]);
  });

  it('catches an unknown driver', () => {
    expect(RULES.references(mutated((d) => { d['history.json'].shipments[0].driver_user_id = 'USR-DRV-99'; }))).not.toEqual([]);
  });

  it('catches a gap between segments', () => {
    expect(RULES.route_geometry(mutated((d) => { d['routes.json'].routes[0].segments[1].start_km = 41; }))).not.toEqual([]);
  });

  it('catches a double-booked driver', () => {
    expect(RULES.no_overlapping_trips(mutated((d) => {
      const [a, ...rest] = d['history.json'].shipments;
      rest.find((h: any) => h.driver_user_id === a.driver_user_id).planned_departure = a.planned_departure;
    }))).not.toEqual([]);
  });

  it('catches a wrong gross weight', () => {
    expect(RULES.weights(mutated((d) => { d['history.json'].shipments[0].gross_t += 3; }))).not.toEqual([]);
  });

  it('catches wrong lateness', () => {
    expect(RULES.history_arithmetic(mutated((d) => { d['history.json'].shipments[0].lateness_min += 1; }))).not.toEqual([]);
  });

  it('catches waypoints that no longer match their speed profiles', () => {
    expect(RULES.ground_truth(mutated((d) => { d['scenario-main.json'].ground_truth['SHP-1001'].branches['RTE-01'].at(-1).at = '2026-11-16T07:00:00Z'; }))).not.toEqual([]);
  });

  it('flags a company name nobody checked', () => {
    expect(RULES.no_real_identifiers(mutated((d) => { d['customers.json'].customers[0].name = 'Some New Name Ltd'; }))).not.toEqual([]);
  });
});
