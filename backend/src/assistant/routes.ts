// POST /assistant/ask: one question to the order-tracking assistant (Groq). All roles.
// GET /assistant: whether the assistant is switched on, so the web app can say so before a question is typed.
import type { FastifyInstance } from 'fastify';
import { audit } from '../audit';
import { LoginRateLimiter } from '../auth/routes';
import type { Ctx } from '../ctx';
import { ApiError } from '../http/errors';
import { defineRoute, type RegisteredRoute } from '../http/route';
import { AssistantAnswer, AssistantAsk, AssistantStatus, ErrorResponse } from '../http/schemas';
import { askGroq, buildContext, DEFAULT_GROQ_MODEL, systemPrompt } from './assistant';

const ALL = ['COORDINATOR', 'DRIVER', 'CUSTOMER'] as const;

export function registerAssistantRoutes(app: FastifyInstance, ctx: Ctx, reg: RegisteredRoute[]) {
  const limiter = new LoginRateLimiter(); // 10 questions per user per minute keeps the free Groq quota safe
  const model = ctx.config.groqModel ?? DEFAULT_GROQ_MODEL;

  defineRoute(app, ctx, reg, {
    method: 'GET',
    url: '/assistant',
    roles: [...ALL],
    summary: 'Whether the order-tracking assistant is configured',
    responses: { 200: AssistantStatus },
    handler: () => ({ status: 200, body: { configured: Boolean(ctx.config.groqApiKey), provider: 'Groq' as const, model } }),
  });

  defineRoute<Record<string, never>, Record<string, never>, AssistantAsk>(app, ctx, reg, {
    method: 'POST',
    url: '/assistant/ask',
    roles: [...ALL],
    summary: 'Ask the assistant about the shipments the signed-in user may see',
    body: AssistantAsk,
    responses: { 200: AssistantAnswer, 422: ErrorResponse, 429: ErrorResponse, 502: ErrorResponse, 503: ErrorResponse },
    handler: async ({ user, body }) => {
      const key = ctx.config.groqApiKey;
      if (!key) throw new ApiError(503, 'ASSISTANT_UNCONFIGURED', 'Set GROQ_API_KEY on the API server to use the assistant');
      if (!limiter.allow(user!.id, Date.now())) throw new ApiError(429, 'RATE_LIMITED', 'Too many questions. Try again in a minute.');
      const answer = await askGroq(key, model, systemPrompt(user!, buildContext(ctx, user!)), body.history, body.question);
      audit(ctx.db, ctx.clock.nowIso(), user!.id, 'ASSISTANT_ASKED', 'assistant', null, { question_chars: body.question.length, model });
      return { status: 200, body: { answer, provider: 'Groq' as const, model } };
    },
  });
}
