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
  const found = rows("SELECT tag_number FROM items WHERE tag_number LIKE 'W-%'");
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
  const hasRecognizedHeaders = ['tag count', 'tag number', 'tag', 'category name', 'item number', 'description']
    .some((header) => headerIndex.has(header));
  const dataRows = hasRecognizedHeaders ? records.slice(1) : records;

  return dataRows.flatMap((record) => {
    const tagAliases = ['tag count', 'tag number', 'tag'];
    const tagCell = hasRecognizedHeaders && !hasHeader(headerIndex, tagAliases) ? '' : csvValue(record, headerIndex, tagAliases, 0);
    const category = csvValue(record, headerIndex, ['category name', 'category'], 1);
    const itemNumber = csvValue(record, headerIndex, ['item number', 'item'], 2);
    const description = csvValue(record, headerIndex, ['description', 'desc'], 3);
    const balance = numericBalance(csvValue(record, headerIndex, ['balance', 'expected balance', 'count'], 4));
    const tags = tagCell.split(',').map((tag) => tag.trim()).filter(Boolean);
    if (!tags.length) return [{ tag: '', category, itemNumber, description, balance, expectedOnly: true }];
    return tags.map((tag) => ({ tag, category, itemNumber, description, balance: 1, expectedOnly: false }));
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

function itemGroupKey(item) {
  return [item.category, item.item_number || '', item.description || ''].join('\u001F');
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
    const info = db.prepare(`
      INSERT INTO items (tag_number, category_id, item_number, description, balance)
      VALUES (?, ?, ?, ?, ?)
    `).run(tag_number.trim(), Number(category_id), String(item_number || '').trim(), String(description || '').trim(), 1);
    res.status(201).json(row(itemSelect('WHERE i.id = ?'), [info.lastInsertRowid]));
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
  const insertExpected = db.prepare(`
    INSERT INTO expected_inventory (category_id, item_number, description, balance)
    VALUES (?, ?, ?, ?)
  `);
  let imported = 0;
  let skipped = 0;
  let expectedImported = 0;
  let taggedImported = 0;
  const transaction = db.transaction((records) => {
    for (const item of inventoryImportRows(records)) {
      const categoryId = ensureCategory(item.category);
      if (!categoryId) {
        skipped += 1;
        continue;
      }
      if (item.expectedOnly) {
        insertExpected.run(categoryId, item.itemNumber, item.description, item.balance);
        expectedImported += 1;
      } else {
        insert.run(item.tag, categoryId, item.itemNumber, item.description, 1);
        taggedImported += 1;
      }
      imported += 1;
    }
  });
  transaction(parseCsv(req.file.buffer.toString('utf8')));
  broadcast('items:changed', {});
  res.json({ imported, skipped, expectedImported, taggedImported });
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
  const info = db.prepare('INSERT INTO count_sessions (month, year) VALUES (?, ?)').run(month, year);
  const session = row('SELECT * FROM count_sessions WHERE id = ?', [info.lastInsertRowid]);
  broadcast('sessions:changed', session);
  res.status(201).json(session);
});

app.get('/api/sessions/active', (req, res) => {
  res.json(row("SELECT * FROM count_sessions WHERE status IN ('active', 'paused') ORDER BY id DESC LIMIT 1") || null);
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
  const actualMap = new Map(actualCountGroups(sessionId).map((item) => [itemGroupKey(item), item.actual_count]));
  const expected = activeExpectedInventory().map((item) => {
    const actual_count = actualMap.get(itemGroupKey(item)) || 0;
    return {
      ...item,
      tag_number: '',
      source: 'expected',
      expected_count: item.balance,
      actual_count,
      missing: Math.max(item.balance - actual_count, 0)
    };
  });
  const scanned = expected.filter((item) => item.actual_count > 0);
  const notScanned = expected.filter((item) => item.missing > 0);
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
  const expectedItems = activeExpectedInventory();
  const actualMap = new Map(actualCountGroups(session.id).map((item) => [itemGroupKey(item), item.actual_count]));
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(monthName);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.addRow(['Tag Count', 'Category Name', 'Item Number', 'Description', 'Balance', 'Actual Count', 'Missing']);
  sheet.getRow(1).eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
    cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
  });
  const groupedItems = Array.from(expectedItems.reduce((groups, item) => {
    const key = [item.category, item.item_number, item.description].join('\u001F');
    if (!groups.has(key)) {
      groups.set(key, {
        category: item.category,
        item_number: item.item_number,
        description: item.description,
        tags: [],
        balance: 0
      });
    }
    groups.get(key).balance += Number(item.balance || 0);
    return groups;
  }, new Map()).values()).map((item) => ({
    ...item,
    actual_count: actualMap.get(itemGroupKey(item)) || 0,
    missing: Math.max(item.balance - (actualMap.get(itemGroupKey(item)) || 0), 0)
  }));
  groupedItems
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
