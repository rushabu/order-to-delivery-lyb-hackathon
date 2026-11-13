-- Invoice for a shipment (bonus item, brief page 7): one PDF per shipment, uploaded by a coordinator
-- and downloaded by that shipment's customer. The file is kept in the database so a demo reset
-- clears it with everything else. Uploading again replaces the file.
CREATE TABLE invoices (
  shipment_id  TEXT PRIMARY KEY REFERENCES shipments(id),
  filename     TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0),
  content      BLOB NOT NULL,
  uploaded_by  TEXT NOT NULL REFERENCES users(id),
  uploaded_at  TEXT NOT NULL
);
