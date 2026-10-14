// Controlled clock and DOM checks; no claim of visual/browser verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

test('Закрепления, сигналы и автопоказ: формы, поиск, скрытая вкладка и область задач', async () => {
  const errors = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8'), { url: 'https://assistant.test/', pretendToBeVisual: true, virtualConsole });
  const w = dom.window, d = w.document, timers = [], listeners = [];
  const media = { matches: false, addEventListener(type, fn) { listeners.push(fn); } };
  w.matchMedia = () => media; w.scrollTo = () => {};
  w.Element.prototype.animate = () => {}; w.Element.prototype.scrollIntoView = () => {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.querySelector(':focus')?.blur(); this.open = false; };
  const RealDate = globalThis.Date, realInterval = globalThis.setInterval;
  let clock = RealDate.parse('2026-10-14T12:00:00+03:00');
  class ClockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  globalThis.Date = ClockDate;
  globalThis.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  Object.assign(globalThis, { window: w, document: d, location: w.location, history: w.history, localStorage: w.localStorage, FormData: w.FormData, requestAnimationFrame: fn => fn() });
  const click = selector => { const el = d.querySelector(selector); assert.ok(el, selector); el.click(); };
  const advance = ms => { clock += ms; timers.find(t => t.ms === 1000).fn(); };
  const saved = () => JSON.parse(w.localStorage.getItem('rut-assistant-demo-v02'));
  const change = element => element.dispatchEvent(new w.Event('change', { bubbles: true }));
  try {
    await import('../dist/app.js?attention-ui');
    click('[data-action="pin"][data-id="Л-201"]');
    assert.equal(d.querySelector('.pinned-grid [data-card-id]').dataset.cardId, 'Л-201');
    assert.deepEqual(saved().settings.pinnedTaskIds, ['Л-201']);
    click('[data-action="filter"][data-filter="attention"]');
    assert.equal(d.querySelector('.pinned-section'), null);
    click('[data-action="filter"][data-filter="all"]');
    assert.ok(d.querySelector('.pinned-grid [data-card-id="Л-201"]'));
    click('[data-action="acknowledge"][data-id="П-102"]');
    assert.equal(d.querySelector('[data-card-id="П-102"]').classList.contains('needs-attention'), false);
    assert.equal(saved().tasks.find(t => t.id === 'П-102').status, 'blocked');
    click('[data-action="pin"][data-id="П-104"]');
    click('[data-action="task"][data-id="П-104"]');
    click('[data-action="task-change"][data-change="accept"]');
    assert.ok(!saved().settings.pinnedTaskIds.includes('П-104'));

    click('[data-action="murmuration-settings"]');
    let events = d.querySelector('#presentation-events'); events.value = 'off'; change(events);
    click('#navigation [data-view="board"]');
    click('#murmuration-toggle'); advance(31000);
    assert.equal(w.location.hash, '#calendar');
    click('[data-action="task"][data-id="П-103"]');
    click('#modal [data-action="draft"]');
    d.querySelector('#draft-body').value += '\nНе потерять текст.';
    d.querySelector('#draft-body').dispatchEvent(new w.Event('input', { bubbles: true }));
    advance(300000);
    assert.equal(w.location.hash, '#calendar');
    assert.match(d.querySelector('#draft-body').value, /Не потерять текст/);
    assert.match(d.querySelector('#murmuration-status').textContent, /Пауза/);
    click('#modal [data-action="close"]'); advance(9000); advance(22000);
    assert.equal(w.location.hash, '#timeline', JSON.stringify({ status: d.querySelector('#murmuration-status').textContent, modal: d.querySelector('#modal').open, focus: d.activeElement.outerHTML.slice(0, 200), event: d.querySelector('#murmuration-event').textContent }));

    d.querySelector('#search').value = 'Сметы';
    d.querySelector('#search').dispatchEvent(new w.Event('input', { bubbles: true }));
    advance(90000); assert.equal(w.location.hash, '#timeline');
    d.querySelector('#search').value = '';
    d.querySelector('#search').dispatchEvent(new w.Event('input', { bubbles: true }));
    Object.defineProperty(d, 'visibilityState', { value: 'hidden', configurable: true });
    d.dispatchEvent(new w.Event('visibilitychange')); advance(120000);
    assert.equal(w.location.hash, '#timeline');
    Object.defineProperty(d, 'visibilityState', { value: 'visible', configurable: true });
    d.dispatchEvent(new w.Event('visibilitychange')); advance(9000); advance(22000);
    assert.equal(w.location.hash, '#board');

    click('#murmuration-toggle');
    click('[data-action="murmuration-settings"]');
    events = d.querySelector('#presentation-events'); events.value = 'important'; change(events);
    click('#navigation [data-view="calendar"]');
    const tasksBefore = JSON.stringify(saved().tasks);
    click('[data-action="murmuration-demo"]');
    assert.match(d.querySelector('#murmuration-event').textContent, /Пример/);
    assert.equal(JSON.stringify(saved().tasks), tasksBefore);
    click('#murmuration-toggle'); advance(1000);
    assert.equal(w.location.hash, '#timeline', 'событие открывает Гант заблокированной составной задачи');
    click('#murmuration-toggle');
    click('[data-action="scope"][data-scope="mine"]');
    assert.equal(d.querySelector('#murmuration-event').hidden, true);
    click('[data-action="murmuration-settings"]');
    click('[data-action="pulse"]');
    assert.equal(saved().settings.pulse, false);
    assert.ok(d.body.classList.contains('pulse-disabled'));
    const interval = d.querySelector('#presentation-interval'); interval.value = '15'; change(interval);
    assert.equal(saved().settings.presentation.interval, 15);
    media.matches = true; listeners.forEach(fn => fn());
    assert.ok(d.body.classList.contains('reduce-motion'));
    assert.deepEqual(errors, []);
  } finally { globalThis.Date = RealDate; globalThis.setInterval = realInterval; dom.window.close(); }
});
