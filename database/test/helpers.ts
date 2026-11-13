import { ist, loadAll } from '../scripts/seed-lib';

export const data = loadAll();
export const cfg = data['config.json'];
export const sc = data['scenario-main.json'];
export const routes = new Map<string, any>(data['routes.json'].routes.map((r: any) => [r.id, r]));
export const alternatives = data['routes.json'].alternatives;
export const live = new Map<string, any>(sc.shipments.map((s: any) => [s.id, s]));
export const orders = new Map<string, any>(sc.orders.map((o: any) => [o.id, o]));
export const history: any[] = data['history.json'].shipments;
export const DAY = '2026-11-16';
export const at = (hhmm: string) => ist(DAY, hhmm);
export const promiseOf = (shipmentId: string) => orders.get(live.get(shipmentId).order_id).original_promised_by as string;
