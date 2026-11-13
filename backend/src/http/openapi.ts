// Builds /openapi.json from the registered routes' Zod schemas (zod's built-in JSON Schema export).
import { z } from 'zod';
import { API_PREFIX, type RegisteredRoute } from './route';

function schema(s: z.ZodType, io: 'input' | 'output') {
  return z.toJSONSchema(s, { io, unrepresentable: 'any' });
}

export function buildOpenApi(routes: RegisteredRoute[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const path = API_PREFIX + r.url.replace(/:([a-z_]+)/g, '{$1}');
    const parameters: unknown[] = [];
    for (const [where, s] of [['path', r.params], ['query', r.query]] as const) {
      if (!s) continue;
      const js = schema(s, 'input') as { properties?: Record<string, unknown>; required?: string[] };
      for (const [name, prop] of Object.entries(js.properties ?? {})) {
        parameters.push({ name, in: where, required: where === 'path' || (js.required ?? []).includes(name), schema: prop });
      }
    }
    const responses: Record<string, unknown> = {};
    for (const [code, s] of Object.entries(r.responses)) {
      responses[code] = { description: code, content: { 'application/json': { schema: schema(s, 'output') } } };
    }
    (paths[path] ??= {})[r.method.toLowerCase()] = {
      summary: r.summary,
      description: `Roles: ${r.roles === 'PUBLIC' ? 'public' : r.roles.join(', ')}`,
      'x-roles': r.roles,
      ...(r.roles === 'PUBLIC' ? {} : { security: [{ bearer: [] }] }),
      parameters,
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: schema(r.body, 'input') } } } } : {}),
      responses,
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Order-to-Delivery Control Tower API',
      version: '0.1.0',
      description: 'LYB Mumbai Hackathon 2026, PS3. All data is fictional. Contract text: DESIGN.md section 5.',
    },
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    paths,
  };
}
