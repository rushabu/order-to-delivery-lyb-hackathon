// Clock service. REAL mode reads the wall clock. SIMULATED mode (demo) holds a simulated time that
// only the simulator moves forward, so every replay sees exactly the same instants.
import { toIso } from '../time';

export interface Clock {
  readonly mode: 'REAL' | 'SIMULATED';
  nowMs(): number;
  nowIso(): string;
}

export class RealClock implements Clock {
  readonly mode = 'REAL' as const;
  nowMs() {
    return Date.now();
  }
  nowIso() {
    return toIso(Date.now());
  }
}

export class SimulatedClock implements Clock {
  readonly mode = 'SIMULATED' as const;
  speed = 60; // simulated seconds per real second
  paused = true;
  private ms: number;

  constructor(startIso: string) {
    this.ms = Date.parse(startIso);
  }
  nowMs() {
    return this.ms;
  }
  nowIso() {
    return toIso(this.ms);
  }
  /** Only the simulator (and tests) call this. Time never moves backwards except on reset. */
  set(ms: number) {
    this.ms = ms;
  }
}
