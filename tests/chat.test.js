import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import axios from 'axios';
import { createHandler, PROVIDER_TIMEOUT_MS } from '../api/chat.js';
import { callerIdentity, createRateLimiter, CHAT_LIMITS } from '../lib/chat-rate-limit.js';

const env = { OPENAI_API_KEY: 'mock-key' };
function response() {
  return { headers: {}, statusCode: 200, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
const request = (body = { message: 'Hello' }, ip = '127.0.0.1') => ({ method: 'POST', body, headers: {}, socket: { remoteAddress: ip } });
const allowed = async () => ({ allowed: true });
const reply = { data: { choices: [{ message: { content: 'Mock reply' } }] } };

test('invalid bodies and methods are rejected without quota or provider calls', async () => {
  let calls = 0;
  const handler = createHandler({ env, limit: async () => { calls++; }, provider: { post() { calls++; } } });
  for (const body of [undefined, null, [], 'text', {}, { message: null }, { message: 4 }, { message: '' }, { message: '  ' }, { message: 'a'.repeat(4001) }]) {
    const res = response(); await handler({ ...request(), body }, res);
    assert.equal(res.statusCode, 400); assert.equal(res.body.code, 'INVALID_REQUEST');
  }
  const res = response(); await handler({ ...request(), method: 'GET' }, res);
  assert.equal(res.statusCode, 405); assert.equal(res.headers.Allow, 'POST'); assert.equal(calls, 0);
});

test('valid message is trimmed and sent with an explicit bounded timeout', async () => {
  const handler = createHandler({ env, limit: allowed, provider: { async post(url, body, options) {
    assert.match(url, /^https:/); assert.equal(body.messages[1].content, 'Hello');
    assert.equal(options.timeout, PROVIDER_TIMEOUT_MS); assert.ok(options.timeout > 0 && options.timeout <= 15000);
    assert.equal(options.headers.Authorization, 'Bearer mock-key'); return reply;
  } } });
  const res = response(); await handler(request({ message: ' Hello ' }), res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.reply, 'Mock reply');
});

test('stalled local provider times out through real axios without a paid request', { timeout: 22000 }, async (t) => {
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const provider = { post(_url, body, options) { return axios.post(`http://127.0.0.1:${server.address().port}`, body, { ...options, proxy: false }); } };
  const started = Date.now(), res = response();
  await createHandler({ env, limit: allowed, provider })(request(), res);
  assert.equal(res.statusCode, 504); assert.equal(res.body.code, 'PROVIDER_TIMEOUT');
  assert.ok(Date.now() - started < 21000);
});

test('provider failures and malformed replies expose no upstream payload', async () => {
  for (const provider of [{ async post() { throw { code: 'BAD', response: { data: 'private payload' } }; } }, { async post() { return { data: {} }; } }]) {
    const res = response(); await createHandler({ env, limit: allowed, provider })(request(), res);
    assert.equal(res.statusCode, 502); assert.equal(res.body.code, 'PROVIDER_ERROR');
    assert.ok(!JSON.stringify(res.body).includes('private payload'));
  }
});

test('missing key and failed quota backend fail closed before the provider', async () => {
  let calls = 0;
  const provider = { async post() { calls++; return reply; } };
  for (const config of [{ env: {}, limit: allowed }, { env, limit: async () => { throw new Error('backend failure'); } }]) {
    const res = response(); await createHandler({ provider, ...config })(request(), res);
    assert.equal(res.statusCode, 503);
  }
  assert.equal(calls, 0);
});

test('caller quota is isolated, rejects before provider, and resets at expiry', async () => {
  let time = 0, calls = 0;
  const limit = createRateLimiter({ env: {}, now: () => time });
  const handler = createHandler({ env, limit, provider: { async post() { calls++; return reply; } } });
  for (let i = 0; i < CHAT_LIMITS.perCaller; i++) {
    const res = response(); await handler(request(), res); assert.equal(res.statusCode, 200);
  }
  const blocked = response(); await handler(request(), blocked);
  assert.equal(blocked.statusCode, 429); assert.equal(blocked.body.code, 'RATE_LIMITED');
  assert.equal(blocked.headers['Retry-After'], '60'); assert.equal(calls, CHAT_LIMITS.perCaller);
  const other = response(); await handler(request({ message: 'Hi' }, '127.0.0.2'), other);
  assert.equal(other.statusCode, 200);
  time = CHAT_LIMITS.windowMs;
  const reset = response(); await handler(request(), reset); assert.equal(reset.statusCode, 200);
});

test('global quota rejects new callers without consuming their individual quota', async () => {
  let time = 0;
  const limit = createRateLimiter({ env: {}, now: () => time });
  for (let i = 0; i < CHAT_LIMITS.global; i++) assert.equal((await limit(`caller-${i}`)).allowed, true);
  assert.deepEqual(await limit('new-caller'), { allowed: false, retryAfterSeconds: 60 });
  time = CHAT_LIMITS.windowMs;
  assert.equal((await limit('new-caller')).allowed, true);
});

test('shared backend reserves both quotas in one atomic operation across limiter instances', async () => {
  let count = 0;
  const config = { env: { NODE_ENV: 'production', UPSTASH_REDIS_REST_URL: 'https://quota.invalid', UPSTASH_REDIS_REST_TOKEN: 'mock-token' }, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://quota.invalid');
    const command = JSON.parse(options.body);
    assert.equal(command[0], 'EVAL'); assert.equal(command[2], '2');
    assert.match(command[1], /redis.call\('INCR'/); assert.ok(options.signal);
    return { ok: true, json: async () => ({ result: ++count <= 2 ? [1, 0] : [0, 12] }) };
  } };
  const first = createRateLimiter(config), second = createRateLimiter(config);
  assert.equal((await first('hashed-caller')).allowed, true);
  assert.equal((await second('hashed-caller')).allowed, true);
  assert.deepEqual(await first('hashed-caller'), { allowed: false, retryAfterSeconds: 12 });
});

test('production cannot fall back to local counters; malformed backend results fail closed', async () => {
  for (const environment of [{ NODE_ENV: 'production' }, { VERCEL_ENV: 'preview' }, { UPSTASH_REDIS_REST_TOKEN: 'partial' }]) {
    await assert.rejects(createRateLimiter({ env: environment })('caller'));
  }
  for (const data of [{ error: 'failed' }, { result: [2, 0] }, { result: [1, -1] }, { result: [1] }]) {
    await assert.rejects(createRateLimiter({ env: { UPSTASH_REDIS_REST_URL: 'https://quota.invalid', UPSTASH_REDIS_REST_TOKEN: 'mock' }, fetchImpl: async () => ({ ok: true, json: async () => data }) })('caller'));
  }
});

test('caller identity ignores client-controlled forwarding outside Vercel', () => {
  const req = request(); req.headers['x-forwarded-for'] = 'forged'; req.headers['x-vercel-forwarded-for'] = 'platform';
  assert.equal(callerIdentity(req, {}), callerIdentity(request(), {}));
  assert.notEqual(callerIdentity(req, { VERCEL: '1' }), callerIdentity(req, {}));
  assert.match(callerIdentity(req, {}), /^[a-f0-9]{64}$/);
});
