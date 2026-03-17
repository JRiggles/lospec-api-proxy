export const config = { runtime: "edge" };


const API_BASE_URL = 'https://api.lospec.com';
const HEALTH_CACHE_TTL = '60';

// environment variables:
// API authentication
const API_KEY = process.env.LOSPEC_API_KEY;
const API_VERSION = process.env.API_VERSION || 'v1';
// user agent filtering
const IS_UA_FILTER_ENABLED = process.env.ENABLE_UA_FILTER !== 'false';
const REQUIRED_UA = process.env.REQUIRED_USER_AGENT;
// caching & timeouts
const IS_CACHING_ENABLED = process.env.ENABLE_CACHING !== 'false';
const CACHE_TTL = process.env.CACHE_DURATION || '3600';
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || '5000');

// valid API endpoints (requests to endpoints not in this list will be rejected)
const API_ENDPOINTS = [
    // Palettes endpoints
    `${API_VERSION}/palettes`,
    `${API_VERSION}/palettes/`,  // /palettes/{slug}
    `${API_VERSION}/palettes/daily`,
    `${API_VERSION}/palettes/random`,
    `${API_VERSION}/palettes/suggest`,
    // Daily Tags endpoints
    `${API_VERSION}/dailytags`,
    `${API_VERSION}/dailytags/`,  // /dailytags/{slug}
    `${API_VERSION}/dailytags/daily`,
    // User endpoints
    `${API_VERSION}/user`,
    `${API_VERSION}/usage`,
    // API system endpoints
    "health"
];

/**
 * Checks the upstream API health endpoint with a strict timeout.
 * Uses Edge caching to prevent redundant health checks on every proxy request.
 * @returns {Promise<boolean>} True if the upstream API returns an 'ok' status.
 */
async function isUpstreamHealthy(): Promise<boolean> {
    try {
        const healthUrl = `${API_BASE_URL}/health`;
        const res = await fetch(healthUrl, {
            signal: AbortSignal.timeout(3000), // 3s health check limit
            headers: { 'Cache-Control': 'public, s-maxage=60' }
        });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Strips the Vercel deployment prefix and normalizes the target API path.
 * Removes trailing slashes to ensure consistent regex matching.
 * @param {string} pathname - The raw incoming URL pathname.
 * @returns {string} The cleaned path suitable for regex validation and forwarding.
 */
function getNormalizedPath(pathname: string): string {
    let path = pathname.replace(/^\/api\/lospec/, '');
    if (!path.startsWith('/')) path = `/${path}`;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return path;
}

/**
 * Validates the incoming User-Agent against optional environment restrictions.
 * Supports exact string matching via REQUIRED_USER_AGENT or basic bot/headless detection.
 * @param {string} ua - The 'user-agent' header from the incoming request.
 * @returns {{ allowed: boolean; message?: string }} Validation result and error message if denied.
 */
function validateUserAgent(ua: string): { allowed: boolean; message?: string } {
    if (!IS_UA_FILTER_ENABLED) return { allowed: true };

    if (REQUIRED_UA) {
        return { allowed: ua === REQUIRED_UA, message: 'Unauthorized User-Agent' };
    }

    const isBot = !ua || /bot|spider|crawl|headless/i.test(ua);
    return { allowed: !isBot, message: 'Access Denied' };
}

/**
 * Generates robust caching headers for the response.
 * Implements s-maxage for CDN caching and revalidation directives for the browser.
 * @param {string} reqMethod - The HTTP method of the incoming request.
 * @param {boolean} resOk - Whether the upstream API response was successful (2xx).
 * @returns {HeadersInit} An object containing optimized Cache-Control and Vary headers.
 */
function getCacheHeaders(reqMethod: string, resOk: boolean): Record<string, string> {
    if (IS_CACHING_ENABLED && reqMethod === 'GET' && resOk) {
        return {
            'Cache-Control': `public, s-maxage=${CACHE_TTL}, stale-while-revalidate=60, max-age=0, must-revalidate`,
            'Vercel-CDN-Cache-Control': `max-age=${CACHE_TTL}`,
            'Vary': 'Accept-Encoding'
        };
    }
    return {};
}

/**
 * Primary Edge Function handler for the request proxy ([...path].ts).
 * Orchestrates health checks, security filtering, and authenticated request streaming.
 * @param {Request} req - The incoming standardized Request object.
 * @returns {Promise<Response>} The proxied stream or an error response.
 */
export default async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const targetPath = getNormalizedPath(url.pathname);
    const incomingUa = req.headers.get('user-agent') || '';

    // check upstream API health before doing any work
    if (!(await isUpstreamHealthy())) {
        return new Response(JSON.stringify({ error: 'Upstream API Unavailable' }), {
            status: 503,
            headers: { 'Retry-After': HEALTH_CACHE_TTL, 'Content-Type': 'application/json' }
        });
    }

    // optional user agent check
    const uaCheck = validateUserAgent(incomingUa);
    if (!uaCheck.allowed) return new Response(uaCheck.message, { status: 403 });

    // endpoint path allowlist check
    if (!API_ENDPOINTS.some(p => p.startsWith(targetPath))) {
        return new Response(JSON.stringify({ error: 'Forbidden path' }), { status: 403 });
    }

    // check for API key presence before attempting to proxy
    if (!API_KEY) return new Response(JSON.stringify(
        { error: 'Config error: missing Lospec API key' }
    ), { status: 500 });

    // forward the request to the Lospec API with authentication and timeout
    try {
        const response = await fetch(`${API_BASE_URL}${targetPath}${url.search}`, {
            method: req.method,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
                'User-Agent': incomingUa,
            },
            body: req.method !== 'GET' && req.method !== 'HEAD' ? await req.text() : null,
        });

        // return streaming response with security headers
        return new Response(response.body, {
            status: response.status,
            headers: {
                'Content-Type': 'application/json',
                'X-Content-Type-Options': 'nosniff',
                'X-Frame-Options': 'DENY',
                ...getCacheHeaders(req.method, response.ok),
            },
        });
    } catch (error: any) {
        const isTimeout = error.name === 'TimeoutError';
        return new Response(
            JSON.stringify({ error: isTimeout ? 'Upstream Timeout' : 'Proxy Failed' }),
            { status: isTimeout ? 504 : 502, headers: { 'Content-Type': 'application/json' } }
        );
    }
}
