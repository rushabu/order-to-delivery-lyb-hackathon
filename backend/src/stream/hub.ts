// Stream hub (DESIGN.md 5.8). Keeps the list of open server-sent-event connections in memory and
// sends change hints, never data. A hint goes only to users allowed to see that entity.
import type { AuthUser } from '../auth/policy';
import { canSeeShipment } from '../auth/policy';

export interface Hint {
  entity: 'shipment' | 'notification' | 'dashboard' | 'demo';
  id: string;
  version?: number;
  kinds: string[];
}

export type Audience =
  | { kind: 'shipment'; customer_id: string; driver_user_id: string | null }
  | { kind: 'user'; user_id: string }
  | { kind: 'coordinators' }
  | { kind: 'all' };

export interface PendingHint {
  hint: Hint;
  audience: Audience;
}

export interface Subscriber {
  user: AuthUser;
  write: (chunk: string) => void;
}

export class StreamHub {
  private subs = new Set<Subscriber>();

  subscribe(s: Subscriber): () => void {
    this.subs.add(s);
    return () => this.subs.delete(s);
  }

  get size() {
    return this.subs.size;
  }

  /** Call after the database transaction has committed. */
  publish(items: PendingHint[]): void {
    for (const { hint, audience } of items) {
      const line = `event: change\ndata: ${JSON.stringify(hint)}\n\n`;
      for (const s of this.subs) {
        if (allowed(s.user, audience)) {
          try {
            s.write(line);
          } catch {
            this.subs.delete(s);
          }
        }
      }
    }
  }

  keepAlive(): void {
    for (const s of this.subs) {
      try {
        s.write(': keep-alive\n\n');
      } catch {
        this.subs.delete(s);
      }
    }
  }
}

function allowed(user: AuthUser, a: Audience): boolean {
  switch (a.kind) {
    case 'all':
      return true;
    case 'coordinators':
      return user.role === 'COORDINATOR';
    case 'user':
      return user.id === a.user_id;
    case 'shipment':
      return canSeeShipment(user, a);
  }
}
