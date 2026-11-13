// Error format from DESIGN.md section 5.1:
// {"error": {"code": "INVALID_TRANSITION", "message": "...", "details": {}}}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const notFound = (what = 'Not found') => new ApiError(404, 'NOT_FOUND', what);
export const forbidden = (what = 'This role may not perform this action') => new ApiError(403, 'FORBIDDEN', what);
export const unauthorized = (what = 'Sign in required') => new ApiError(401, 'UNAUTHORIZED', what);
export const validationFailed = (message: string, details: Record<string, unknown> = {}) =>
  new ApiError(422, 'VALIDATION_FAILED', message, details);

export function errorBody(code: string, message: string, details: Record<string, unknown> = {}) {
  return { error: { code, message, details } };
}
