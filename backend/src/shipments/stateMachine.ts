// Shipment state machine (DESIGN.md 5.3). Any transition not listed is rejected with 409 INVALID_TRANSITION.
import type { ShipmentStatusName } from '../eta/types';

export const TRANSITIONS: Record<ShipmentStatusName, ShipmentStatusName[]> = {
  PLANNED: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: ['IN_TRANSIT', 'CANCELLED'],
  IN_TRANSIT: ['ARRIVED'],
  ARRIVED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

export function canTransition(from: ShipmentStatusName, to: ShipmentStatusName): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Which role may post a milestone to each status (DESIGN.md 5.4). */
export function milestoneRole(to: ShipmentStatusName): 'COORDINATOR' | 'DRIVER' | null {
  if (to === 'DISPATCHED' || to === 'CANCELLED') return 'COORDINATOR';
  if (to === 'IN_TRANSIT' || to === 'ARRIVED' || to === 'DELIVERED') return 'DRIVER';
  return null; // PLANNED is never posted
}
