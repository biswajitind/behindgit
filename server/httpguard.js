import { AppError } from './errors.js';
import { getConfig } from './config.js';

const hits = new Map();

function clientIp(req) {
  return req.socket?.remoteAddress || 'unknown';
}

export function rateLimit(kind) {
  return (req, res, next) => {
    const cfg = getConfig();
    const limit = kind === 'create' ? cfg.rateCreatePerMin : cfg.rateCommandPerMin;
    const key = `${kind}:${clientIp(req)}`;
    const now = Date.now();
    const windowMs = 60_000;
    const recent = (hits.get(key) || []).filter((stamp) => now - stamp < windowMs);
    if (recent.length >= limit) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      next(new AppError('Too many requests', 429));
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}

export function requireSameOriginMutation(req, res, next) {
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    next();
    return;
  }
  const site = (req.get('sec-fetch-site') || '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') {
    next(new AppError('Cross-site request rejected', 403));
    return;
  }
  if (req.get('x-behindgit') !== '1') {
    next(new AppError('Missing X-BehindGit header', 403));
    return;
  }
  const type = (req.get('content-type') || '').toLowerCase();
  if (!type.startsWith('application/json')) {
    next(new AppError('Content-Type must be application/json', 415));
    return;
  }
  next();
}
