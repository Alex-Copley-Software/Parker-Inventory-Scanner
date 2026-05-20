const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { db, rows } = require('../db');

assert(rows('SELECT * FROM categories').length >= 7, 'categories should be seeded');
assert(fs.existsSync(path.join(__dirname, '..', 'public', 'index.html')), 'admin app should exist');
assert(fs.existsSync(path.join(__dirname, '..', 'public', 'scanner.html')), 'scanner app should exist');

db.prepare('DELETE FROM discrepancy_overrides').run();
db.prepare('DELETE FROM scan_events').run();
db.prepare('DELETE FROM count_sessions').run();
db.prepare('DELETE FROM items WHERE tag_number LIKE ?').run('__SMOKE__%');

const category = db.prepare('SELECT id FROM categories ORDER BY id LIMIT 1').get();
const item = db.prepare(`
  INSERT INTO items (tag_number, category_id, item_number, description, balance)
  VALUES (?, ?, ?, ?, ?)
`).run('__SMOKE__T-001', category.id, 'SMOKE-1', 'Smoke test item', 1);
const session = db.prepare('INSERT INTO count_sessions (month, year) VALUES (?, ?)').run(5, 2026);
db.prepare('INSERT INTO scan_events (session_id, item_id, tag_number) VALUES (?, ?, ?)').run(session.lastInsertRowid, item.lastInsertRowid, '__SMOKE__T-001');

const scans = rows('SELECT * FROM scan_events WHERE session_id = ?', [session.lastInsertRowid]);
assert(scans.length === 1, 'scan should record');

db.prepare('DELETE FROM scan_events WHERE session_id = ?').run(session.lastInsertRowid);
db.prepare('DELETE FROM count_sessions WHERE id = ?').run(session.lastInsertRowid);
db.prepare('DELETE FROM items WHERE id = ?').run(item.lastInsertRowid);

console.log('Smoke test passed.');
