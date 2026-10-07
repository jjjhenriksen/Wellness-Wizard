import { createHash } from 'node:crypto';

export const CHAT_LIMITS = { perCaller: 10, global: 100, windowMs: 60_000 };

// Atomically reserve both quotas across serverless instances. Rejection must
// not consume the other quota or extend a window.
const RESERVE = `
local caller = tonumber(redis.call('GET', KEYS[1]) or '0')
local global = tonumber(redis.call('GET', KEYS[2]) or '0')
if caller >= tonumber(ARGV[1]) or global >= tonumber(ARGV[2]) then
  local ttl = 0
  if caller >= tonumber(ARGV[1]) then ttl = redis.call('PTTL', KEYS[1]) end
  if global >= tonumber(ARGV[2]) then ttl = math.max(ttl, redis.call('PTTL', KEYS[2])) end
  return {0, math.max(1, math.ceil(ttl / 1000))}
end
if redis.call('INCR', KEYS[1]) == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
if redis.call('INCR', KEYS[2]) == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[3]) end
return {1, 0}
`;

export function callerIdentity(req, env = process.env) {
  // Vercel overwrites this header. Never trust generic forwarding headers.
  const forwarded = env.VERCEL === '1' && req.headers?.['x-vercel-forwarded-for'];
  const address = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress;
  return createHash('sha256').update(address || 'unknown').digest('hex');
}

export function createRateLimiter({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const buckets = new Map();
  return async (identity) => {
    const url = env.UPSTASH_REDIS_REST_URL;
    const token = env.UPSTASH_REDIS_REST_TOKEN;
    if (url && token) {
      if (new URL(url).protocol !== 'https:') throw new Error('Quota backend requires HTTPS');
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['EVAL', RESERVE, '2', `wellness:chat:caller:${identity}`, 'wellness:chat:global', String(CHAT_LIMITS.perCaller), String(CHAT_LIMITS.global), String(CHAT_LIMITS.windowMs)]),
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error('Quota backend unavailable');
      const data = await response.json();
      if (data.error || !Array.isArray(data.result) || data.result.length !== 2 || ![0, 1].includes(data.result[0]) || !Number.isFinite(data.result[1]) || data.result[1] < 0) {
        throw new Error('Invalid quota response');
      }
      return { allowed: data.result[0] === 1, retryAfterSeconds: Math.max(1, Math.ceil(data.result[1])) };
    }
    if (url || token || env.NODE_ENV === 'production' || ['production', 'preview'].includes(env.VERCEL_ENV)) {
      throw new Error('Shared quota backend not configured');
    }
    // Local-only fallback; accepted caller count is bounded by global quota.
    const time = now();
    for (const [key, bucket] of buckets) if (bucket.expires <= time) buckets.delete(key);
    const clientKey = `caller:${identity}`;
    const client = buckets.get(clientKey) || { count: 0, expires: time + CHAT_LIMITS.windowMs };
    const global = buckets.get('global') || { count: 0, expires: time + CHAT_LIMITS.windowMs };
    if (client.count >= CHAT_LIMITS.perCaller || global.count >= CHAT_LIMITS.global) {
      const expiry = Math.max(client.count >= CHAT_LIMITS.perCaller ? client.expires : 0, global.count >= CHAT_LIMITS.global ? global.expires : 0);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((expiry - time) / 1000)) };
    }
    client.count++; global.count++;
    buckets.set(clientKey, client); buckets.set('global', global);
    return { allowed: true, retryAfterSeconds: 0 };
  };
}
