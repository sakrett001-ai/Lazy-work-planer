import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import './helpers/server-runtime.mjs';

// Actual UI modules and authenticated handlers, joined in memory instead of HTTP.
// JSDOM supplies DOM semantics, not rendering. Only fictional data enter temp SQLite.
const directory = mkdtempSync(join(tmpdir(), 'planner-ui-journey-'));
const origin = 'https://journey.test';
process.env.ASSISTANT_DATA_DIR = directory;
process.env.ASSISTANT_SERVER_ORIGIN = origin;
process.env.ASSISTANT_DELIVERY_ENABLED = 'false';
const store = await import('../agent/lib/store.ts');
const { issueInvite } = await import('../agent/lib/web-auth.ts');
const { handleDashboardRequest } = await import('../agent/lib/dashboard-api.ts');
const html = readFileSync(new URL('../dist/pilot.html', import.meta.url), 'utf8');
const extension = readFileSync(new URL('../dist/prototype-ui.js', import.meta.url), 'utf8');
const pulseSignal = readFileSync(new URL('../dist/pulse-signal.js', import.meta.url), 'utf8');
const pulseMotion = readFileSync(new URL('../dist/pulse-motion.js', import.meta.url), 'utf8');
const entry = readFileSync(new URL('../dist/pilot.js', import.meta.url), 'utf8');

async function wait(check, label) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(check(), label);
}
function tab() {
  const errors = [], requests = [], vc = new VirtualConsole();
  vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, { url: `${origin}/assistant/workspace`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window, d = w.document;
  let cookie = '', loseReportResponse = false;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  // Poll scheduling is disabled, not application logic; refresh is exercised by its button.
  w.setInterval = () => 0;
  w.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, origin, 'No external network is allowed');
    assert.ok(url.pathname.startsWith('/assistant/api/'));
    const headers = new Headers(options.headers);
    if (cookie) headers.set('cookie', cookie);
    if (options.method === 'POST') headers.set('origin', origin);
    const request = new Request(url, { ...options, headers });
    requests.push({ path: url.pathname.split('/').at(-1), body: options.body ? JSON.parse(options.body) : undefined });
    const response = await handleDashboardRequest(request, { assistantAvailable: false });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    // Simulate lost acknowledgement AFTER the real transaction has committed.
    if (loseReportResponse && url.pathname.endsWith('/report-create') && response.ok) {
      loseReportResponse = false;
      throw Error('Lost response');
    }
    return response;
  };
  // Only the ESM import/export boundary is replaced; source bodies run unchanged
  // in their own window realm. No production result, state, or handler is mocked.
  w.eval(`window.installPrototype = (() => { ${[pulseSignal,pulseMotion,extension].map(source=>source.replace(/^import .*;$/gm,'').replace(/export /g,'')).join('\n')}\nreturn installPrototype; })();`);
  w.eval(entry.replace("import { installPrototype } from './prototype-ui.js';", 'const installPrototype = window.installPrototype;'));
  const $ = selector => d.querySelector(selector);
  const click = selector => { assert.ok($(selector), selector); assert.equal($(selector).disabled, false, selector); $(selector).click(); };
  const submit = selector => $(selector).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  return { dom, w, $, click, submit, errors, requests, cookie: () => cookie, loseNextReport: () => { loseReportResponse = true; } };
}
async function login(t, employeeId) {
  await wait(() => !t.$('#login-panel').hidden, 'Initial session check');
  t.$('#login-code').value = issueInvite(employeeId);
  t.submit('#login-form');
  await wait(() => !t.$('#workspace').hidden && !t.$('#new-task').disabled, 'Authenticated workspace');
}
async function openTask(t, id) {
  if (t.$('#task-dialog').open) t.click('#close-dialog');
  t.click(`[data-task="${id}"]`);
  await wait(() => t.$('#task-title') && !t.$('#task-title').textContent.includes('Загружаем') && !t.$('#close-dialog').disabled, 'Task memory loaded');
}
async function create(t, title, employeeId, due) {
  const form = t.$('#task-editor');
  form.elements.title.value = title;
  form.elements.employeeId.value = employeeId;
  form.elements.due.value = due;
  form.elements.dueTime.value = '16:30';
  t.submit('#task-editor');
  await wait(() => !t.$('#editor-dialog').open && !t.$('#new-task').disabled, 'Task saved');
  const task = store.readState().tasks.find(task => task.title === title);
  assert.ok(task);
  return task.id;
}

test('Real DOM → authenticated SQLite journey: delegate, request, reply, selected immutable report and committed-response retry', async () => {
  let manager, employee;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error('External fetch forbidden in journey'); };
  try {
    store.updateState(() => ({ employees: [
      { id: 'manager', name: 'Руководитель · пример', role: 'manager' },
      { id: 'employee', name: 'Исполнитель · пример', role: 'employee' },
    ], tasks: [], sources: [], events: [], settings: { timezone: 'Europe/Moscow', startHour: 9, endHour: 18, minHoursBetween: 6, excludedDates: [] } }));
    manager = tab(); employee = tab();
    await login(manager, 'manager'); await login(employee, 'employee');
    assert.ok(manager.cookie()); assert.ok(employee.cookie()); assert.notEqual(manager.cookie(), employee.cookie(), 'Independent real sessions');
    assert.equal(employee.$('#reports').hidden, true);
    manager.click('#new-task');
    const parentId = await create(manager, 'Подготовить сводный ответ', 'manager', '2099-11-10');
    await openTask(manager, parentId); manager.click('[data-new-child]');
    const childId = await create(manager, 'Получить исходные данные', 'employee', '2099-11-05');
    assert.equal(store.readState().tasks.find(t => t.id === childId).parentId, parentId);
    await openTask(manager, childId);
    manager.$('#manager-message').value = 'Сообщи результат и препятствия.';
    manager.$('#message-form').elements.requestUpdate.checked = true;
    manager.submit('#message-form');
    await wait(() => manager.$('#detail-message')?.textContent === 'Сохранено.', 'Status request persisted');
    employee.click('#refresh');
    await wait(() => employee.$(`[data-task="${childId}"]`), 'Employee sees delegated card');
    assert.equal(employee.$(`[data-task="${parentId}"]`), null, 'Parent is not exposed to child assignee');
    await openTask(employee, childId);
    assert.match(employee.$('#task-content').textContent, /Сообщи результат и препятствия/);
    const reply = 'Не могу продолжить: нет исходных данных, нужна помощь. <img src=x onerror=window.injected=true>';
    employee.$('#report-text').value = reply; employee.submit('#report-form');
    await wait(() => store.readState().tasks.find(t => t.id === childId).status === 'blocked' && !employee.$('#close-dialog').disabled, 'Employee reply updates real card');
    const child = store.readState().tasks.find(t => t.id === childId);
    assert.equal(child.due, '2099-11-05'); assert.equal(child.originalDue, '2099-11-05');
    assert.ok(store.readState().sources.some(s => s.taskId === childId && s.text === reply));
    assert.equal(employee.$('#task-content img'), null, 'Employee source is escaped');
    assert.equal(employee.w.injected, undefined);
    manager.click('#close-dialog'); manager.click('#refresh');
    await wait(() => manager.$(`[data-task="${childId}"]`)?.textContent.includes('Есть препятствие'), 'Manager sees fresh blocked card');
    await openTask(manager, parentId);
    assert.match(manager.$('.delegation').textContent, /Есть препятствие/);
    assert.match(manager.$('.delegation').textContent, /нет исходных данных/i);
    manager.click('#close-dialog'); manager.click('#reports');
    await wait(() => manager.$('#snapshot-report-form'), 'Report selector');
    assert.equal(manager.$('#include-report-children').checked, true);
    const parentBox = manager.$(`input[name=taskIds][value="${parentId}"]`);
    parentBox.checked = true; parentBox.dispatchEvent(new manager.w.Event('change', { bubbles: true }));
    assert.equal(manager.$(`input[name=taskIds][value="${childId}"]`).checked, true);
    manager.loseNextReport(); manager.submit('#snapshot-report-form');
    await wait(() => manager.$('#editor-message').textContent.includes('Подтверждение не получено'), 'Committed response lost');
    manager.submit('#snapshot-report-form');
    await wait(() => manager.$('#snapshot-report-text'), 'Same-ID retry returns saved report');
    const writes = manager.requests.filter(r => r.path === 'report-create');
    assert.equal(writes.length, 2); assert.equal(writes[0].body.requestId, writes[1].body.requestId);
    assert.deepEqual(new Set(writes[0].body.selection.map(s => s.taskId)), new Set([parentId, childId]));
    const reportText = manager.$('#snapshot-report-text').textContent;
    assert.match(reportText, /Снимок на .*UTC/); assert.match(reportText, /Выбрано: 2/);
    assert.match(reportText, /Есть препятствие/); assert.ok(reportText.includes(reply)); assert.match(reportText, /1\/1/);
    manager.click('#close-editor'); await openTask(manager, childId); manager.click('[data-edit-task]');
    manager.$('#task-editor').elements.title.value = 'Новое название после отчёта';
    manager.$('#task-editor').elements.due.value = '2099-12-01'; manager.submit('#task-editor');
    await wait(() => !manager.$('#editor-dialog').open && !manager.$('#close-dialog').disabled, 'Later card edit');
    assert.equal(store.readState().tasks.find(t => t.id === childId).due, '2099-12-01');
    manager.click('#close-dialog'); manager.click('#reports');
    await wait(() => manager.$('[data-saved-report]'), 'Saved reports reopen');
    assert.equal(manager.dom.window.document.querySelectorAll('[data-saved-report]').length, 1, 'Lost response did not duplicate report');
    manager.click('[data-saved-report]');
    await wait(() => manager.$('#snapshot-report-text'), 'Stored immutable snapshot');
    assert.equal(manager.$('#snapshot-report-text').textContent, reportText);
    assert.equal(manager.$('#snapshot-report-text img'), null, 'Hostile source remains literal report text');
    assert.equal(manager.w.injected, undefined);
    let downloadedBlob, downloadName, downloadClicks = 0;
    manager.w.URL.createObjectURL = blob => { downloadedBlob = blob; return 'blob:journey-report'; };
    manager.w.URL.revokeObjectURL = () => {};
    // Suppress only browser navigation; the real button constructs the actual Blob.
    manager.w.HTMLAnchorElement.prototype.click = function () { downloadName = this.download; downloadClicks++; };
    manager.click('#download-report');
    assert.equal(downloadClicks, 1);
    assert.ok(downloadedBlob instanceof manager.w.Blob);
    assert.equal(downloadedBlob.type, 'text/plain;charset=utf-8');
    assert.match(downloadName, /^report-.+\.txt$/);
    const downloadedText = await new Promise((resolve, reject) => {
      const reader = new manager.w.FileReader();
      reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
      reader.readAsText(downloadedBlob);
    });
    assert.equal(downloadedText, reportText, 'Download contains the same immutable snapshot, not current card data');
    assert.deepEqual(manager.errors, []); assert.deepEqual(employee.errors, []);
  } finally {
    manager?.dom.window.close(); employee?.dom.window.close(); globalThis.fetch = previousFetch;
    store.database().close(); rmSync(directory, { recursive: true, force: true });
  }
});
