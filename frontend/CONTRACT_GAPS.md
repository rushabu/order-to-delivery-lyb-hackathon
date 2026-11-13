# Contract gaps and open questions (web to API)

The web app consumes DESIGN.md section 5. Where a screen needs something the document does not define,
the web app uses a **PROPOSED** shape (marked in `src/api/contract.ts`) and the in-browser mock serves it.
Nothing below is worked around in the client: each item needs a decision from the API owner, after which
`npm run sync:api` replaces the hand-written types.

## 1. Stack and wire format

| # | Gap | Proposal |
|---|---|---|
| G1 | DESIGN.md 4.4 still says Fastify with Zod. The team lead says the API is **FastAPI**. | Update DESIGN.md 4.4. The web app needs only `/openapi.json` (FastAPI's default path, at the server root, not under `/api/v1`). `npm run sync:api` reads it from `VITE_API_URL`. |
| G2 | FastAPI's default validation error is `422 {"detail": [...]}`, not the 5.1 shape `{"error": {"code", "message", "details"}}`. | Add exception handlers so every error, including validation, uses the 5.1 shape. Otherwise the client can only show "Request failed (422)". |

## 2. Shapes the screens need that 5.7 does not give

| # | Endpoint | Missing | Why the screen needs it |
|---|---|---|---|
| G3 | `GET /shipments` | List item shape. Proposed `ShipmentSummary`: id, order_id, customer_name, destination_name, transporter_name, status, active_route_id, last_position, current_eta, open_alert, version | Attention queue rows and customer cards |
| G4 | `GET /shipments/:id` | Field names for "order, milestones, last position, open alert, active disruptions", plus customer_name, destination_name, transporter_name, driver_name (absent for customers, 5.4), planned_route_id | Detail screens, driver trip header, dashed previous route after a reroute |
| G5 | `GET /shipments/:id` milestones | Shape. Proposed: all five stages in order, `[{status, at}]`, `at: null` when not reached | Milestone timeline shows what is next |
| G6 | `GET /routes/:id` | `alternatives: [{alt_route_id, exit_km}]` (the 5.2 `route_alternatives` table) | Dashed alternative on the map; driver banner "Take exit at km 66" |
| G7 | `GET /decisions` | `option_set` (the full set the decision was made from), `option_id`, `note`, and a display name for `decided_by` | Ledger "options considered" and "approved by" |
| G8 | Dashboard and impact | Response shapes (agreement point 5). Proposed `OnTimeRow`, `DelayCauseRow`, `ImpactMetrics` in `contract.ts` | Dashboard |
| G9 | `GET /demo/state` | Field names for "clock time, speed, scenario status". Proposed `DemoState` | Demo controls |

## 3. Behaviour questions

| # | Question | What the web app does now |
|---|---|---|
| G10 | After an approved reroute, which route is `progress_km` measured on while the truck is still on RTE-01 before the exit? The mock reports km 60 with `active_route_id` RTE-01B, so the text reads "km 60 of 100 on RTE-01B". | Shows the API's values as given. Suggest: measure on the route the truck is physically on, and add `position_route_id`. |
| G11 | Stale position (6.5) holds the ETA, but 5.7.2 says `eta = computed_at + sum(factors)`. If a stale snapshot gets a new `computed_at`, the invariant breaks. | Mock keeps the held snapshot's `computed_at` and factors, adds the zero-minute "No position for N min" line, lowers confidence and widens the margin. Please confirm, and name the factor code (mock: `STALE_POSITION`) and the schedule-fallback code. |
| G12 | 6.7 recommends RESCHEDULE whenever no option improves arrival by 10 min. At step A (09:15) every option is on time, so RESCHEDULE is recommended while the shipment is not late, and the label "No available action brings this shipment back on time" is wrong at that moment. | Shows that sentence only when the recommended option has `projected_late_min > 0`. Suggest: when CONTINUE is already on time, recommend CONTINUE. Also consider an explicit `recommendation_reason` field on the option set instead of the client choosing a sentence. |
| G13 | How does the driver's browser know the API is in demo mode (to show "Position: simulated" and omit `occurred_at`)? Drivers may not call `/demo/*`. | Build flag `VITE_DEMO_MODE`. Suggest a `demo_mode` field on `GET /me` or `/health`. |
| G14 | 10.6 says "pause the simulator's positions for SHP-1001", but no endpoint does that. | The mock has `/demo/mock-controls` (pause positions, fail driver updates, drop the stream). Suggest `POST /demo/positions {shipment_id, paused}` for the live Q&A. |
| G15 | DESIGN.md 7.3 lists "Report a problem", a category, a delay and "Send" (four taps) but calls it three taps. | Three taps on the report screen (category, delay, Send), reached from one "Report a problem" button. |
| G16 | Option set ids: when a set expires and is regenerated, does it get a new id? | The client treats a changed `id` as "The situation changed. Options refreshed." |
| G17 | Should a stream hint be sent when an option set is regenerated? | The client refetches options on every `shipment` hint, which covers it. |
