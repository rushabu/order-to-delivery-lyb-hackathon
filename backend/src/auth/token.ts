// Login token: a standard HS256 JSON Web Token built with Node's crypto, 8-hour expiry (DESIGN.md 9.1).
// Only the HS256 algorithm is accepted; the header is fixed, so "alg: none" tricks cannot apply.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TokenClaims {
  sub: string; // user id
  role: string;
  iat: number; // seconds
  exp: number; // seconds
}

const HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
export const TOKEN_TTL_SECONDS = 8 * 60 * 60;

function b64url(s: string | Buffer): string {
  return Buffer.from(s).toString('base64url');
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function issueToken(userId: string, role: string, secret: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const payload = b64url(JSON.stringify({ sub: userId, role, iat, exp: iat + TOKEN_TTL_SECONDS }));
  const data = `${HEADER}.${payload}`;
  return `${data}.${sign(data, secret)}`;
}

export function verifyToken(token: string, secret: string, nowMs: number): TokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) return null;
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`, secret));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as TokenClaims;
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
    if (claims.exp * 1000 <= nowMs) return null;
    return claims;
  } catch {
    return null;
  }
}
