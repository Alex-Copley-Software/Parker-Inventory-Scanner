let activeSession = null;
let scanner = null;
let lastScan = { tag: '', at: 0 };
const pendingKey = 'parker-pending-scans';

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
    return;
  }
  const label = new Date(activeSession.year, activeSession.month - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  $('#sessionLine').textContent = `${label} count is ${activeSession.status}.`;
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
    setResult(`${scan.description} confirmed.`, '');
    addHistory(tag, `${scan.category} confirmed`);
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
  updateOnlineStatus();
  await flushPending();
  $('#startCamera').addEventListener('click', () => startCamera().catch((error) => setResult(error.message, 'bad')));
  $('#stopCamera').addEventListener('click', () => stopCamera().catch(() => {}));
  $('#manualScanForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const tag = $('#manualTag').value.trim().toUpperCase();
    if (!tag) return;
    $('#manualTag').value = '';
    await handleScan(tag);
  });
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  setInterval(() => flushPending().catch(() => {}), 5000);
}

init().catch((error) => setResult(error.message, 'bad'));
