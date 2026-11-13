import { useSyncExternalStore } from "react";
import type { Role, User } from "../api/contract";

/*
  The bearer token lives in sessionStorage, which is separate for every browser tab.
  That is what lets one laptop show the coordinator, driver and customer in three tabs (DESIGN.md 7.1).
  Trade-off stated in DESIGN.md 9.1: injected script could read it; production would use SSO cookies.
*/
const KEY = "ct.session";

export interface Session {
  token: string;
  user: User;
}

const listeners = new Set<() => void>();
let cached: Session | null | undefined;

function read(): Session | null {
  if (cached !== undefined) return cached;
  try {
    const raw = sessionStorage.getItem(KEY);
    cached = raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    cached = null;
  }
  return cached;
}

export function getSession(): Session | null {
  return read();
}

export function setSession(session: Session | null) {
  cached = session;
  if (session) sessionStorage.setItem(KEY, JSON.stringify(session));
  else sessionStorage.removeItem(KEY);
  listeners.forEach((l) => l());
}

export function useSession(): Session | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => null,
  );
}

export function homeFor(role: Role): string {
  if (role === "COORDINATOR") return "/coordinator";
  if (role === "DRIVER") return "/driver";
  return "/customer";
}
