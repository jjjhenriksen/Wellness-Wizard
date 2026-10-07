import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../public/script.js', import.meta.url), 'utf8');
function fixture(reducedMotion = false) {
  let click;
  const timers = new Map(), requests = [];
  const response = { textContent: '', attributes: {}, classList: { add() {}, remove() {} }, setAttribute(key, value) { this.attributes[key] = value; }, set innerText(value) { this.textContent = value; } };
  const input = { value: 'First' };
  const button = { addEventListener(_type, listener) { click = listener; } };
  const context = vm.createContext({ document: { getElementById: id => ({ sendButton: button, responseArea: response, userInput: input })[id] }, window: { matchMedia: () => ({ matches: reducedMotion }) }, AbortController, setTimeout: callback => { const id = Symbol(); timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id), fetch: (_url, options) => new Promise((resolve, reject) => requests.push({ options, resolve: (reply, ok = true) => resolve({ ok, json: async () => reply }), reject })) });
  vm.runInContext(source, context);
  const tick = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); };
  return { click: () => click(), response, input, requests, timers, tick };
}

test('reversed replies cannot overwrite the latest send even if abort is ignored', async () => {
  const f = fixture(true), old = f.click();
  f.input.value = 'Second'; const latest = f.click();
  assert.equal(f.requests[0].options.signal.aborted, true);
  f.requests[1].resolve({ reply: 'Newest' }); await latest;
  f.requests[0].resolve({ reply: 'Obsolete' }); await old;
  assert.equal(f.response.textContent, 'Newest'); assert.equal(f.response.attributes['aria-busy'], 'false');
});

test('a new send cancels an existing typing chain and stale callbacks do nothing', async () => {
  const f = fixture(), first = f.click(); f.requests[0].resolve({ reply: 'Old answer' }); await first;
  assert.equal(f.timers.size, 1); const stale = [...f.timers.values()][0];
  f.input.value = 'Second'; const second = f.click(); assert.equal(f.timers.size, 0);
  stale(); assert.equal(f.response.textContent, 'The Wizard is thinking...');
  f.requests[1].resolve({ reply: 'New' }); await second;
  while (f.timers.size) f.tick();
  assert.equal(f.response.textContent, 'New'); assert.equal(f.response.attributes['aria-busy'], 'false');
});

test('provider timeout and quota messages remain visible and end busy state', async () => {
  const f = fixture(), send = f.click();
  f.requests[0].resolve({ code: 'PROVIDER_TIMEOUT', message: 'Please try again.' }, false); await send;
  assert.equal(f.response.textContent, 'Please try again.'); assert.equal(f.response.attributes['aria-busy'], 'false');
});
