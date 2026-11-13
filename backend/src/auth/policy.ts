// Role policy (DESIGN.md 5.4 and 9.1).
// scopeFor(user) is the single filter applied to every shipment query. It is built only from the
// signed-in user's own row; no customer, driver or user id is ever read from the request.

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'COORDINATOR' | 'DRIVER' | 'CUSTOMER';
  customer_id: string | null;
  transporter_id: string | null;
}

export interface Scope {
  /** SQL condition over `s` (shipments) and `o` (orders). */
  where: string;
  params: unknown[];
}

export function scopeFor(user: AuthUser): Scope {
  switch (user.role) {
    case 'COORDINATOR':
      return { where: '1 = 1', params: [] };
    case 'DRIVER':
      return { where: 's.driver_user_id = ?', params: [user.id] };
    case 'CUSTOMER':
      // A customer user without a customer id sees nothing.
      return { where: 'o.customer_id = ?', params: [user.customer_id ?? '__none__'] };
  }
}

/** Plain-object check used where a row is already loaded (for example stream hints). */
export function canSeeShipment(user: AuthUser, s: { driver_user_id: string | null; customer_id: string }): boolean {
  if (user.role === 'COORDINATOR') return true;
  if (user.role === 'DRIVER') return s.driver_user_id === user.id;
  return user.customer_id !== null && s.customer_id === user.customer_id;
}
