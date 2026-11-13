# control-tower-api

Backend for the Order-to-Delivery Control Tower, Problem Statement 3 of the LYB Mumbai Hackathon 2026 (Round 2).

"Plant X" and the shipment records are fictional. The live routing demo uses TomTom and Open-Meteo for road conditions and weather.

## Documents

| Document | Purpose |
|---|---|
| [DESIGN.md](DESIGN.md) | Engineering design: requirements mapping, architecture, domain model, API and event contracts, ETA and risk calculation, security, verification and demo script |
| [PHASES.md](PHASES.md) | Execution plan for three owners: phases, exit criteria, critical path and cut list |
| [AI_USAGE.md](AI_USAGE.md) | Declaration of generative AI use, required by the hackathon rules |

These are the canonical copies. The web repository, [control-tower-web](https://github.com/LYBHackathon/control-tower-web), links here.

## Run locally

Requires Node 24 or later (developed on Node 26 LTS).

Use the [repository launcher](../README.md#run-the-full-app) to set up both services, including the bundled SQLite binding on Windows x64. To run the API separately after setup:

```bash
cp .env.example .env   # then set JWT_SECRET to a long random string
npm run dev            # http://localhost:4000, migrates and seeds on start
npm test               # Vitest: T1-T13 and the contract sample test
npm run typecheck
```

API base path: `/api/v1`. Contract: `GET /openapi.json` (generated from the Zod schemas in `src/http/schemas.ts`).

The API loads `../database/seed/` when its scenario file exists and otherwise uses `test/fixtures-stub/`. See the [repository run guide](../README.md#run-the-full-app) for the live-routing configuration and demo accounts.

## Code map

| Folder | What it does | DESIGN.md |
|---|---|---|
| `src/eta` | `computeEta(state, now)`: pure rules engine for ETA, risk, confidence and reasons | 6.3-6.5 |
| `src/options` | `evaluateOptions`: pure option evaluator; `service.ts` stores option sets | 6.7 |
| `src/events` | `ingestEvent`: the one entry point for every shipment change (HTTP and simulator) | 5.6 |
| `src/shipments` | State machine, geometry (lat/lng to km), reads, ETA recompute, stale tick | 5.3, 6.2 |
| `src/alerts`, `src/notify` | Alert open/escalate/resolve; in-app notifications | 6.4, 8 |
| `src/decisions` | Decision service, ledger outcome | 5.7.3, 6.8 |
| `src/sim` | Simulated clock, fixture loader, seed, replay simulator, demo endpoints | 10.4 |
| `src/liveRouting` | Live shipment presets, seeded generation, simulated truck positions and TomTom requests | [Live demo](../README.md#run-a-live-shipment) |
| `src/assistant` | Order-tracking assistant: per-user shipment summary sent to Groq (the only language-model call) | 2.3, [AI_USAGE.md](AI_USAGE.md) |
| `src/invoices` | Invoice PDF: generate from the shipment (`invoicePdf.ts`, no PDF library) or upload, both coordinator only; download for the coordinator and the shipment's customer | 2.3 |
| `src/orders` | New orders: candidate trucks with reasons (share a planned truck to the same customer, or a separate one) and the coordinator's approval. The rules are listed at the top of `plan.ts` | [Run guide](../README.md#add-an-order-and-choose-its-truck) |
| `src/auth` | scrypt passwords, HS256 tokens, `scopeFor(user)`, login rate limit | 9.1 |
| `src/stream` | Server-sent change hints | 5.8 |
| `src/dashboard` | On-time, delay causes, impact metrics | 10.3 |
| `src/http` | Zod schemas (the contract), route helper, OpenAPI, error format | 5 |

## Deployment

- Start command: `npm start` (runs `src/server.ts` with `tsx`; no build step).
- Environment variables: `PORT`, `JWT_SECRET` (required, at least 16 characters), `CORS_ORIGINS` (comma-separated web origins), `DATABASE_FILE`, `DEMO_MODE` (`true` for the demo), `TOMTOM_API_KEY` (live routing), and `GROQ_API_KEY` with optional `GROQ_MODEL` (order-tracking assistant).
- **Exactly one instance may run.** SQLite is a single file with one writer, and the stream hub and the simulator live in process memory. Do not scale horizontally or run two copies against the same file.
- In demo mode the database is reseeded on every start, so an ephemeral disk is fine.
- Nothing has been deployed yet; hosting is open item O2.

## Branching

`main` always runs. Work happens on `feat/<area>-<short-name>` branches and merges by pull request with one review.
