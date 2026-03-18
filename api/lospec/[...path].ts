export const config = { runtime: "edge" };

const API_BASE_URL = 'https://api.lospec.com';
const API_VERSION = 'v1';
const API_KEY = process.env.LOSPEC_API_KEY;
const IS_CACHING_ENABLED = process.env.ENABLE_CACHING !== 'false';
const CACHE_TTL = parseInt(process.env.CACHE_DURATION || '3600', 10);
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || '5000', 10);

/**
* Allowed API endpoints.
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
*/
function cleanPath(pathname: string): string {
    return pathname.replace(/^\/api\/lospec\/?/, '').replace(/^\/+|\/+$/g, '');
}

/**
* Checks if a normalized path is allowed according to API_ENDPOINTS.
* Supports slug subpaths automatically.
*/
function isAllowed(path: string): boolean {
    return API_ENDPOINTS.some(ep => path === ep || path.startsWith(ep + '/'));
}

/**
* Generates caching headers for GET requests.
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
* Edge Function handler for the Lospec API proxy.
* Only GET requests allowed. Debug mode available via ?debug=1.
*/
export default async function handler(req: Request): Promise<Response> {
    if (req.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Only GET requests are allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const url = new URL(req.url);
    const cleanedPath = cleanPath(url.pathname);
    const debug = url.searchParams.has('debug');

    // Forward only client-intended query params (i.e. query params NOT managed by Vercel)
    const forwardedSearchParams = new URLSearchParams();
    url.searchParams.forEach((value, key) => {
        if (key !== 'debug' && key !== 'path') forwardedSearchParams.append(key, value);
    });

    const upstreamUrl = `${API_BASE_URL}/api/${cleanedPath}${forwardedSearchParams.toString() ? '?' + forwardedSearchParams.toString() : ''}`;

    // Debug mode: return upstream URL without fetching
    if (debug) {
        return new Response(JSON.stringify({
            cleanedPath,
            upstreamUrl,
            apiKeyDefined: !!API_KEY,
            incomingUrl: req.url
        }, null, 2), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Allowlist check
    if (!isAllowed(cleanedPath)) {
        return new Response(JSON.stringify({ error: 'Forbidden path' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // Health endpoint (no auth)
    if (cleanedPath === 'health') {
        try {
            const res = await fetch(`${API_BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
            const data = await res.text();
            return new Response(data, { status: res.status, headers: { 'Content-Type': 'application/json' } });
        } catch {
            return new Response(JSON.stringify({ error: 'Upstream health check failed' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
        }
    }

    if (!API_KEY) {
        return new Response(JSON.stringify({ error: 'Missing Lospec API key' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    // Forward GET request to Lospec API
    try {
        const upstreamRes = await fetch(upstreamUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
                'User-Agent': req.headers.get('user-agent') || 'lospec-proxy'
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });

        const body = await upstreamRes.text();
        return new Response(body, {
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
