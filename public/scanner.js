let activeSession = null;
let scanner = null;
let lastScan = { tag: '', at: 0 };
const pendingKey = 'parker-pending-scans';
let categories = [];
let pendingScan = null;
let audioContext = null;

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
  let response;
  try {
    response = await fetch(apiUrl(path), {
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  } catch (error) {
    const networkError = new Error('Cannot reach backend right now.');
    networkError.isNetworkError = true;
    throw networkError;
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    const apiError = new Error(error.error || response.statusText);
    apiError.status = response.status;
    throw apiError;
  }
  return response.json();
}

async function postScan(tag) {
  return api('/api/scans', { method: 'POST', body: { session_id: activeSession.id, tag_number: tag } });
}

function shouldQueueScanError(error) {
  return error.isNetworkError;
}

function showScanSuccess(tag, result) {
  if (result.duplicate) {
    setResult(`${tag} was already counted.`, 'warn');
    addHistory(tag, 'Already counted');
  } else {
    const scan = result.scan;
    setResult(`${scan.description} synced to the active count.`, '');
    addHistory(tag, `${scan.category} synced`);
    loadInventoryReview().catch(() => {});
  }
}

function playSuccessSound() {
  try {
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
    oscillator.frequency.setValueAtTime(1175, audioContext.currentTime + 0.08);
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.28, audioContext.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.18);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.2);
  } catch (error) {
    // Audio can be blocked by browser settings; scanning should continue silently.
  }
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

function inventoryKey(item) {
  return [item.category || '', item.item_number || '', item.description || ''].join('\u001F');
}

function setScannerPanel(panel) {
  const showingInventory = panel === 'inventory';
  $('#scannerLogPanel').classList.toggle('hidden', showingInventory);
  $('#scannerInventoryPanel').classList.toggle('hidden', !showingInventory);
  $('#showLogTab').classList.toggle('active', !showingInventory);
  $('#showInventoryTab').classList.toggle('active', showingInventory);
  if (showingInventory) loadInventoryReview().catch((error) => setResult(error.message, 'bad'));
}

async function loadInventoryReview() {
  if (!activeSession) await loadSession();
  if (!activeSession) {
    $('#mobileInventory').innerHTML = '<p>No active count session.</p>';
    return;
  }
  const review = await api(`/api/sessions/${activeSession.id}/review`);
  const inventoryRows = new Map();
  [...review.scanned, ...review.notScanned].forEach((item) => {
    const key = inventoryKey(item);
    const existing = inventoryRows.get(key);
    if (!existing || Number(item.actual_count || 0) > Number(existing.actual_count || 0)) inventoryRows.set(key, item);
  });
  const sorted = Array.from(inventoryRows.values()).sort((a, b) => {
    const missingDelta = Number(b.missing || 0) - Number(a.missing || 0);
    if (missingDelta) return missingDelta;
    return String(a.description || '').localeCompare(String(b.description || ''));
  });
  $('#mobileInventory').innerHTML = sorted.map((item) => {
    const missing = Number(item.missing || 0);
    const balance = item.balance ?? item.expected_count ?? 0;
    return `
      <div class="mobile-inventory-item ${missing > 0 ? 'missing' : ''}">
        <strong>${item.description || 'No description'}</strong>
        <span>${item.category || ''} | ${item.item_number || ''}</span>
        <span>Actual ${item.actual_count || 0} / Balance ${balance}</span>
        <em>${missing > 0 ? `${missing} missing` : 'Complete'}</em>
      </div>
    `;
  }).join('') || '<p>No imported inventory found.</p>';
}

async function lookupTag(tag) {
  return api(`/api/items/by-tag/${encodeURIComponent(tag)}`);
}

function showConfirmScan(item) {
  pendingScan = item;
  playSuccessSound();
  $('#scanConfirmTitle').textContent = item.tag_number;
  $('#scanConfirmDetails').innerHTML = `
    <strong>${item.description || 'No description'}</strong>
    <span>${item.category || ''}</span>
    <span>Item Number: ${item.item_number || ''}</span>
  `;
  $('#scanConfirm').classList.remove('hidden');
}

function closeConfirmScan() {
  pendingScan = null;
  $('#scanConfirm').classList.add('hidden');
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
  try {
    const result = await api('/api/scans/batch', { method: 'POST', body: { session_id: activeSession.id, tags } });
    const retryTags = [];
    let synced = 0;
    result.results.forEach((item) => {
      if (item.error) {
        addHistory(item.tag, item.error);
      } else {
        synced += 1;
      }
    });
    savePending(retryTags);
    addHistory('Queued scans', `${synced} synced, ${result.results.length - synced} rejected`);
    loadInventoryReview().catch(() => {});
  } catch (error) {
    if (shouldQueueScanError(error)) setResult('Backend still unreachable. Queued scans will retry automatically.', 'warn');
    else setResult(error.message, 'bad');
  }
}

async function submitScan(tag) {
  if (!activeSession) await loadSession();
  if (!activeSession) throw new Error('No active count session.');
  showScanSuccess(tag, await postScan(tag));
}

async function confirmScannedTag(tag) {
  if (!activeSession) await loadSession();
  if (!activeSession) throw new Error('No active count session.');
  showConfirmScan(await lookupTag(tag));
}

async function handleScan(rawText) {
  const tag = String(rawText || '').trim();
  const now = Date.now();
  if (!tag || pendingScan || (tag === lastScan.tag && now - lastScan.at < 2200)) return;
  lastScan = { tag, at: now };
  try {
    await confirmScannedTag(tag);
  } catch (error) {
    if (shouldQueueScanError(error)) {
      const queue = pending();
      queue.push(tag);
      savePending(queue);
      setResult(`${tag} queued because the backend could not be reached.`, 'warn');
    } else {
      setResult(error.message, 'bad');
    }
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
  $('#showLogTab').addEventListener('click', () => setScannerPanel('log'));
  $('#showInventoryTab').addEventListener('click', () => setScannerPanel('inventory'));
  $('#confirmScan').addEventListener('click', async () => {
    if (!pendingScan) return;
    const tag = pendingScan.tag_number;
    closeConfirmScan();
    await submitScan(tag).catch((error) => {
      setResult(error.message, shouldQueueScanError(error) ? 'warn' : 'bad');
      addHistory(tag, error.message);
    });
  });
  $('#cancelScan').addEventListener('click', () => {
    const tag = pendingScan?.tag_number || 'Scan';
    closeConfirmScan();
    setResult(`${tag} ignored.`, 'warn');
  });
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
    const item = await api('/api/pending-items', {
      method: 'POST',
      body: {
        tag_number: $('#newItemTag').value.trim().toUpperCase(),
        category_id: $('#newItemCategory').value,
        item_number: $('#newItemNumber').value.trim(),
        description: $('#newItemDescription').value.trim()
      }
    });
    setResult(`${item.tag_number} saved to PC pending list.`, '');
    addHistory(item.tag_number, 'Pending new item saved to PC');
    $('#newItemNumber').value = '';
    $('#newItemDescription').value = '';
    await loadNextItemTag();
  });
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  setInterval(() => {
    flushPending().catch(() => {});
    if (!$('#scannerInventoryPanel').classList.contains('hidden')) loadInventoryReview().catch(() => {});
  }, 5000);
}

init().catch((error) => setResult(error.message, 'bad'));
