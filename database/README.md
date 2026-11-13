# Database

SQLite, one file, opened by the backend through `better-sqlite3` (DESIGN.md section 4.4). Tables follow DESIGN.md section 5.2.

Every seed file is **fictional data** made for the hackathon. Plant X is a fictional company. No real, personal or confidential data is used.

| Folder | Contents |
|---|---|
| [`migrations/`](migrations/) | Plain SQL migrations, applied in name order when the backend starts (`backend/src/db/db.ts`). `002_invoices.sql` adds the table that holds one invoice PDF per shipment; `003_shipment_orders.sql` records orders added to a truck that was already planned |
| [`seed/`](seed/) | The seed the backend loads (`backend/src/sim/fixtures.ts`): `config.json`, `users.json`, `customers.json`, `transporters.json`, `routes.json`, `history.json`, `scenario-main.json` |
| [`scripts/`](scripts/) | `generate-seed.ts` (writes `seed/`), `validate-seed.ts` (schema and consistency checks), `export-route-geometry.ts` (one-off map export, already run), `seed-lib.ts` (shared helpers) |
| [`schemas/`](schemas/) | One JSON Schema per seed file |
| [`sources/`](sources/) | `route_geometry.json`, the committed output of the one-off map export |
| [`test/`](test/) | Seven checks on the seed, plus a plain-arithmetic reference for DESIGN.md 6.3 to 6.7 |

The database file itself is created at run time and is git-ignored. `POST /api/v1/demo/reset` or `npm run seed` (in `backend/`) restores it from the seed. `backend/test/seed-demo.test.ts` replays the demo through the real engine on this seed.

## Commands (from `database/`)

```bash
npm install
npm run seed:generate   # rewrites seed/*.json; same bytes every run
npm run seed:validate   # schemas plus nine consistency rules
npm run samples:invoices  # rewrites samples/invoices/*.pdf from the seed
npm test                # the eight checks below
```

| Check | What it proves |
|---|---|
| 1 | Every file validates against its schema |
| 2 | References resolve; segments are contiguous and sum to `total_km`; exits lie inside both routes; no driver or vehicle is on two trips at once; gross = load + tare; promises fall inside receiving windows; history lateness = arrival − promise; no real identifiers |
| 3 | Two generator runs are byte-identical, and the committed files equal a fresh run |
| 4 | History totals per route and transporter, and the delay-cause counts |
| 5 | DESIGN.md 6.6: ETA 11:45 at 09:15, 12:25 at 09:30, reroute 11:39 for +16 km and ₹720, arrivals 12:40 (continue) and 11:43 (reroute) |
| 6 | SHP-1002: HIGH after the scripted report, reroute barred by the 20 t limit, split unavailable, RESCHEDULE recommended, 42 min late. SHP-1003: split recommended. Quiet shipments LOW |
| 7 | Each alternative shares its base route's points exactly up to the exit km, then diverges |
| 8 | The sample invoices in `samples/invoices/` equal a fresh run and are well-formed PDFs marked as fictional |

## How the seed was made

- **Hand-written** in `scripts/generate-seed.ts`: config, customers, transporters, users, routes and segments, the live scenario and its ground-truth speed profiles.
- **Generated** with a seeded SplitMix64 generator (seed 20261116): the 40-shipment history, passwords and UUIDs.
- **Users** are the same people and emails as the web app's demo accounts (`frontend/src/mocks/fixtures.ts`), on the reserved `.example` domain. Phones use `+91 00000 nnnnn`, which is not a valid Indian number. Passwords are demo values stored only in `users.json`; the backend hashes them with scrypt.
- **Company names** (Deccan Mouldings, Godavari Flexipack, Sahyadri Bulk Carriers, Konkan Roadlines) were searched on the web on 12 Nov 2026; no business with these exact names was found. The validator only accepts these checked names.
- **Vehicle registrations** use `MH 99`, above the highest Maharashtra RTO code in use (about MH-60 in Nov 2026).
- **Route geometry** comes from a single export from the public OSRM router (OpenStreetMap data) on 12 Nov 2026, simplified to at most 60 points per route. Only coordinates were sent. Nothing calls a routing service at run time.
- **Plant X** sits on a residential road in Panvel subdistrict, not at any real polymer or petrochemical plant.

## Live data

The seed is fictional and repeatable, but two things come from real, free sources:

| Source | Used for | When |
|---|---|---|
| [Open-Meteo](https://open-meteo.com) (no key, non-commercial use) | Weather along each route: rain, visibility and wind for the next 3 hours at points every 40 km | Live, by the backend (`backend/src/weather/`), cached for 15 minutes |
| OpenStreetMap routing (OSRM, or OpenRouteService with the truck profile) | The shape of each route | Once, when the seed is made (`scripts/export-route-geometry.ts`); committed in `sources/` |

**How weather is graded** (`config.json` → `weather`; the team's starting values):

| Level | Any of these at a point | Suggested delay |
|---|---|---|
| Severe | rain ≥ 4 mm/h, visibility < 1,000 m, wind ≥ 50 km/h | 30 min |
| Moderate | rain ≥ 1 mm/h, visibility < 5,000 m, wind ≥ 35 km/h | 10 min |
| Clear | none of the above | 0 |

A route takes the level of its worst point.

**Demo mode vs live mode.** In demo mode (`DEMO_MODE=true`, the default) the forecast is shown on the coordinator's Attention page as an *advisory* only, so the four-minute demo gives the same numbers every run. In live mode (`DEMO_MODE=false`) the backend refreshes the forecast every 15 minutes and, for every truck on the road, adds a "Forecast near km N" factor to its ETA when bad weather lies ahead. A driver's own weather report replaces the forecast factor so the same weather is never counted twice. If Open-Meteo cannot be reached, the panel says so and nothing else changes.

**Truck routes from OpenRouteService.** To re-export the routes with the heavy-goods-vehicle profile and a 34 t weight (the heaviest loaded truck in the seed), get a free key at openrouteservice.org, then from `database/`:

```bash
ORS_API_KEY=<your key> npx tsx scripts/export-route-geometry.ts --provider ors
npm run seed:generate && npm run seed:validate && npm test
```

The key is read from the environment only and is never written to a file. Without `--provider ors` the script uses the public OSRM router.

## Generated invoices

The coordinator's **Generate invoice** button builds a PDF from the shipment and these figures (`config.json` → `invoice`). **All of them are invented for the demo**; they are round numbers in a believable range, not quotes from any price list.

| Product name contains | Rate (INR per tonne) | HSN heading |
|---|---|---|
| copolymer | 1,12,000 | 3902 |
| polypropylene, or PP | 1,04,000 | 3902 |
| LLDPE | 1,10,000 | 3901 |
| HDPE | 1,08,000 | 3901 |
| LDPE | 1,16,000 | 3901 |
| anything else | 1,05,000 | 39 |

The first matching row wins, which is why "copolymer" and "LLDPE" come before the shorter names they contain. HSN 3901 (polymers of ethylene) and 3902 (polymers of propylene) are the real tariff headings for these materials.

Amount = quantity × rate. GST is 18%, shown as CGST 9% + SGST 9% because the fictional seller and both fictional buyers are in Maharashtra. Example, SHP-1001: 24 t × 1,04,000 = 24,96,000; plus 2,24,640 + 2,24,640; total 29,45,280.

The page says it is a fictional document and not a valid tax invoice, and it shows no GSTIN, bank or payment details, because inventing those would look like real identifiers.

**Samples.** `samples/invoices/INV-5001.pdf` to `INV-5005.pdf` are the invoices for the five demo shipments, for trying the **Upload PDF** button. `npm run samples:invoices` rewrites them with the backend's own builder (`backend/src/invoices/invoicePdf.ts`), and test 8 fails if they no longer match the seed.

## Routes and chainage

| Route | Road | `total_km` | Road length (OSRM) |
|---|---|---|---|
| RTE-01 | Panvel area to Deccan Mouldings, Ranjangaon MIDC, via Talegaon and Chakan | 150 | 146.1 |
| RTE-01B | Same, via Pune and the Pune-Shikrapur road; leaves RTE-01 at km 66 | 166 | 163.5 |
| RTE-02 | Panvel area to Godavari Flexipack, Satpur MIDC, via Bhiwandi, Kasara ghat and Igatpuri | 178 | 178.4 |
| RTE-02B | Same, via Wada and Trimbakeshwar; leaves RTE-02 at km 46; 20 t gross limit (fictional) | 209 | 209.8 |

Each route's GeoJSON carries `chainage_km`, the km of every point. Vertex 0 is km 0, the real junction where the alternative leaves is the `exit_km`, and the last point is `total_km`. In between, km is proportional to distance along the line. `backend/src/shipments/geometry.ts` uses these markers when present.

A uniform "fraction of the line × total_km" scale was not enough. On the real roads the RTE-01/RTE-01B junction (Wadgaon, Mawal) is 77 km into a 146 km line, which a uniform scale places at km 79. That is past the accident at km 75, so the reroute could not avoid it. Calibrated, the first 66 km are drawn over 74 km of road and the remaining 84 km over 68 km.

## Tuning for the demo

These choices make the replay reproduce DESIGN.md 6.6 to the minute. Each one is checked by a test.

| # | Choice | Why |
|---|---|---|
| 1 | Positions every 5 simulated minutes | SHP-1001 first turns MEDIUM on the 09:15 position. With 1-minute positions the pace rule would cross 35 at 09:13, and the lead time would no longer be 150 min |
| 2 | SHP-1001 drives from km 40 at 40 km/h against a 60 km/h baseline | Slowdown 1.5, giving the 25-minute congestion factor at 09:15 (ETA 11:45) |
| 3 | Accident at km 75 (Induri) from 09:20, cleared at 11:00 | Staying on RTE-01 the truck waits, then drives at baseline with the 15-min checkpoint dwell: arrives 12:40. That is 75 min worse than the plan from 09:30; the driver estimated 60 |
| 4 | RTE-01B baseline 50 km/h, but 30 km/h through Wagholi (km 126 to 131) in the ground truth | Rerouted arrival 11:43 against the projected 11:39: a visible 4-minute ETA error in the ledger |
| 5 | The reroute only holds if approved before 09:39 (km 66) | The 09:30 pause waits for the presenter |
| 5b | A driver's report without a location (the three-tap flow) is placed `report_ahead_km` = 15 km ahead for accidents, road closures and weather | Reported at km 60, the accident sits at km 75, after the km 66 exit, so the bypass can avoid it. Breakdowns, loading delays and other problems stay at the truck |
| 6 | SHP-1002: 24 t on VEH-K1 (tare 10 t) = 34 t gross; RTE-02B limited to 20 t | Reroute is infeasible for the weight reason |
| 7 | SHP-1002 departs 08:35 | The backend seeds the 15 minutes of positions before the 08:50 clock start; they must all fall after departure. The truck passes the km 46 exit at 09:44, so weight is the only reason the reroute fails |
| 8 | SHP-1002 driver report scripted at 09:20: WEATHER, 60 min, km 115 (foot of Kasara ghat) | HIGH with an open alert from 09:20 to 09:35. No option improves arrival by 10 min, so RESCHEDULE is recommended. Scripted because nobody drives SHP-1002 in the demo |
| 9 | SHP-1002 ground truth: traffic held at km 115 until 12:00, ghat at 24 km/h | Arrives 13:42, 42 min late against the 13:00 promise |
| 10 | SHP-1003 planned 10:30; loading delay reported 08:20 with 60 min; promise 14:45; 14 of 26 t loaded | MEDIUM with an open alert at reset; the split (standby VEH-S3) improves arrival by 30 min and is recommended |
| 11 | SHP-1004 and SHP-1005 planned for 17 Nov with 75 and 83 min of slack | All three drivers are busy on 16 Nov. A next-day ETA gets a wide margin from the 10% rule, so the slack keeps them LOW |
| 12 | History cells, cause counts and extremes fixed; the rest random within ranges | The dashboard shows Konkan Roadlines with the breakdowns and RTE-02 with the weather delays |

History totals (on time means arrival at or before the promise):

| | Sahyadri Bulk Carriers | Konkan Roadlines | Route total |
|---|---|---|---|
| RTE-01 | 12, 10 on time | 10, 7 on time | 22, 17 on time (77%) |
| RTE-02 | 9, 7 on time | 9, 4 on time | 18, 11 on time (61%) |
| Total | 21, 17 on time (81%) | 19, 11 on time (58%) | 40, 28 on time (70%) |

Late causes: congestion 4, accident 2, breakdown 2 (both Konkan), weather 2 (both RTE-02), loading delay 1, road closure 1. Lateness ranges from 12 to 140 min; on-time arrivals are 5 to 50 min early. For late shipments the `delay_causes` minutes sum to `lateness_min`.

## Fields beyond what the backend reads

The loader ignores these; they are kept for explanation and checks: `fictional_assumptions` (config), `city`, `delivery_label`, `receiving_window` (customers), `base`, `vehicles` (transporters), `destination_customer_id`, `landmarks`, `geometry_source` (routes), `driver_user_id`, `vehicle_id`, `planned_arrival`, `lateness_min`, `on_time`, `primary_cause` (history), and `day`, `pause_labels`, `role_in_demo`, `loaded_t`, `vehicle_id`, `reported_by`, `derived_from`, `reference_human_events` (scenario).

## Assumptions

- **Projecting a split.** DESIGN.md 6.7 does not say how. The seed checks assume the loaded part leaves at the planned departure without the loading delay, and the balance follows on the standby vehicle.
- **Who reports the loading delay.** The assigned driver reports it, so the estimate source is `DRIVER`.
- **History end date.** History ends on 14 Nov because 15 Nov 2026 is a Sunday.
- **Rounding.** Minutes are rounded half up at each factor; margins are not rounded.
- **Alert numbering.** SHP-1003 opens the first alert at reset, so SHP-1001's alert is ALT-0002, not ALT-0001 as in the DESIGN.md sample.
