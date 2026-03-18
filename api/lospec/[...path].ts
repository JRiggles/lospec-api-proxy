export const config = { runtime: "edge" };

const API_BASE_URL = 'https://api.lospec.com';
const API_VERSION = process.env.API_VERSION || 'v1';
const API_KEY = process.env.LOSPEC_API_KEY;
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || '5000', 10);
const CACHE_TTL = parseInt(process.env.CACHE_DURATION || '3600', 10);
const IS_CACHING_ENABLED = process.env.ENABLE_CACHING !== 'false';

/**
* Allowed API endpoints (after stripping `/api/lospec/`).
* Supports exact matches and slug subpaths (e.g., /palettes/{slug}).
*/
const API_ENDPOINTS = [
    // Palettes
    `${API_VERSION}/palettes`,
    `${API_VERSION}/palettes/daily`,
    `${API_VERSION}/palettes/random`,
    `${API_VERSION}/palettes/suggest`,
    // Daily Tags
    `${API_VERSION}/dailytags`,
    `${API_VERSION}/dailytags/daily`,
    // User
    `${API_VERSION}/user`,
    `${API_VERSION}/usage`,
    // System
    'health'
];

/**
* Normalizes an incoming Vercel path for proxying to Lospec API.
* - Strips /api/lospec prefix
* - Removes leading/trailing slashes
*
* @param pathname - Raw incoming URL pathname
* @returns Normalized path string
*/
function cleanPath(pathname: string): string {
    return pathname.replace(/^\/api\/lospec\/?/, '').replace(/^\/+|\/+$/g, '');
}

/**
* Checks if a normalized path is allowed according to API_ENDPOINTS.
* Supports slug subpaths automatically.
*
* @param path - Normalized path from cleanPath()
* @returns True if path is allowed
*/
function isAllowed(path: string): boolean {
    return API_ENDPOINTS.some(ep => path === ep || path.startsWith(ep + '/'));
}

/**
* Generates caching headers for GET requests to optimize CDN caching
* and reduce repeated upstream calls.
*
* @param reqMethod - The HTTP method of the incoming request
* @param resOk - Whether the upstream response was successful (2xx)
* @returns Headers object for caching or empty object
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
* Primary Edge Function handler for the Lospec API proxy.
* Handles health checks, path validation, slug support, caching, and request forwarding.
* Only GET requests are allowed; all others return 405.
*
* @param req - Incoming Request object from Vercel Edge
* @returns Response proxied from Lospec or error response
*/
export default async function handler(req: Request): Promise<Response> {
    // Reject non-GET requests immediately
    if (req.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Only GET requests are allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
    }

    const url = new URL(req.url);
    const cleanedPath = cleanPath(url.pathname);

    // Reject disallowed paths
    if (!isAllowed(cleanedPath)) {
        return new Response(JSON.stringify({ error: 'Forbidden path' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    /**
    * Special handling for health endpoint (no API key required)
    */
    if (cleanedPath === 'health') {
        try {
            const res = await fetch(`${API_BASE_URL}/health`, {
                signal: AbortSignal.timeout(3000)
            });
            const data = await res.text();
            return new Response(data, {
                status: res.status,
                headers: { 'Content-Type': 'application/json' }
            });
        } catch {
            return new Response(JSON.stringify({ error: 'Upstream health check failed' }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }

    // Require API key for all other endpoints
    if (!API_KEY) {
        return new Response(JSON.stringify({ error: 'Missing Lospec API key' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    /**
    * Forward GET request to Lospec API
    * Supports slug subpaths automatically
    */
    try {
        const upstreamUrl = `${API_BASE_URL}/api/${cleanedPath}${url.search}`;

        const upstreamRes = await fetch(upstreamUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
                'User-Agent': req.headers.get('user-agent') || 'lospec-proxy'
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });

        return new Response(upstreamRes.body, {
            status: upstreamRes.status,
            headers: {
                'Content-Type': 'application/json',
                ...getCacheHeaders(req.method, upstreamRes.ok)
            }
        });
    } catch (err: any) {
        const isTimeout = err?.name === 'TimeoutError';
        return new Response(JSON.stringify({ error: isTimeout ? 'Upstream Timeout' : 'Proxy Failed' }), {
            status: isTimeout ? 504 : 502,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
