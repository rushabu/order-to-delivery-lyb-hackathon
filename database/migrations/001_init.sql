-- Initial schema. DESIGN.md section 5.2. All data stored here is fictional.
-- Timestamps are ISO 8601 UTC strings ending in Z. JSON columns hold text.

CREATE TABLE customers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  delivery_lat  REAL NOT NULL,
  delivery_lng  REAL NOT NULL
);

CREATE TABLE transporters (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL
);

CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('COORDINATOR', 'DRIVER', 'CUSTOMER')),
  customer_id     TEXT REFERENCES customers(id),
  transporter_id  TEXT REFERENCES transporters(id),
  phone           TEXT
);

CREATE TABLE orders (
  id                    TEXT PRIMARY KEY,
  customer_id           TEXT NOT NULL REFERENCES customers(id),
  product               TEXT NOT NULL,
  quantity_t            REAL NOT NULL,
  original_promised_by  TEXT NOT NULL,
  agreed_delivery_by    TEXT NOT NULL
);
CREATE INDEX orders_customer ON orders(customer_id);

CREATE TABLE routes (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  origin        TEXT NOT NULL,
  destination   TEXT NOT NULL,
  total_km      REAL NOT NULL,
  geometry      TEXT,            -- GeoJSON LineString, may be null (schedule fallback)
  max_gross_t   REAL,            -- restriction, null when none
  closed        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE route_segments (
  route_id             TEXT NOT NULL REFERENCES routes(id),
  seq                  INTEGER NOT NULL,
  start_km             REAL NOT NULL,
  end_km               REAL NOT NULL,
  baseline_speed_kmph  REAL NOT NULL,
  dwell_after_min      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (route_id, seq)
);

CREATE TABLE route_alternatives (
  route_id      TEXT NOT NULL REFERENCES routes(id),
  alt_route_id  TEXT NOT NULL REFERENCES routes(id),
  exit_km       REAL NOT NULL,
  PRIMARY KEY (route_id, alt_route_id)
);

CREATE TABLE shipments (
  id                       TEXT PRIMARY KEY,
  order_id                 TEXT NOT NULL REFERENCES orders(id),
  transporter_id           TEXT NOT NULL REFERENCES transporters(id),
  driver_user_id           TEXT REFERENCES users(id),
  vehicle_reg              TEXT NOT NULL,
  quantity_t               REAL NOT NULL,
  gross_t                  REAL NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('PLANNED','DISPATCHED','IN_TRANSIT','ARRIVED','DELIVERED','CANCELLED')),
  planned_route_id         TEXT NOT NULL REFERENCES routes(id),
  active_route_id          TEXT NOT NULL REFERENCES routes(id),
  diverted_from_route_id   TEXT REFERENCES routes(id),  -- set by an approved reroute
  diverted_at_km           REAL,                        -- exit km of that reroute
  planned_departure        TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  departed_at              TEXT,
  arrived_at               TEXT,
  delivered_at             TEXT,
  last_lat                 REAL,
  last_lng                 REAL,
  last_progress_km         REAL,
  last_position_at         TEXT,
  current_eta_snapshot_id  TEXT,
  version                  INTEGER NOT NULL DEFAULT 1,  -- +1 on every applied change
  plan_version             INTEGER NOT NULL DEFAULT 1,  -- +1 on disruption or route change; option sets go stale on change
  split_from_shipment_id   TEXT REFERENCES shipments(id)
);
CREATE INDEX shipments_order ON shipments(order_id);
CREATE INDEX shipments_driver ON shipments(driver_user_id);

CREATE TABLE shipment_events (
  event_id        TEXT PRIMARY KEY,
  shipment_id     TEXT NOT NULL REFERENCES shipments(id),
  type            TEXT NOT NULL CHECK (type IN ('POSITION','MILESTONE','DISRUPTION_REPORTED','DISRUPTION_CLEARED')),
  occurred_at     TEXT NOT NULL,
  received_at     TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('HTTP','SIMULATOR','SEED')),
  actor_user_id   TEXT REFERENCES users(id),
  payload         TEXT NOT NULL,
  apply_status    TEXT NOT NULL CHECK (apply_status IN ('APPLIED','STORED_NOT_APPLIED','DUPLICATE')),
  route_id        TEXT,          -- active route when a position was applied
  progress_km     REAL,          -- projected progress when a position was applied
  result          TEXT NOT NULL  -- the response body, returned again for a duplicate event_id
);
CREATE INDEX shipment_events_shipment ON shipment_events(shipment_id, occurred_at);

CREATE TABLE disruptions (
  id                  TEXT PRIMARY KEY,
  shipment_id         TEXT NOT NULL REFERENCES shipments(id),
  route_id            TEXT NOT NULL REFERENCES routes(id),   -- route at_km is measured on
  category            TEXT NOT NULL CHECK (category IN ('ACCIDENT','BREAKDOWN','WEATHER','ROAD_CLOSURE','LOADING_DELAY','OTHER')),
  at_km               REAL,
  expected_delay_min  INTEGER NOT NULL,
  estimate_source     TEXT NOT NULL CHECK (estimate_source IN ('DRIVER','DEFAULT')),
  note                TEXT,
  reported_at         TEXT NOT NULL,
  cleared_at          TEXT
);
CREATE INDEX disruptions_shipment ON disruptions(shipment_id);

CREATE TABLE eta_snapshots (
  id                TEXT PRIMARY KEY,
  seq               INTEGER NOT NULL UNIQUE,
  shipment_id       TEXT NOT NULL REFERENCES shipments(id),
  computed_at       TEXT NOT NULL,
  trigger_event_id  TEXT,
  route_id          TEXT NOT NULL,
  progress_km       REAL,
  remaining_km      REAL,
  eta               TEXT NOT NULL,
  eta_earliest      TEXT NOT NULL,
  eta_latest        TEXT NOT NULL,
  promised_by       TEXT NOT NULL,
  slack_min         INTEGER NOT NULL,
  margin_min        INTEGER NOT NULL,
  risk_score        INTEGER NOT NULL,
  risk_level        TEXT NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH')),
  confidence        TEXT NOT NULL CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  position_age_min  INTEGER,
  factors           TEXT NOT NULL,
  headline          TEXT NOT NULL,
  stale             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX eta_snapshots_shipment ON eta_snapshots(shipment_id, seq);

CREATE TABLE alerts (
  id                 TEXT PRIMARY KEY,
  shipment_id        TEXT NOT NULL REFERENCES shipments(id),
  level              TEXT NOT NULL CHECK (level IN ('MEDIUM','HIGH')),
  status             TEXT NOT NULL CHECK (status IN ('OPEN','DECIDED','RESOLVED')),
  title              TEXT NOT NULL,
  opened_at          TEXT NOT NULL,
  first_snapshot_id  TEXT NOT NULL,
  customer_notified  INTEGER NOT NULL DEFAULT 0,
  low_since          TEXT,
  resolved_at        TEXT
);
-- At most one OPEN alert per shipment.
CREATE UNIQUE INDEX alerts_one_open ON alerts(shipment_id) WHERE status = 'OPEN';

CREATE TABLE option_sets (
  id                     TEXT PRIMARY KEY,
  alert_id               TEXT NOT NULL REFERENCES alerts(id),
  shipment_id            TEXT NOT NULL REFERENCES shipments(id),
  generated_at           TEXT NOT NULL,
  valid_until            TEXT NOT NULL,
  based_on_snapshot_id   TEXT NOT NULL,
  plan_version           INTEGER NOT NULL,
  options                TEXT NOT NULL,
  recommended_option_id  TEXT NOT NULL,
  recommendation_reason  TEXT NOT NULL
);

CREATE TABLE decisions (
  id               TEXT PRIMARY KEY,
  decision_id      TEXT NOT NULL UNIQUE,   -- client UUID, idempotency key
  option_set_id    TEXT NOT NULL REFERENCES option_sets(id),
  option_id        TEXT NOT NULL,
  option_type      TEXT NOT NULL,
  shipment_id      TEXT NOT NULL REFERENCES shipments(id),
  decided_by       TEXT NOT NULL REFERENCES users(id),
  decided_at       TEXT NOT NULL,
  note             TEXT,
  predicted        TEXT NOT NULL,
  outcome          TEXT,
  result           TEXT NOT NULL           -- the 201 body, returned again for a repeated decision_id
);

CREATE TABLE notifications (
  id           TEXT PRIMARY KEY,
  seq          INTEGER NOT NULL UNIQUE,
  user_id      TEXT NOT NULL REFERENCES users(id),
  shipment_id  TEXT REFERENCES shipments(id),
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  read_at      TEXT
);
CREATE INDEX notifications_user ON notifications(user_id, seq);

CREATE TABLE audit_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             TEXT NOT NULL,
  actor_user_id  TEXT,
  action         TEXT NOT NULL,
  entity         TEXT NOT NULL,
  entity_id      TEXT,
  detail         TEXT NOT NULL
);

-- Delay minutes by cause for arrived shipments; filled from history fixtures and on arrival.
CREATE TABLE shipment_delay_causes (
  shipment_id  TEXT NOT NULL REFERENCES shipments(id),
  cause        TEXT NOT NULL,
  minutes      INTEGER NOT NULL,
  PRIMARY KEY (shipment_id, cause)
);

-- Counters for readable identifiers such as ETA-000318 and ALT-0001.
CREATE TABLE id_counters (
  name   TEXT PRIMARY KEY,
  value  INTEGER NOT NULL
);

-- Standby vehicles that make SPLIT_SHIPMENT feasible (fixture data).
CREATE TABLE standby_vehicles (
  vehicle_reg     TEXT PRIMARY KEY,
  transporter_id  TEXT NOT NULL REFERENCES transporters(id),
  available       INTEGER NOT NULL DEFAULT 1
);
