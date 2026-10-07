import axios from 'axios';
import { callerIdentity, createRateLimiter } from '../lib/chat-rate-limit.js';

export const PROVIDER_TIMEOUT_MS = 15_000;
export const MAX_MESSAGE_CHARACTERS = 4_000;

export function createHandler({ provider = axios, limit = createRateLimiter(), env = process.env } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ code: 'METHOD_NOT_ALLOWED', message: 'Only POST requests allowed' });
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.message !== 'string' || !body.message.trim() || body.message.length > MAX_MESSAGE_CHARACTERS) {
      return res.status(400).json({ code: 'INVALID_REQUEST', message: 'Provide a non-empty message of at most 4,000 characters.' });
    }
    if (!env.OPENAI_API_KEY) {
      return res.status(503).json({ code: 'NOT_CONFIGURED', message: 'Chat is not configured on this deployment.' });
    }
    let quota;
    try {
      quota = await limit(callerIdentity(req, env));
    } catch {
      return res.status(503).json({ code: 'QUOTA_UNAVAILABLE', message: 'Chat is temporarily unavailable. Please try again later.' });
    }
    if (!quota.allowed) {
      res.setHeader('Retry-After', String(quota.retryAfterSeconds));
      return res.status(429).json({ code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.', retryAfterSeconds: quota.retryAfterSeconds });
    }
    try {
      const response = await provider.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4.1-nano',
        messages: [
          { role: 'system', content: 'You are a whimsical Wellness Wizard...' },
          { role: 'user', content: body.message.trim() },
        ],
      }, {
        timeout: PROVIDER_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      });
      const reply = response.data?.choices?.[0]?.message?.content;
      if (typeof reply !== 'string' || !reply.trim()) throw new Error('Invalid provider response');
      return res.status(200).json({ reply });
    } catch (error) {
      if (['ECONNABORTED', 'ETIMEDOUT'].includes(error.code)) {
        return res.status(504).json({ code: 'PROVIDER_TIMEOUT', message: 'The Wizard took too long to respond. Please try again.' });
      }
      // Never log provider payloads, user messages, or request credentials.
      return res.status(502).json({ code: 'PROVIDER_ERROR', message: 'Something went wrong with the chat provider.' });
    }
  };
}

export default createHandler();
