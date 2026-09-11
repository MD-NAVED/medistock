/**
 * Rate Limiting Middleware powered by Upstash Redis with In-Memory fallback.
 */
const { Ratelimit } = require('@upstash/ratelimit');
const { Redis } = require('@upstash/redis');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const IS_PROD = process.env.NODE_ENV === 'production';

let redis = null;
let enabled = false;
let provider = 'disabled';

if (UPSTASH_URL && UPSTASH_TOKEN) {
  try {
    redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
    enabled = true;
    provider = 'upstash';
    console.log('[RateLimit] Upstash Redis initialized successfully.');
  } catch (err) {
    console.error('[RateLimit Error] Failed to initialize Upstash Redis:', err.message);
  }
} else {
  if (IS_PROD) {
    console.error('\x1b[31m[SECURITY WARNING] Rate limiting disabled: Missing UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in production.\x1b[0m');
  }
  // In-memory token bucket fallback for dev/test environments
  provider = 'in-memory';
}

// In-memory sliding window fallback map: key -> [{ timestamp }]
const memStore = new Map();

function cleanMemStore() {
  const now = Date.now();
  for (const [key, entries] of memStore.entries()) {
    const valid = entries.filter(e => e.expiry > now);
    if (valid.length === 0) {
      memStore.delete(key);
    } else {
      memStore.set(key, valid);
    }
  }
}
setInterval(cleanMemStore, 60_000).unref();

function inMemoryLimit(key, limit, windowSeconds) {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  let entries = memStore.get(key) || [];
  entries = entries.filter(e => e.expiry > now);

  if (entries.length >= limit) {
    const oldest = entries[0];
    const resetSeconds = Math.max(1, Math.ceil((oldest.expiry - now) / 1000));
    return { success: false, remaining: 0, reset: resetSeconds };
  }

  entries.push({ timestamp: now, expiry: now + windowMs });
  memStore.set(key, entries);
  return { success: true, remaining: limit - entries.length, reset: windowSeconds };
}

// Upstash ratelimit instances if configured
const upstashLimiters = {};
if (redis) {
  upstashLimiters.login = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(10, '5 m'),
    prefix: 'ratelimit:login',
  });
  upstashLimiters.billing = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(120, '1 m'),
    prefix: 'ratelimit:billing',
  });
  upstashLimiters.scanner = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(10, '1 m'),
    prefix: 'ratelimit:scanner',
  });
  upstashLimiters.import = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(3, '10 m'),
    prefix: 'ratelimit:import',
  });
  upstashLimiters.pdf = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(30, '1 m'),
    prefix: 'ratelimit:pdf',
  });
}

function createLimiter({ name, limit, windowSeconds, getKey }) {
  return async (req, res, next) => {
    try {
      const key = getKey(req);
      if (!key) return next();

      let result;
      if (redis && upstashLimiters[name]) {
        const upstashRes = await upstashLimiters[name].limit(key);
        result = {
          success: upstashRes.success,
          remaining: upstashRes.remaining,
          reset: Math.ceil((upstashRes.reset - Date.now()) / 1000),
        };
      } else {
        result = inMemoryLimit(`${name}:${key}`, limit, windowSeconds);
      }

      if (!result.success) {
        const retryAfter = Math.max(1, result.reset || 1);
        res.setHeader('Retry-After', String(retryAfter));
        console.warn(`[RateLimit 429] Limiter '${name}' triggered for key '${key}'. Retry after ${retryAfter}s`);
        return res.status(429).json({
          error: `Too many requests. Please slow down and try again in ${retryAfter} seconds.`,
          code: 'rate_limited',
          retry_after: retryAfter,
          limiter: name,
        });
      }

      next();
    } catch (e) {
      console.error(`[RateLimit Error] Limiter ${name} failed:`, e.message);
      // Fail-open for application availability
      next();
    }
  };
}

function resolveClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const firstIp = String(forwarded).split(',')[0].trim();
    if (firstIp) return firstIp;
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// 1. Unauthenticated: 10 requests / 5 minutes per IP
const loginIpLimiter = createLimiter({
  name: 'login',
  limit: 10,
  windowSeconds: 300,
  getKey: (req) => {
    const ip = resolveClientIp(req);
    // In local dev/test harness, loopback connections without an explicit proxy header are exempt
    if (!IS_PROD && !req.headers['x-forwarded-for'] && (ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1')) {
      return null;
    }
    return `ip_${ip}`;
  },
});

// 2. Unauthenticated: 30 requests / 1 minute per IP
const publicPdfLimiter = createLimiter({
  name: 'pdf',
  limit: 30,
  windowSeconds: 60,
  getKey: (req) => {
    const ip = resolveClientIp(req);
    if (!IS_PROD && !req.headers['x-forwarded-for'] && (ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1')) {
      return null;
    }
    return `ip_${ip}`;
  },
});

// 3. Authenticated: 120 requests / 1 minute per store_id
const billingLimiter = createLimiter({
  name: 'billing',
  limit: 120,
  windowSeconds: 60,
  getKey: (req) => (req.storeId ? `store_${req.storeId}` : null),
});

// 4. Authenticated: 10 requests / 1 minute per store_id
const aiScannerLimiter = createLimiter({
  name: 'scanner',
  limit: 10,
  windowSeconds: 60,
  getKey: (req) => (req.storeId ? `store_${req.storeId}` : null),
});

// 5. Authenticated: 3 requests / 10 minutes per store_id
const importLimiter = createLimiter({
  name: 'import',
  limit: 3,
  windowSeconds: 600,
  getKey: (req) => (req.storeId ? `store_${req.storeId}` : null),
});

function getRateLimitStatus() {
  return {
    enabled: !!(UPSTASH_URL && UPSTASH_TOKEN),
    provider,
  };
}

module.exports = {
  loginIpLimiter,
  publicPdfLimiter,
  billingLimiter,
  aiScannerLimiter,
  importLimiter,
  getRateLimitStatus,
};
