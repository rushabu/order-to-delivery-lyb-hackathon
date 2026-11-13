-- Driver operations: start-of-shift checks, stops, coordinator check-ins, delivery photo.

-- A passed check. Only the fact and the time are kept: nothing from the licence image or the voice
-- recording ever reaches the server (both are processed in the driver's browser and discarded).
CREATE TABLE driver_checks (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL CHECK (kind IN ('LICENCE', 'VOICE')),
  passed_at  TEXT NOT NULL  -- real time, not the demo clock: identity checks are about the real world
);
CREATE INDEX driver_checks_user ON driver_checks(user_id, kind, passed_at);

-- A stop on the road: declared by the driver (a break, fuel, charging) or detected from positions.
CREATE TABLE stops (
  id           TEXT PRIMARY KEY,
  shipment_id  TEXT NOT NULL REFERENCES shipments(id),
  kind         TEXT NOT NULL CHECK (kind IN ('BREAK', 'FUEL', 'CHARGING', 'OTHER', 'UNPLANNED')),
  source       TEXT NOT NULL CHECK (source IN ('DRIVER', 'DETECTED')),
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  at_km        REAL
);
CREATE INDEX stops_shipment ON stops(shipment_id, started_at);

-- A coordinator asks the driver to check in; the driver answers OK or PROBLEM.
CREATE TABLE checkins (
  id             TEXT PRIMARY KEY,
  shipment_id    TEXT NOT NULL REFERENCES shipments(id),
  requested_by   TEXT NOT NULL REFERENCES users(id),
  requested_at   TEXT NOT NULL,
  message        TEXT,
  responded_at   TEXT,
  response       TEXT CHECK (response IN ('OK', 'PROBLEM')),
  response_note  TEXT
);
CREATE INDEX checkins_shipment ON checkins(shipment_id, requested_at);

-- Delivery photo from the driver, stored in the database. (Invoices have their own table, 002_invoices.sql.)
CREATE TABLE documents (
  id           TEXT PRIMARY KEY,
  shipment_id  TEXT NOT NULL REFERENCES shipments(id),
  kind         TEXT NOT NULL CHECK (kind = 'DELIVERY_PHOTO'),
  mime         TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  data         BLOB NOT NULL,
  uploaded_by  TEXT NOT NULL REFERENCES users(id),
  uploaded_at  TEXT NOT NULL,
  verified_by  TEXT REFERENCES users(id),
  verified_at  TEXT
);
CREATE INDEX documents_shipment ON documents(shipment_id, kind);
