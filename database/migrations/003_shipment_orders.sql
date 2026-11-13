-- Orders added to a truck that was already planned for the same customer (load consolidation at dispatch).
-- shipments.order_id stays the truck's first order; each row here is one more order riding with it.
-- The shipment's quantity_t and gross_t already include these tonnes.
CREATE TABLE shipment_orders (
  order_id     TEXT PRIMARY KEY REFERENCES orders(id),
  shipment_id  TEXT NOT NULL REFERENCES shipments(id),
  added_by     TEXT NOT NULL REFERENCES users(id),
  added_at     TEXT NOT NULL
);
CREATE INDEX shipment_orders_shipment ON shipment_orders(shipment_id);
