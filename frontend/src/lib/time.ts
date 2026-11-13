/* All times arrive from the API in UTC and are shown in India Standard Time with the zone (DESIGN.md 5.1, 7.6). */
const hm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
const dayHm = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

/** "11:39" (no zone), for use where the zone is printed once nearby, e.g. table columns headed "IST". */
export function clock(iso: string | null | undefined): string {
  return iso ? hm.format(new Date(iso)) : "—";
}

/** "11:39 IST" */
export function clockTz(iso: string | null | undefined): string {
  return iso ? `${clock(iso)} IST` : "—";
}

/** "16 Nov, 11:39 IST" */
export function dateTimeTz(iso: string | null | undefined): string {
  return iso ? `${dayHm.format(new Date(iso))} IST` : "—";
}

/** "1 h 10 min", "40 min" */
export function duration(min: number): string {
  const m = Math.abs(Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

export function inr(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}
