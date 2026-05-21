const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const { WebSocketServer } = require('ws');
const { db, rows, row } = require('./db');
const packageInfo = require('./package.json');

const PORT = Number(process.env.PORT || 3000);
const APP_VERSION = packageInfo.version;
const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const defaultAllowedOrigins = [
  'https://parkerinvscanner.netlify.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];
const configuredAllowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  : [];
const allowedOrigins = new Set([...defaultAllowedOrigins, ...configuredAllowedOrigins]);
const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
};

app.use(cors(corsOptions));
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/html5-qrcode', express.static(path.join(__dirname, 'node_modules', 'html5-qrcode')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(type, payload) {
  const data = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

function itemSelect(where = 'WHERE i.retired_at IS NULL') {
  return `
    SELECT i.id, i.tag_number, c.name AS category, c.prefix, i.item_number,
           i.description, i.balance, i.retired_at, i.created_at, i.updated_at
    FROM items i
    JOIN categories c ON c.id = i.category_id
    ${where}
    ORDER BY c.name, i.tag_number
  `;
}

function lanIp() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const entry of iface || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return 'localhost';
}

function nextTagNumber() {
  const found = [
    ...rows("SELECT tag_number FROM items WHERE tag_number LIKE 'W-%'"),
    ...rows("SELECT tag_number FROM pending_new_items WHERE tag_number LIKE 'W-%'")
  ];
  const max = found.reduce((highest, item) => {
    const match = item.tag_number.match(/^W-(\d+)$/);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return `W-${String(max + 1).padStart(3, '0')}`;
}

function prefixFromName(name) {
  const base = name
    .replace(/&/g, ' ')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => !['and', 'the', 'of'].includes(word.toLowerCase()))
    .map((word) => word[0])
    .join('')
    .slice(0, 3)
    .toUpperCase() || 'CAT';
  let prefix = base;
  let suffix = 2;
  while (row('SELECT id FROM categories WHERE prefix = ?', [prefix])) {
    prefix = `${base}${suffix}`;
    suffix += 1;
  }
  return prefix;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  return lines.map((line) => {
    const cells = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === ',' && !quoted) {
        cells.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    cells.push(current.trim());
    return cells;
  });
}

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[#]/g, ' number')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function csvValue(record, headerIndex, aliases, fallbackIndex) {
  for (const alias of aliases) {
    const index = headerIndex.get(alias);
    if (index !== undefined) return String(record[index] || '').trim();
  }
  return String(record[fallbackIndex] || '').trim();
}

function hasHeader(headerIndex, aliases) {
  return aliases.some((alias) => headerIndex.has(alias));
}

function numericBalance(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function inventoryImportRows(records) {
  if (!records.length) return [];
  const headers = records[0].map(normalizeHeader);
  const headerIndex = new Map(headers.map((header, index) => [header, index]));
  const hasRecognizedHeaders = ['tag count', 'tag number', 'tag', 'category name', 'category', 'item number', 'description']
    .some((header) => headerIndex.has(header));
  const dataRows = hasRecognizedHeaders ? records.slice(1) : records;

  return dataRows.map((record) => {
    const categoryFallback = hasRecognizedHeaders ? 1 : 0;
    const itemFallback = hasRecognizedHeaders ? 2 : 1;
    const descriptionFallback = hasRecognizedHeaders ? 3 : 2;
    const balanceFallback = hasRecognizedHeaders ? 4 : 3;
    return {
      category: csvValue(record, headerIndex, ['category name', 'category'], categoryFallback),
      itemNumber: csvValue(record, headerIndex, ['item number', 'item'], itemFallback),
      description: csvValue(record, headerIndex, ['description', 'desc'], descriptionFallback),
      balance: numericBalance(csvValue(record, headerIndex, ['balance', 'expected balance', 'count'], balanceFallback))
    };
  });
}

function taggedInventoryImportRows(records) {
  if (!records.length) return [];
  const headers = records[0].map(normalizeHeader);
  const headerIndex = new Map(headers.map((header, index) => [header, index]));
  const hasRecognizedHeaders = ['tag count', 'tag number', 'tag', 'category name', 'category', 'item number', 'description']
    .some((header) => headerIndex.has(header));
  const dataRows = hasRecognizedHeaders ? records.slice(1) : records;

  return dataRows.flatMap((record) => {
    const tagCell = csvValue(record, headerIndex, ['tag count', 'tag number', 'tag'], 0);
    const category = csvValue(record, headerIndex, ['category name', 'category'], 1);
    const itemNumber = csvValue(record, headerIndex, ['item number', 'item'], 2);
    const description = csvValue(record, headerIndex, ['description', 'desc'], 3);
    return tagCell
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
      .map((tag) => ({ tag, category, itemNumber, description }));
  });
}

function activeExpectedInventory() {
  return rows(`
    SELECT e.id, c.name AS category, e.item_number, e.description, e.balance
    FROM expected_inventory e
    JOIN categories c ON c.id = e.category_id
    WHERE e.retired_at IS NULL
    ORDER BY c.name, e.item_number, e.description
  `);
}

function actualCountGroups(sessionId) {
  return rows(`
    SELECT c.name AS category, i.item_number, i.description, COUNT(*) AS actual_count
    FROM scan_events s
    JOIN items i ON i.id = s.item_id
    JOIN categories c ON c.id = i.category_id
    WHERE s.session_id = ?
    GROUP BY c.name, i.item_number, i.description
  `, [sessionId]);
}

function normalizeGroupValue(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
}

function itemGroupKey(item) {
  const category = normalizeGroupValue(item.category);
  const itemNumber = normalizeGroupValue(item.item_number);
  const description = normalizeGroupValue(item.description);
  return [category, itemNumber || description].join('\u001F');
}

function groupedExpectedInventory() {
  return Array.from(activeExpectedInventory().reduce((groups, item) => {
    const key = itemGroupKey(item);
    if (!groups.has(key)) {
      groups.set(key, {
        id: item.id,
        category: item.category,
        item_number: item.item_number,
        description: item.description,
        balance: 0,
        expected_count: 0,
        source: 'expected'
      });
    }
    const group = groups.get(key);
    group.balance += Number(item.balance || 0);
    group.expected_count = group.balance;
    return groups;
  }, new Map()).values());
}

function reviewComparison(sessionId) {
  const expectedMap = new Map(groupedExpectedInventory().map((item) => [itemGroupKey(item), item]));
  const actualGroups = actualCountGroups(sessionId);
  const actualMap = new Map(actualGroups.map((item) => [itemGroupKey(item), Number(item.actual_count || 0)]));
  const scanned = actualGroups.map((actual) => {
    const key = itemGroupKey(actual);
    const expected = expectedMap.get(key);
    const balance = Number(expected?.balance || 0);
    const actualCount = Number(actual.actual_count || 0);
    return {
      ...(expected || {}),
      ...actual,
      id: expected?.id || key,
      tag_number: '',
      source: expected ? 'expected' : 'actual',
      expected_count: balance,
      balance,
      actual_count: actualCount,
      missing: Math.max(balance - actualCount, 0),
      overage: Math.max(actualCount - balance, 0)
    };
  });
  const notScanned = Array.from(expectedMap.entries()).map(([key, expected]) => {
    const actualCount = actualMap.get(key) || 0;
    return {
      ...expected,
      tag_number: '',
      expected_count: expected.balance,
      actual_count: actualCount,
      missing: Math.max(expected.balance - actualCount, 0),
      overage: Math.max(actualCount - expected.balance, 0)
    };
  }).filter((item) => item.missing > 0);
  return { scanned, notScanned };
}

function pendingItemSelect(where = '') {
  return `
    SELECT p.id, p.tag_number, p.category_id, c.name AS category, p.item_number,
           p.description, p.status, p.item_id, p.created_at, p.updated_at
    FROM pending_new_items p
    JOIN categories c ON c.id = p.category_id
    ${where}
    ORDER BY p.created_at DESC, p.id DESC
  `;
}

function upsertRegistryItem({ tag_number, category_id, item_number, description }) {
  const info = db.prepare(`
    INSERT INTO items (tag_number, category_id, item_number, description, balance)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tag_number) DO UPDATE SET
      category_id = excluded.category_id,
      item_number = excluded.item_number,
      description = excluded.description,
      balance = excluded.balance,
      retired_at = NULL,
      updated_at = CURRENT_TIMESTAMP
  `).run(tag_number.trim(), Number(category_id), String(item_number || '').trim(), String(description || '').trim(), 1);
  return row(itemSelect('WHERE i.tag_number = ?'), [tag_number.trim()]) || row(itemSelect('WHERE i.id = ?'), [info.lastInsertRowid]);
}

app.get('/api/categories', (req, res) => {
  res.json(rows('SELECT id, name, prefix FROM categories ORDER BY id'));
});

app.post('/api/categories', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  try {
    const info = db.prepare('INSERT INTO categories (name, prefix) VALUES (?, ?)').run(name, prefixFromName(name));
    res.status(201).json(row('SELECT id, name, prefix FROM categories WHERE id = ?', [info.lastInsertRowid]));
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That category already exists.' });
    }
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/network-info', (req, res) => {
  const publicBase = process.env.PUBLIC_APP_URL || process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  res.json({
    host: publicBase ? new URL(publicBase).host : lanIp(),
    port: PORT,
    scannerUrl: publicBase ? `${publicBase}/scanner.html` : `http://${lanIp()}:${PORT}/scanner.html`
  });
});

app.get('/api/items', (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  const category = req.query.category || '';
  let sql = itemSelect('WHERE i.retired_at IS NULL');
  const params = [];
  if (req.query.q) {
    sql = sql.replace('WHERE i.retired_at IS NULL', 'WHERE i.retired_at IS NULL AND (i.tag_number LIKE ? OR i.item_number LIKE ? OR i.description LIKE ?)');
    params.push(q, q, q);
  }
  if (category) {
    sql = sql.replace('ORDER BY', 'AND c.name = ? ORDER BY');
    params.push(category);
  }
  res.json(rows(sql, params));
});

app.get('/api/expected-inventory', (req, res) => {
  res.json(activeExpectedInventory());
});

app.get('/api/items/next-tag/:categoryId', (req, res) => {
  res.json({ tag_number: nextTagNumber() });
});

app.get('/api/items/next-tag', (req, res) => {
  res.json({ tag_number: nextTagNumber() });
});

app.post('/api/items', (req, res) => {
  const { tag_number, category_id, item_number, description } = req.body;
  if (!tag_number || !category_id) {
    return res.status(400).json({ error: 'Tag # and category are required.' });
  }
  try {
    const item = upsertRegistryItem({ tag_number, category_id, item_number, description });
    res.status(201).json(item);
    broadcast('items:changed', {});
  } catch (error) {
    res.status(409).json({ error: error.message });
  }
});

app.put('/api/items/:id', (req, res) => {
  const { tag_number, category_id, item_number, description } = req.body;
  db.prepare(`
    UPDATE items
    SET tag_number = ?, category_id = ?, item_number = ?, description = ?, balance = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(tag_number.trim(), Number(category_id), String(item_number || '').trim(), String(description || '').trim(), 1, Number(req.params.id));
  broadcast('items:changed', {});
  res.json(row(itemSelect('WHERE i.id = ?'), [Number(req.params.id)]));
});

app.get('/api/pending-items', (req, res) => {
  res.json(rows(pendingItemSelect()));
});

app.post('/api/pending-items', (req, res) => {
  const { tag_number, category_id, item_number, description } = req.body;
  if (!tag_number || !category_id) {
    return res.status(400).json({ error: 'Tag # and category are required.' });
  }
  try {
    const info = db.prepare(`
      INSERT INTO pending_new_items (tag_number, category_id, item_number, description)
      VALUES (?, ?, ?, ?)
    `).run(tag_number.trim(), Number(category_id), String(item_number || '').trim(), String(description || '').trim());
    const pendingItem = row(pendingItemSelect('WHERE p.id = ?'), [info.lastInsertRowid]);
    broadcast('pending:changed', pendingItem);
    res.status(201).json(pendingItem);
  } catch (error) {
    res.status(409).json({ error: error.message });
  }
});

app.put('/api/pending-items/:id', (req, res) => {
  const { tag_number, category_id, item_number, description } = req.body;
  db.prepare(`
    UPDATE pending_new_items
    SET tag_number = ?, category_id = ?, item_number = ?, description = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(tag_number.trim(), Number(category_id), String(item_number || '').trim(), String(description || '').trim(), Number(req.params.id));
  const pendingItem = row(pendingItemSelect('WHERE p.id = ?'), [Number(req.params.id)]);
  broadcast('pending:changed', pendingItem);
  res.json(pendingItem);
});

app.post('/api/pending-items/:id/approve', (req, res) => {
  const pendingItem = row('SELECT * FROM pending_new_items WHERE id = ?', [Number(req.params.id)]);
  if (!pendingItem) return res.status(404).json({ error: 'Pending item not found.' });
  try {
    const item = upsertRegistryItem(pendingItem);
    db.prepare(`
      UPDATE pending_new_items
      SET status = 'approved', item_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(item.id, pendingItem.id);
    const updated = row(pendingItemSelect('WHERE p.id = ?'), [pendingItem.id]);
    broadcast('items:changed', {});
    broadcast('pending:changed', updated);
    res.json({ pending: updated, item });
  } catch (error) {
    res.status(409).json({ error: error.message });
  }
});

app.post('/api/pending-items/approve-all', (req, res) => {
  const pendingItems = rows("SELECT * FROM pending_new_items ORDER BY created_at, id");
  const approved = [];
  const transaction = db.transaction(() => {
    for (const pendingItem of pendingItems) {
      const item = upsertRegistryItem(pendingItem);
      db.prepare(`
        UPDATE pending_new_items
        SET status = 'approved', item_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(item.id, pendingItem.id);
      approved.push(item);
    }
  });
  transaction();
  broadcast('items:changed', {});
  broadcast('pending:changed', {});
  res.json({ approved });
});

app.delete('/api/pending-items/:id', (req, res) => {
  db.prepare('DELETE FROM pending_new_items WHERE id = ?').run(Number(req.params.id));
  broadcast('pending:changed', {});
  res.json({ ok: true });
});

app.delete('/api/items/:id', (req, res) => {
  db.prepare('UPDATE items SET retired_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(Number(req.params.id));
  broadcast('items:changed', {});
  res.json({ ok: true });
});

app.post('/api/items/retire-all', (req, res) => {
  const info = db.prepare(`
    UPDATE expected_inventory
    SET retired_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE retired_at IS NULL
  `).run();
  broadcast('items:changed', {});
  res.json({ retired: info.changes });
});

app.post('/api/items/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required.' });
  const categoryMap = new Map(rows('SELECT id, name FROM categories').map((c) => [c.name.toLowerCase(), c.id]));
  const ensureCategory = (name) => {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    if (categoryMap.has(key)) return categoryMap.get(key);
    const cleanName = String(name).trim();
    const info = db.prepare('INSERT INTO categories (name, prefix) VALUES (?, ?)').run(cleanName, prefixFromName(cleanName));
    categoryMap.set(key, info.lastInsertRowid);
    return info.lastInsertRowid;
  };
  const insertExpected = db.prepare(`
    INSERT INTO expected_inventory (category_id, item_number, description, balance)
    VALUES (?, ?, ?, ?)
  `);
  let imported = 0;
  let skipped = 0;
  let expectedImported = 0;
  const transaction = db.transaction((records) => {
    for (const item of inventoryImportRows(records)) {
      const categoryId = ensureCategory(item.category);
      if (!categoryId) {
        skipped += 1;
        continue;
      }
      insertExpected.run(categoryId, item.itemNumber, item.description, item.balance);
      expectedImported += 1;
      imported += 1;
    }
  });
  transaction(parseCsv(req.file.buffer.toString('utf8')));
  broadcast('items:changed', {});
  res.json({ imported, skipped, expectedImported, taggedImported: 0 });
});

app.post('/api/items/import-tags', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required.' });
  const categoryMap = new Map(rows('SELECT id, name FROM categories').map((c) => [c.name.toLowerCase(), c.id]));
  const ensureCategory = (name) => {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    if (categoryMap.has(key)) return categoryMap.get(key);
    const cleanName = String(name).trim();
    const info = db.prepare('INSERT INTO categories (name, prefix) VALUES (?, ?)').run(cleanName, prefixFromName(cleanName));
    categoryMap.set(key, info.lastInsertRowid);
    return info.lastInsertRowid;
  };
  const insert = db.prepare(`
    INSERT INTO items (tag_number, category_id, item_number, description, balance)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tag_number) DO UPDATE SET
      category_id = excluded.category_id,
      item_number = excluded.item_number,
      description = excluded.description,
      balance = excluded.balance,
      retired_at = NULL,
      updated_at = CURRENT_TIMESTAMP
  `);
  const importedTags = [];
  let skipped = 0;
  const transaction = db.transaction((records) => {
    for (const item of taggedInventoryImportRows(records)) {
      const categoryId = ensureCategory(item.category);
      if (!item.tag || !categoryId) {
        skipped += 1;
        continue;
      }
      insert.run(item.tag, categoryId, item.itemNumber, item.description, 1);
      importedTags.push(item.tag);
    }
  });
  transaction(parseCsv(req.file.buffer.toString('utf8')));
  const importedItems = importedTags.length
    ? rows(`${itemSelect(`WHERE i.tag_number IN (${importedTags.map(() => '?').join(',')}) AND i.retired_at IS NULL`)}`, importedTags)
    : [];
  broadcast('items:changed', {});
  res.json({ imported: importedTags.length, skipped, tags: importedTags, items: importedItems });
});

app.get('/api/qr/:tag', async (req, res) => {
  res.type('png');
  QRCode.toFileStream(res, req.params.tag, { width: 280, margin: 1 });
});

app.get('/api/connection-qr', async (req, res) => {
  res.type('png');
  const target = req.query.target || `http://${lanIp()}:${PORT}/scanner.html`;
  QRCode.toFileStream(res, String(target), { width: 260, margin: 1 });
});

app.get('/api/labels', (req, res) => {
  const filter = req.query.category ? 'WHERE i.retired_at IS NULL AND c.name = ?' : 'WHERE i.retired_at IS NULL';
  res.json(rows(itemSelect(filter), req.query.category ? [req.query.category] : []));
});

app.post('/api/sessions', (req, res) => {
  const now = new Date();
  const month = Number(req.body.month || now.getMonth() + 1);
  const year = Number(req.body.year || now.getFullYear());
  db.prepare(`
    UPDATE count_sessions
    SET status = 'complete',
        completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
    WHERE status IN ('active', 'paused')
  `).run();
  const info = db.prepare('INSERT INTO count_sessions (month, year) VALUES (?, ?)').run(month, year);
  const session = row('SELECT * FROM count_sessions WHERE id = ?', [info.lastInsertRowid]);
  broadcast('sessions:changed', session);
  res.status(201).json(session);
});

app.get('/api/sessions/active', (req, res) => {
  const latest = row('SELECT * FROM count_sessions ORDER BY id DESC LIMIT 1');
  res.json(latest && ['active', 'paused'].includes(latest.status) ? latest : null);
});

app.get('/api/sessions/latest', (req, res) => {
  res.json(row('SELECT * FROM count_sessions ORDER BY id DESC LIMIT 1') || null);
});

app.get('/api/sessions/:id', (req, res) => {
  res.json(row('SELECT * FROM count_sessions WHERE id = ?', [Number(req.params.id)]));
});

app.patch('/api/sessions/:id', (req, res) => {
  const status = req.body.status;
  if (!['active', 'paused', 'complete'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  try {
    db.prepare(`
      UPDATE count_sessions
      SET status = ?,
          completed_at = CASE WHEN ? = 'complete' THEN CURRENT_TIMESTAMP ELSE completed_at END
      WHERE id = ?
    `).run(status, status, Number(req.params.id));
    const session = row('SELECT * FROM count_sessions WHERE id = ?', [Number(req.params.id)]);
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    broadcast('sessions:changed', session);
    res.json(session);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function recordScan(sessionId, tagNumber) {
  const item = row(itemSelect('WHERE i.tag_number = ? AND i.retired_at IS NULL'), [tagNumber]);
  const session = row("SELECT * FROM count_sessions WHERE id = ? AND status IN ('active', 'paused')", [sessionId]);
  if (!session) return { error: 'No active count session found.', status: 400 };
  if (!item) return { error: `No active item found for ${tagNumber}.`, status: 404 };
  try {
    db.prepare('INSERT INTO scan_events (session_id, item_id, tag_number) VALUES (?, ?, ?)').run(sessionId, item.id, tagNumber);
    const scan = row(`
      SELECT s.*, i.description, i.item_number, c.name AS category
      FROM scan_events s
      JOIN items i ON i.id = s.item_id
      JOIN categories c ON c.id = i.category_id
      WHERE s.session_id = ? AND s.tag_number = ?
    `, [sessionId, tagNumber]);
    broadcast('scan:created', scan);
    return { scan, duplicate: false };
  } catch (error) {
    const scan = row('SELECT * FROM scan_events WHERE session_id = ? AND tag_number = ?', [sessionId, tagNumber]);
    return { scan, duplicate: true };
  }
}

app.post('/api/scans', (req, res) => {
  const result = recordScan(Number(req.body.session_id), String(req.body.tag_number || '').trim());
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(result.duplicate ? 200 : 201).json(result);
});

app.post('/api/scans/batch', (req, res) => {
  const sessionId = Number(req.body.session_id);
  const tags = Array.isArray(req.body.tags) ? req.body.tags : [];
  const results = tags.map((tag) => ({ tag, ...recordScan(sessionId, String(tag).trim()) }));
  res.json({ results });
});

app.get('/api/sessions/:id/scans', (req, res) => {
  res.json(rows(`
    SELECT s.*, i.description, i.item_number, c.name AS category
    FROM scan_events s
    LEFT JOIN items i ON i.id = s.item_id
    LEFT JOIN categories c ON c.id = i.category_id
    WHERE s.session_id = ?
    ORDER BY s.scanned_at DESC
  `, [Number(req.params.id)]));
});

app.get('/api/sessions/:id/review', (req, res) => {
  const sessionId = Number(req.params.id);
  const { scanned, notScanned } = reviewComparison(sessionId);
  const overrides = rows(`
    SELECT o.*, i.tag_number, i.item_number, i.description, i.balance, c.name AS category
    FROM discrepancy_overrides o
    JOIN items i ON i.id = o.item_id
    JOIN categories c ON c.id = i.category_id
    WHERE o.session_id = ?
    ORDER BY c.name, i.tag_number
  `, [sessionId]);
  res.json({ scanned, notScanned, overrides });
});

app.post('/api/sessions/:id/overrides', (req, res) => {
  const sessionId = Number(req.params.id);
  const { item_id, status, notes } = req.body;
  db.prepare(`
    INSERT INTO discrepancy_overrides (session_id, item_id, status, notes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id, item_id) DO UPDATE SET
      status = excluded.status,
      notes = excluded.notes,
      updated_at = CURRENT_TIMESTAMP
  `).run(sessionId, Number(item_id), status, notes || '');
  broadcast('review:changed', { session_id: sessionId });
  res.json({ ok: true });
});

app.get('/api/sessions/:id/export', async (req, res) => {
  const session = row('SELECT * FROM count_sessions WHERE id = ?', [Number(req.params.id)]);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  const monthName = new Date(session.year, session.month - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const { scanned, notScanned } = reviewComparison(session.id);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(monthName);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.addRow(['Tag Count', 'Category Name', 'Item Number', 'Description', 'Balance', 'Actual Count', 'Missing']);
  sheet.getRow(1).eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
    cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
  });
  const exportRows = [...scanned, ...notScanned.filter((missingItem) => !scanned.some((scannedItem) => itemGroupKey(scannedItem) === itemGroupKey(missingItem)))];
  exportRows
    .sort((a, b) => a.category.localeCompare(b.category) || a.item_number.localeCompare(b.item_number, undefined, { numeric: true }))
    .forEach((item) => {
      sheet.addRow(['', item.category, item.item_number, item.description, item.balance, item.actual_count, item.missing]);
    });
  sheet.columns.forEach((column) => {
    let max = 12;
    column.eachCell({ includeEmpty: true }, (cell) => {
      max = Math.max(max, String(cell.value || '').length + 2);
    });
    column.width = max;
  });
  const buffer = await workbook.xlsx.writeBuffer();
  const fileName = `${session.year}-${String(session.month).padStart(2, '0')}_Inventory.xlsx`;
  fs.mkdirSync(path.join(__dirname, 'exports'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'exports', fileName), Buffer.from(buffer));
  db.prepare('INSERT INTO export_archives (session_id, file_name, workbook) VALUES (?, ?, ?)').run(session.id, fileName, Buffer.from(buffer));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(Buffer.from(buffer));
});

app.get('/health', (req, res) => res.json({ ok: true, version: APP_VERSION }));

server.listen(PORT, '0.0.0.0', () => {
  const publicBase = process.env.PUBLIC_APP_URL || process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  console.log(`Parker Inventory Scanner v${APP_VERSION} running at http://localhost:${PORT}`);
  console.log(`Scanner URL: ${publicBase ? `${publicBase}/scanner.html` : `http://${lanIp()}:${PORT}/scanner.html`}`);
}).on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Close the other app or start this one with PORT=3001 npm start.`);
  } else {
    console.error('Unable to start Parker Inventory Scanner:', error.message);
  }
  process.exit(1);
});
