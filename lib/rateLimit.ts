/**
 * Rate limiting module for Lospec API proxy
 * Provides per-IP request throttling and client IP extraction
 */

export interface RateLimitStatus {
    allowed: boolean;
    remaining: number;
    resetMs: number;
}

const RATE_LIMIT_ENABLED = (process.env.RATE_LIMIT_ENABLED || 'true').toLowerCase() === 'true';
const RATE_LIMIT_REQUESTS = parseInt(process.env.RATE_LIMIT_REQUESTS || '100', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10); // 1 minute

// ultra-simple in-memory rate limiter store (per edge location)
// maps IP -> array of request timestamps
const rateLimitStore = new Map<string, number[]>();

// clean the store every window-length, removing IPs with no recent requests
// (this keeps memory bounded when there are many unique IPs over time)
setInterval(() => {
    const windowStart = Date.now() - RATE_LIMIT_WINDOW_MS;
    for (const [ip, timestamps] of rateLimitStore) {
        if (timestamps[timestamps.length - 1] <= windowStart) {
            rateLimitStore.delete(ip);
        }
    }
}, RATE_LIMIT_WINDOW_MS);


/**
 * Check if a request from the given IP is within rate limits
 */
export function checkRateLimit(clientIP: string): RateLimitStatus {
    if (!RATE_LIMIT_ENABLED) {
        return { allowed: true, remaining: RATE_LIMIT_REQUESTS, resetMs: 0 };
    }
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW_MS;
    // get or create request history for this IP
    let requests = rateLimitStore.get(clientIP) || [];
    // remove requests outside the current window
    requests = requests.filter(timestamp => timestamp > windowStart);

    const remaining = Math.max(0, RATE_LIMIT_REQUESTS - requests.length);
    const allowed = requests.length < RATE_LIMIT_REQUESTS;
    // add current request if allowed
    if (allowed) {
        requests.push(now);
    }
    // update store
    rateLimitStore.set(clientIP, requests);
    // calculate reset time (when oldest request exits the window)
    const resetMs = requests.length > 0 ? requests[0] + RATE_LIMIT_WINDOW_MS - now : 0;

    return { allowed, remaining, resetMs };
}

/**
 * Extract client IP from request, accounting for common proxy headers
 */
export function getClientIp(req: Request): string {
    return (
        req.headers.get('cf-connecting-ip') ||
        req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
        req.headers.get('x-real-ip') ||
        'unknown'
    );
}

/**
 * Get rate limit configuration
 */
export function getRateLimitConfig() {
    return {
        enabled: RATE_LIMIT_ENABLED,
        requests: RATE_LIMIT_REQUESTS,
        windowMs: RATE_LIMIT_WINDOW_MS,
    };
}
