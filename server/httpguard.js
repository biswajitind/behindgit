import net from 'node:net';
import { AppError } from './errors.js';
import { getConfig } from './config.js';

const hits = new Map();
const WINDOW_MS = 60_000;

// IPv4 stays as itself. IPv6 is the /64 so one network cannot mint a new
// bucket per address. IPv4-mapped IPv6 is treated as IPv4.
export function rateKey(ip) {
  if (!ip) return 'unknown';
  let value = String(ip).split('%')[0];
  if (value.startsWith('::ffff:')) value = value.slice(7);
  if (net.isIP(value) === 4) return value;
  if (net.isIP(value) !== 6) return value;
  const halves = value.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const missing = Math.max(0, 8 - left.length - right.length);
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  return groups.slice(0, 4).join(':');
}

export function clientKey(req) {
  const cfg = getConfig();
  const raw = cfg.trustProxy ? (req.ip || 'unknown') : (req.socket?.remoteAddress || 'unknown');
  return rateKey(raw);
}

export function sweepRateLimits(now = Date.now()) {
  for (const [key, stamps] of hits) {
    const recent = stamps.filter((stamp) => now - stamp < WINDOW_MS);
    if (!recent.length) hits.delete(key);
    else hits.set(key, recent);
  }
}

export function rateLimit(kind) {
  return (req, res, next) => {
    const cfg = getConfig();
    const limit = kind === 'create'
      ? cfg.rateCreatePerMin
      : kind === 'read'
        ? cfg.rateReadPerMin
        : cfg.rateCommandPerMin;
    const key = `${kind}:${clientKey(req)}`;
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((stamp) => now - stamp < WINDOW_MS);
    if (!recent.length) hits.delete(key);
    if (recent.length >= limit) {
      const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - recent[0])) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      hits.set(key, recent);
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
