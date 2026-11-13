# control-tower-web

Web app for the Order-to-Delivery Control Tower, Problem Statement 3 of the LYB Mumbai Hackathon 2026 (Round 2). It serves three roles: logistics coordinator, driver (phone layout) and customer.

All data in this project is fictional. "Plant X" is the fictional company from the hackathon brief.

## Documents

The canonical design and plan live in the API repository:

- [DESIGN.md](https://github.com/LYBHackathon/control-tower-api/blob/main/DESIGN.md): screens and states in section 7, the API contract in section 5.
- [PHASES.md](https://github.com/LYBHackathon/control-tower-api/blob/main/PHASES.md): web tasks are Owner B's.
- [AI_USAGE.md](https://github.com/LYBHackathon/control-tower-api/blob/main/AI_USAGE.md): generative AI declaration.

In this repository:

- [CONTRACT_GAPS.md](CONTRACT_GAPS.md): what the screens need that the contract does not yet define.
- [docs/design-tokens.md](docs/design-tokens.md): colours, contrast ratios, type, spacing, motion.
- [docs/screenshots/](docs/screenshots/): each role's main screen.

## Run it

Use Node 24.15 or later. The [repository launcher](../README.md#run-the-full-app) starts both services for the live demo. For the browser-only demo, run the following in `frontend`. If `.env` already exists, set `VITE_USE_MOCKS=true` and `VITE_DEMO_MODE=true` in that file.

```powershell
npm ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm run dev
```

Open http://localhost:5173. With `VITE_USE_MOCKS=true` (the default in `.env.example`) the app runs entirely in the browser against a mock API; the login page lists the fictional demo accounts.

| Script | What it does |
|---|---|
| `npm run dev` | Dev server on port 5173 |
| `npm test` | Vitest component tests |
| `npm run typecheck` | TypeScript check |
| `npm run build` | Static build into `dist/` |
| `npm run sync:api` | Generate `src/api/types.gen.ts` from the API's `/openapi.json`. Pass a URL or file path to use another source |

## Settings (`.env`)

| Variable | Meaning |
|---|---|
| `VITE_API_URL` | API base URL without `/api/v1`, e.g. `http://localhost:4000` |
| `VITE_USE_MOCKS` | `true` mocks every endpoint; a comma-separated list of path prefixes (e.g. `/dashboard,/metrics`) mocks only those; `false` uses the real API |
| `VITE_DEMO_MODE` | `true` shows Demo controls, "Position: simulated", and omits `occurred_at` on driver events |

The build contains no secrets, only the public API URL.

## Three-window demo on one laptop

The sign-in token is kept per tab (`sessionStorage`), so open three tabs or windows and sign in as the coordinator, the driver and a customer. With mocks on, the tabs share one replay through `localStorage` and a `BroadcastChannel`.

1. Coordinator: Demo controls, Start replay. The clock stops at 09:15 (risk turns At risk) and at 09:30.
2. Driver: Report a problem, Accident, 1 hour, Send. ETA becomes 12:25, Delayed; the customer is alerted.
3. Coordinator: Review options, approve the reroute (11:39, +16 km, ₹720). Driver sees the new route; customer sees 11:39.
4. Coordinator: SHP-1002, reroute barred by weight; approve the new delivery time.
5. Demo controls: 600×, Resume. Ledger shows predicted 11:39, actual 11:43, 12:40 without action, 57 min avoided. Dashboard shows the lead time.

Failure cases (mock only), on Demo controls: stop positions from SHP-1001 (stale marker, Low confidence), fail driver updates (Not sent, retrying), drop the live stream (Reconnecting).

## How the code is organised

| Folder | Contents |
|---|---|
| `src/api` | Contract types, fetch client, one query hook per endpoint, stream client, driver outbox |
| `src/mocks` | In-browser mock API and the scripted replay of DESIGN.md 6.6 (precomputed snapshots; nothing is calculated in the browser) |
| `src/components` | Base components and shared pieces: map, ETA panel, options table, approval dialog |
| `src/pages` | One folder per role, one file per route in DESIGN.md 7.1 |
| `src/lib` | Time formatting (IST), risk words, motion tokens, settings |

Rules the code follows: the app never calculates ETA, risk, feasibility or permissions; risk is always an icon plus a word; REST is the only source of data and the stream only says what to refetch.

## Deploying the static build

`VITE_API_URL=https://<api-host> VITE_USE_MOCKS=false VITE_DEMO_MODE=true npm run build`, then serve `dist/` from any static host. The host must send `index.html` for unknown paths (single-page app routes such as `/driver/report`). The API's `CORS_ORIGINS` must include the web origin. Not deployed yet; hosting is open item O2.

## Branching

`main` always runs. Work happens on `feat/web-<short-name>` branches and merges by pull request with one review.
