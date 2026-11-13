// Check 7: each alternative shares its base route's geometry exactly up to the exit km, then diverges.
import { describe, expect, it } from 'vitest';
import { haversineKm, pointAtKm } from '../scripts/seed-lib';
import { alternatives, routes } from './helpers';

describe('geometry', () => {
  it.each([['RTE-01', 'RTE-01B', 66], ['RTE-02', 'RTE-02B', 46]] as const)('%s and %s share km 0 to %i, then diverge', (baseId, altId, exitKm) => {
    const base = routes.get(baseId).geometry;
    const alt = routes.get(altId).geometry;
    expect(alternatives).toContainEqual({ route_id: baseId, alt_route_id: altId, exit_km: exitKm });
    const n = base.chainage_km.indexOf(exitKm) + 1;
    expect(n).toBeGreaterThan(1);
    expect(alt.chainage_km.indexOf(exitKm) + 1).toBe(n);
    expect(alt.coordinates.slice(0, n)).toEqual(base.coordinates.slice(0, n));
    expect(alt.chainage_km.slice(0, n)).toEqual(base.chainage_km.slice(0, n));
    expect(alt.coordinates[n]).not.toEqual(base.coordinates[n]);
    // Visibly different roads 15 km after the exit.
    expect(haversineKm(pointAtKm(routes.get(baseId), exitKm + 15), pointAtKm(routes.get(altId), exitKm + 15))).toBeGreaterThan(2);
  });

  it.each(['RTE-01', 'RTE-01B', 'RTE-02', 'RTE-02B'])('%s has 20 to 60 points', (id) => {
    const n = routes.get(id).geometry.coordinates.length;
    expect(n >= 20 && n <= 60).toBe(true);
  });
});
