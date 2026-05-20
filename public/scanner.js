let activeSession = null;
let scanner = null;
let lastScan = { tag: '', at: 0 };
const pendingKey = 'parker-pending-scans';
let categories = [];

const $ = (selector) => document.querySelector(selector);

function configuredApiBase() {
  const params = new URLSearchParams(window.location.search);
  const queryApi = params.get('api');
  if (queryApi) {
    localStorage.setItem('parker-api-base', queryApi.replace(/\/$/, ''));
  }
  return (localStorage.getItem('parker-api-base') || window.PARKER_API_BASE || '').replace(/\/$/, '');
}

function apiUrl(path) {
  return `${configuredApiBase()}${path}`;
}

async function api(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || response.statusText);
  }
  return response.json();
}

function setResult(message, kind = '') {
  $('#result').textContent = message;
  $('#result').className = `result ${kind}`;
}

function pending() {
  return JSON.parse(localStorage.getItem(pendingKey) || '[]');
}

function savePending(tags) {
  localStorage.setItem(pendingKey, JSON.stringify(tags));
}

function addHistory(tag, message) {
  const row = document.createElement('div');
  row.className = 'feed-item';
  row.innerHTML = `<strong>${tag}</strong><span>${message}</span>`;
  $('#history').prepend(row);
}

function labelHtml(item) {
  return `
    <div class="label">
      <img src="${apiUrl(`/api/qr/${encodeURIComponent(item.tag_number)}`)}" alt="">
      <div>
        <strong>${item.tag_number}</strong>
        <span>${item.item_number || ''}</span>
        <span>${item.description || ''}</span>
      </div>
    </div>
  `;
}

function cleanupSinglePrint() {
  document.body.classList.remove('printing-single');
  $('#singlePrintSheet').innerHTML = '';
}

function printItemLabel(item) {
  const blanks = Array.from({ length: 29 }, () => '<div class="label"></div>').join('');
  $('#singlePrintSheet').innerHTML = `${labelHtml(item)}${blanks}`;
  document.body.classList.add('printing-single');
  setTimeout(() => window.print(), 150);
}

async function loadCategories() {
  categories = await api('/api/categories');
  const select = $('#newItemCategory');
  select.innerHTML = categories.map((category) => `<option value="${category.id}">${category.name}</option>`).join('');
}

async function loadNextItemTag() {
  const next = await api('/api/items/next-tag');
  $('#newItemTag').value = next.tag_number;
}

async function loadSession() {
  try {
    activeSession = await api('/api/sessions/active');
  } catch (error) {
    setResult(`Backend connection failed: ${error.message}`, 'bad');
    $('#sessionLine').textContent = 'Cannot reach backend.';
    return;
  }
  if (!activeSession) {
    $('#sessionLine').textContent = 'No active session. Start one on the PC.';
    $('#startPhoneSession').disabled = false;
    return;
  }
  const label = new Date(activeSession.year, activeSession.month - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  $('#sessionLine').textContent = `Syncing to ${label} count (${activeSession.status}).`;
  $('#startPhoneSession').disabled = true;
}

async function flushPending() {
  if (!activeSession || !navigator.onLine) return;
  const tags = pending();
  if (!tags.length) return;
  const result = await api('/api/scans/batch', { method: 'POST', body: { session_id: activeSession.id, tags } });
  savePending([]);
  addHistory('Queued scans', `${result.results.length} synced`);
}

async function submitScan(tag) {
  if (!activeSession) await loadSession();
  if (!activeSession) throw new Error('No active count session.');
  const result = await api('/api/scans', { method: 'POST', body: { session_id: activeSession.id, tag_number: tag } });
  if (result.duplicate) {
    setResult(`${tag} was already counted.`, 'warn');
    addHistory(tag, 'Already counted');
  } else {
    const scan = result.scan;
    setResult(`${scan.description} synced to the active count.`, '');
    addHistory(tag, `${scan.category} synced`);
  }
}

async function handleScan(rawText) {
  const tag = String(rawText || '').trim();
  const now = Date.now();
  if (!tag || (tag === lastScan.tag && now - lastScan.at < 2200)) return;
  lastScan = { tag, at: now };
  try {
    await submitScan(tag);
  } catch (error) {
    const queue = pending();
    queue.push(tag);
    savePending(queue);
    setResult(`${tag} queued until Wi-Fi reconnects.`, 'warn');
    addHistory(tag, error.message);
  }
}

async function startCamera() {
  if (!window.Html5Qrcode) {
    setResult('Scanner library is not available. Reconnect to Wi-Fi and reload this page.', 'bad');
    return;
  }
  if (!scanner) scanner = new Html5Qrcode('reader');
  await scanner.start(
    { facingMode: 'environment' },
    { fps: 8, qrbox: { width: 240, height: 240 } },
    handleScan
  );
}

async function stopCamera() {
  if (scanner?.isScanning) await scanner.stop();
}

function updateOnlineStatus() {
  $('#netStatus').textContent = navigator.onLine ? 'Online' : 'Offline';
  $('#netStatus').className = `status ${navigator.onLine ? '' : 'warn'}`;
  if (navigator.onLine) flushPending().catch(() => {});
}

async function init() {
  await loadSession();
  await loadCategories();
  await loadNextItemTag();
  updateOnlineStatus();
  await flushPending();
  $('#startCamera').addEventListener('click', () => startCamera().catch((error) => setResult(error.message, 'bad')));
  $('#stopCamera').addEventListener('click', () => stopCamera().catch(() => {}));
  $('#startPhoneSession').addEventListener('click', async () => {
    const now = new Date();
    activeSession = await api('/api/sessions', {
      method: 'POST',
      body: { month: now.getMonth() + 1, year: now.getFullYear() }
    });
    await loadSession();
    setResult('Count session started. Scans will sync here and to the admin live feed.', '');
  });
  $('#manualScanForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const tag = $('#manualTag').value.trim().toUpperCase();
    if (!tag) return;
    $('#manualTag').value = '';
    await handleScan(tag);
  });
  $('#toggleNewItem').addEventListener('click', async () => {
    $('#newItemForm').classList.toggle('hidden');
    if (!$('#newItemForm').classList.contains('hidden') && !$('#newItemTag').value) await loadNextItemTag();
  });
  $('#refreshNewTag').addEventListener('click', () => loadNextItemTag().catch((error) => setResult(error.message, 'bad')));
  $('#newItemForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const item = await api('/api/items', {
      method: 'POST',
      body: {
        tag_number: $('#newItemTag').value.trim().toUpperCase(),
        category_id: $('#newItemCategory').value,
        item_number: $('#newItemNumber').value.trim(),
        description: $('#newItemDescription').value.trim()
      }
    });
    setResult(`${item.tag_number} added to the registry.`, '');
    addHistory(item.tag_number, 'New item added');
    if ($('#printNewItem').checked) printItemLabel(item);
    $('#newItemNumber').value = '';
    $('#newItemDescription').value = '';
    await loadNextItemTag();
  });
  window.addEventListener('afterprint', cleanupSinglePrint);
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  setInterval(() => flushPending().catch(() => {}), 5000);
}

init().catch((error) => setResult(error.message, 'bad'));
