const state = {
  categories: [],
  items: [],
  labelItems: [],
  editingId: null,
  activeSession: null,
  reviewSession: null,
  scans: []
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

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

function scannerUrl() {
  const url = new URL('/scanner.html', window.location.origin);
  const base = configuredApiBase();
  if (base) url.searchParams.set('api', base);
  return url.toString();
}

function updateScannerLink() {
  ['#openScanner', '#scannerNav'].forEach((selector) => {
    const link = $(selector);
    if (link) link.href = scannerUrl();
  });
}

async function api(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    headers: options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    ...options,
    body: options.body && !(options.body instanceof FormData) ? JSON.stringify(options.body) : options.body
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || response.statusText);
  }
  return response.json();
}

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `status ${kind}`;
  setTimeout(() => {
    el.textContent = '';
    el.className = 'status hidden';
  }, 3500);
}

function safeAsync(action) {
  action().catch((error) => toast(error.message, 'bad'));
}

function monthName(session) {
  if (!session) return '';
  return new Date(session.year, session.month - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

async function loadCategories() {
  state.categories = await api('/api/categories');
  const options = state.categories.map((c) => `<option value="${c.id}">${c.name}</option>`).join('') + '<option value="__new__">New category...</option>';
  $('#category').innerHTML = options;
  $('#filterCategory').innerHTML = '<option value="">All categories</option>' + state.categories.map((c) => `<option>${c.name}</option>`).join('');
  const labelCategory = $('#labelCategory');
  if (labelCategory) {
    labelCategory.innerHTML = '<option value="">All categories</option>' + state.categories.map((c) => `<option>${c.name}</option>`).join('');
  }
}

async function suggestTag() {
  const categoryId = $('#category').value;
  if (!categoryId || categoryId === '__new__' || state.editingId) return;
  const next = await api('/api/items/next-tag');
  $('#tag_number').value = next.tag_number;
}

async function loadItems() {
  const params = new URLSearchParams();
  if ($('#search').value) params.set('q', $('#search').value);
  if ($('#filterCategory').value) params.set('category', $('#filterCategory').value);
  state.items = await api(`/api/items?${params.toString()}`);
  renderItems();
}

function renderItems() {
  $('#itemsBody').innerHTML = state.items.map((item) => `
    <tr>
      <td><strong>${item.tag_number}</strong></td>
      <td>${item.category}</td>
      <td>${item.item_number}</td>
      <td>${item.description}</td>
      <td class="actions">
        <button class="secondary" onclick="editItem(${item.id})">Edit</button>
        <button class="secondary" onclick="printOne('${item.tag_number}')">QR</button>
        <button class="danger" onclick="retireItem(${item.id})">Retire</button>
      </td>
    </tr>
  `).join('');
}

function formPayload() {
  if ($('#category').value === '__new__') {
    throw new Error('Add the new category before saving the item.');
  }
  return {
    tag_number: $('#tag_number').value,
    category_id: Number($('#category').value),
    item_number: $('#item_number').value,
    description: $('#description').value
  };
}

function resetForm() {
  state.editingId = null;
  $('#itemForm').reset();
  $('#saveItem').textContent = 'Save & generate QR';
  suggestTag();
}

window.editItem = (id) => {
  const item = state.items.find((candidate) => candidate.id === id);
  const category = state.categories.find((candidate) => candidate.name === item.category);
  state.editingId = id;
  $('#tag_number').value = item.tag_number;
  $('#category').value = category.id;
  $('#item_number').value = item.item_number;
  $('#description').value = item.description;
  $('#saveItem').textContent = 'Update item';
};

window.retireItem = async (id) => {
  if (!confirm('Retire this item from future counts?')) return;
  await api(`/api/items/${id}`, { method: 'DELETE' });
  await loadItems();
};

window.printOne = async (tag) => {
  const allItems = await api('/api/labels');
  const item = allItems.find((candidate) => candidate.tag_number === tag);
  const singlePrintSheet = $('#singlePrintSheet');
  if (!item || !singlePrintSheet) return toast('QR label is not available yet. Refresh and try again.', 'bad');
  singlePrintSheet.innerHTML = labelHtml([item]);
  document.body.classList.add('printing-single');
  setTimeout(() => window.print(), 150);
};

function labelHtml(items) {
  return items.filter(Boolean).map((item) => `
    <div class="label">
      <img src="${apiUrl(`/api/qr/${encodeURIComponent(item.tag_number)}`)}" alt="">
      <div>
        <strong>${item.tag_number}</strong>
        <span>${item.item_number}</span>
        <span>${item.description}</span>
      </div>
    </div>
  `).join('');
}

async function renderLabels() {
  const labelCategory = $('#labelCategory');
  const labels = $('#labels');
  if (!labelCategory || !labels) return;
  const params = new URLSearchParams();
  if (labelCategory.value) params.set('category', labelCategory.value);
  state.labelItems = await api(`/api/labels?${params.toString()}`);
  labels.innerHTML = labelHtml(state.labelItems);
}

async function printAllLabels() {
  const labelCategory = $('#labelCategory');
  if (labelCategory) labelCategory.value = '';
  await renderLabels();
  showTab('labels');
  window.print();
}

function cleanupSinglePrint() {
  document.body.classList.remove('printing-single');
  const singlePrintSheet = $('#singlePrintSheet');
  if (singlePrintSheet) singlePrintSheet.innerHTML = '';
  safeAsync(renderLabels);
}

async function loadSession() {
  try {
    state.activeSession = await api('/api/sessions/active');
  } catch (error) {
    $('#sessionStatus').textContent = 'Backend unavailable';
    $('#sessionStatus').className = 'status bad';
    $('#connectionQr').textContent = error.message;
    throw error;
  }
  if (state.activeSession) state.reviewSession = state.activeSession;
  if (!state.activeSession && !state.reviewSession) {
    state.reviewSession = await api('/api/sessions/latest');
  }
  $('#sessionStatus').textContent = state.activeSession ? `${monthName(state.activeSession)} is ${state.activeSession.status}` : 'No active session';
  $('#sessionStatus').className = `status ${state.activeSession ? '' : 'warn'}`;
  $('#completeSession').disabled = !state.activeSession;
  $('#pauseSession').disabled = !state.activeSession;
  $('#resumeSession').disabled = !state.activeSession;
  $('#exportButton').disabled = !(state.reviewSession || state.activeSession);
  const connectionQr = apiUrl(`/api/connection-qr?target=${encodeURIComponent(scannerUrl())}`);
  $('#connectionQr').innerHTML = state.activeSession ? `<img src="${connectionQr}" alt="Scanner connection QR">` : 'Start a count session to show phone connection QR.';
  updateScannerLink();
  if (state.activeSession) {
    await loadScans();
  } else if (state.reviewSession) {
    await loadScans(state.reviewSession);
  } else {
    $('#scanSummary').textContent = 'Start a count session before scanning.';
    $('#scanFeed').innerHTML = '<p>No scans yet.</p>';
  }
}

async function loadScans(session = state.activeSession) {
  if (!session) return;
  state.scans = await api(`/api/sessions/${session.id}/scans`);
  const summarySuffix = session.status === 'complete' ? 'scanned in the latest completed session.' : 'scanned in this session.';
  $('#scanSummary').textContent = `${state.scans.length} item${state.scans.length === 1 ? '' : 's'} ${summarySuffix}`;
  $('#scanFeed').innerHTML = state.scans.map((scan) => `
    <div class="feed-item">
      <strong>${scan.tag_number} - ${scan.description || 'Unknown item'}</strong>
      <span>${scan.category || ''} at ${new Date(scan.scanned_at).toLocaleTimeString()}</span>
    </div>
  `).join('') || '<p>No scans yet.</p>';
}

async function startSession() {
  const date = new Date($('#sessionMonth').value + '-01T00:00:00');
  state.activeSession = await api('/api/sessions', {
    method: 'POST',
    body: { month: date.getMonth() + 1, year: date.getFullYear() }
  });
  state.reviewSession = state.activeSession;
  await loadSession();
  showTab('sessions');
}

async function setSessionStatus(status) {
  if (!state.activeSession) return;
  const updatedSession = await api(`/api/sessions/${state.activeSession.id}`, { method: 'PATCH', body: { status } });
  state.activeSession = updatedSession;
  state.reviewSession = updatedSession;
  await loadSession();
  if (status === 'complete') {
    await loadReview();
    showTab('review');
    toast('Session complete. Use Download Excel to open the count file.');
  }
}

async function reviewableSession() {
  if (state.reviewSession) return state.reviewSession;
  if (state.activeSession) return state.activeSession;
  state.reviewSession = await api('/api/sessions/latest');
  $('#exportButton').disabled = !state.reviewSession;
  return state.reviewSession;
}

async function loadReview() {
  const session = await reviewableSession();
  if (!session) {
    $('#scannedList').innerHTML = '<p>No count session found.</p>';
    $('#notScannedList').innerHTML = '<p>No count session found.</p>';
    $('#overrideList').innerHTML = '<p>No manual overrides.</p>';
    return;
  }
  const review = await api(`/api/sessions/${session.id}/review`);
  $('#scannedList').innerHTML = review.scanned.map(reviewCard).join('') || '<p>No scanned items.</p>';
  $('#notScannedList').innerHTML = review.notScanned.map((item) => reviewCard(item, true)).join('') || '<p>Everything was scanned.</p>';
  $('#overrideList').innerHTML = review.overrides.map((item) => `
    <div class="review-card"><strong>${item.tag_number}</strong><br>${item.status}: ${item.notes || ''}</div>
  `).join('') || '<p>No manual overrides.</p>';
}

function reviewCard(item, missing = false) {
  return `
    <div class="review-card ${missing ? 'missing' : ''}">
      <strong>${item.tag_number} - ${item.description}</strong>
      <div>${item.category} | ${item.item_number}</div>
      ${missing ? `
        <select id="override-status-${item.id}">
          <option value="missing">Confirmed missing</option>
          <option value="found">Found - tag damaged</option>
          <option value="deferred">Deferred</option>
        </select>
        <textarea id="override-notes-${item.id}" rows="2" placeholder="Notes"></textarea>
        <button onclick="saveOverride(${item.id})">Save</button>
      ` : '<span class="status">Confirmed present</span>'}
    </div>
  `;
}

window.saveOverride = async (itemId) => {
  const session = await reviewableSession();
  if (!session) return toast('No count session found.', 'bad');
  await api(`/api/sessions/${session.id}/overrides`, {
    method: 'POST',
    body: {
      item_id: itemId,
      status: $(`#override-status-${itemId}`).value,
      notes: $(`#override-notes-${itemId}`).value
    }
  });
  await loadReview();
};

function showTab(id) {
  $$('.tab-page').forEach((page) => page.classList.toggle('hidden', page.id !== id));
  $$('.tabs button').forEach((button) => button.classList.toggle('active', button.dataset.tab === id));
  if (id === 'labels') safeAsync(renderLabels);
  if (id === 'review') safeAsync(loadReview);
  if (id === 'sessions') safeAsync(loadSession);
}

function connectSocket() {
  const base = configuredApiBase() || window.location.origin;
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url.toString());
  socket.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'scan:created' && state.activeSession) await loadScans();
    if (message.type === 'items:changed') await loadItems();
    if (message.type === 'sessions:changed') await loadSession();
    if (message.type === 'review:changed') await loadReview();
  };
  socket.onerror = () => {};
  socket.onclose = () => setTimeout(connectSocket, 3000);
}

function bindUi() {
  $('#apiBaseUrl').value = configuredApiBase();
  $('#sessionMonth').value = new Date().toISOString().slice(0, 7);
  $$('.tabs button').forEach((button) => button.addEventListener('click', () => showTab(button.dataset.tab)));
  updateScannerLink();
  $('#category').addEventListener('change', () => safeAsync(suggestTag));
  $('#saveApiBase').addEventListener('click', async () => {
    localStorage.setItem('parker-api-base', $('#apiBaseUrl').value.trim().replace(/\/$/, ''));
    updateScannerLink();
    toast('Backend URL saved.');
    safeAsync(async () => {
      await loadCategories();
      await loadItems();
      await loadSession();
    });
  });
  $('#category').addEventListener('change', () => {
    $('#newCategoryRow').classList.toggle('hidden', $('#category').value !== '__new__');
  });
  $('#addCategory').addEventListener('click', async () => {
    const name = $('#newCategoryName').value.trim();
    if (!name) return toast('Enter a category name first.', 'warn');
    const category = await api('/api/categories', { method: 'POST', body: { name } });
    await loadCategories();
    $('#category').value = category.id;
    $('#newCategoryName').value = '';
    $('#newCategoryRow').classList.add('hidden');
    await suggestTag();
    toast('Category added.');
  });
  $('#itemForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const method = state.editingId ? 'PUT' : 'POST';
      const path = state.editingId ? `/api/items/${state.editingId}` : '/api/items';
      await api(path, { method, body: formPayload() });
      toast(state.editingId ? 'Item updated.' : 'Item saved. QR is ready to print.');
      resetForm();
      await loadItems();
    } catch (error) {
      toast(error.message, 'bad');
    }
  });
  $('#cancelEdit').addEventListener('click', resetForm);
  $('#search').addEventListener('input', () => safeAsync(loadItems));
  $('#filterCategory').addEventListener('change', () => safeAsync(loadItems));
  $('#labelCategory').addEventListener('change', () => safeAsync(renderLabels));
  $('#refreshLabels').addEventListener('click', () => safeAsync(renderLabels));
  $('#printAllLabelsNav').addEventListener('click', () => safeAsync(printAllLabels));
  $('#printAllLabelsTop').addEventListener('click', () => safeAsync(printAllLabels));
  $('#printAllLabelsBottom').addEventListener('click', () => safeAsync(printAllLabels));
  window.addEventListener('afterprint', cleanupSinglePrint);
  $('#importForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData();
    form.append('file', $('#csvFile').files[0]);
    const result = await api('/api/items/import', { method: 'POST', body: form });
    toast(`Imported ${result.imported} items${result.skipped ? `, skipped ${result.skipped}` : ''}.`);
    await loadItems();
  });
  $('#startSession').addEventListener('click', () => safeAsync(startSession));
  $('#pauseSession').addEventListener('click', () => safeAsync(() => setSessionStatus('paused')));
  $('#resumeSession').addEventListener('click', () => safeAsync(() => setSessionStatus('active')));
  $('#completeSession').addEventListener('click', () => safeAsync(() => setSessionStatus('complete')));
  $('#refreshReview').addEventListener('click', () => safeAsync(loadReview));
  $('#exportButton').addEventListener('click', () => {
    const session = state.reviewSession || state.activeSession;
    if (session) location.href = apiUrl(`/api/sessions/${session.id}/export`);
  });
}

async function init() {
  bindUi();
  await loadCategories();
  await suggestTag();
  await loadItems();
  await loadSession();
  connectSocket();
  setInterval(() => safeAsync(async () => {
    await loadSession();
    if (state.activeSession) await loadScans();
  }), 5000);
}

init().catch((error) => toast(error.message, 'bad'));
