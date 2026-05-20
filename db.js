const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'inventory.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_number TEXT NOT NULL UNIQUE,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  item_number TEXT NOT NULL,
  description TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 1 CHECK(balance >= 0),
  retired_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS count_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'complete')),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS scan_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES count_sessions(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id),
  tag_number TEXT NOT NULL,
  scanned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, tag_number)
);

CREATE TABLE IF NOT EXISTS discrepancy_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES count_sessions(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  status TEXT NOT NULL CHECK(status IN ('missing', 'found', 'deferred')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, item_id)
);

CREATE TABLE IF NOT EXISTS export_archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES count_sessions(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  workbook BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_items_tag_number ON items(tag_number);
CREATE INDEX IF NOT EXISTS idx_scan_events_session_id ON scan_events(session_id);
CREATE INDEX IF NOT EXISTS idx_scan_events_tag_number ON scan_events(tag_number);
CREATE INDEX IF NOT EXISTS idx_overrides_session_id ON discrepancy_overrides(session_id);
`);

const seedCategory = db.prepare('INSERT OR IGNORE INTO categories (name, prefix) VALUES (?, ?)');
[
  ['Cookers & Accessories', 'CA'],
  ['Firepits', 'FP'],
  ['Fireplace/Firebox', 'FF'],
  ['Gas Logs & Accessories', 'GL'],
  ['Grills & Accessories', 'GA'],
  ['Space Heater', 'SH'],
  ['Water Heater (Rinnai)', 'WH']
].forEach(([name, prefix]) => seedCategory.run(name, prefix));

db.prepare(`
  UPDATE items
  SET category_id = (SELECT id FROM categories WHERE name = 'Grills & Accessories')
  WHERE category_id = (SELECT id FROM categories WHERE name = 'Grills')
`).run();

db.prepare(`
  DELETE FROM categories
  WHERE name IN ('Tanks', 'Grills', 'Accessories')
    AND NOT EXISTS (
      SELECT 1 FROM items WHERE items.category_id = categories.id
    )
`).run();

function rows(statement, params = {}) {
  return db.prepare(statement).all(params);
}

function row(statement, params = {}) {
  return db.prepare(statement).get(params);
}

module.exports = { db, rows, row };
