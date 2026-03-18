export const config = { runtime: "edge" };

const API_BASE_URL = 'https://api.lospec.com';
const API_VERSION = process.env.API_VERSION || 'v1';
const API_KEY = process.env.LOSPEC_API_KEY;
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || '5000', 10);
const CACHE_TTL = process.env.CACHE_DURATION || '3600';
const IS_CACHING_ENABLED = process.env.ENABLE_CACHING !== 'false';

/**
* Allowed API endpoints (after stripping `/api/lospec/`).
* Supports exact match and slug subpaths (e.g., /palettes/{slug}).
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
* Normalizes the incoming request path by stripping the Vercel deployment prefix
* and removing leading/trailing slashes for consistent allowlist matching.
*
* @param pathname - The raw URL pathname from the incoming request.
* @returns Normalized path string suitable for allowlist validation.
*/
function normalizePath(pathname: string) {
    let path = pathname.replace(/^\/api\/lospec/, '');
    if (!path.startsWith('/')) path = `/${path}`;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return path;
}

/**
* Checks whether the given normalized path matches any entry in the allowlist.
* Supports slug subpaths by allowing any additional path segments.
*
* @param path - Normalized path from the incoming request.
* @returns True if the path is allowed, false otherwise.
*/
function isPathAllowed(path: string) {
    const normalized = path.replace(/^\/+/, ''); // remove leading slash
    return API_ENDPOINTS.some(ep => normalized === ep || normalized.startsWith(ep + '/'));
}

/**
* Generates caching headers for GET requests to optimize CDN caching and reduce repeated upstream calls.
*
* @param reqMethod - The HTTP method of the incoming request.
* @param resOk - Whether the upstream response was successful (2xx).
* @returns Headers object for caching, or empty if caching is disabled or not a GET request.
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
* Handles health checks, path validation, optional caching, slug support, and request forwarding.
*
* @param req - The incoming Request object from Vercel Edge.
* @returns A Response object, either proxied from Lospec or an error.
*/
export default async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const targetPath = normalizePath(url.pathname);

    // Reject disallowed paths
    if (!isPathAllowed(targetPath)) {
        return new Response(JSON.stringify({ error: 'Forbidden path' }), { status: 403 });
    }

    /**
    * Special handling for health endpoint (no API key required)
    */
    if (targetPath === '/health' || targetPath === 'health') {
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
    * Forward request to Lospec API.
    * Supports GET/POST/PUT/DELETE with optional request body, query parameters, and slug paths.
    */
    try {
        const upstreamRes = await fetch(`${API_BASE_URL}${targetPath}${url.search}`, {
            method: req.method,
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
                'User-Agent': req.headers.get('user-agent') || 'lospec-proxy'
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            body: req.method !== 'GET' && req.method !== 'HEAD' ? await req.text() : null
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
