import type { DebugContext } from '../lib/types';
import { checkRateLimit, getClientIp, getRateLimitConfig } from '../lib/rateLimit';
import type { RateLimitStatus } from '../lib/rateLimit';

export const config = { runtime: 'edge' };

const UPSTREAM_BASE_URL = 'https://api.lospec.com';
// environment variables
const LOSPEC_API_KEY = process.env.LOSPEC_API_KEY;
var rawEnvUserAgent = process.env.REQUIRED_USER_AGENT || '';
// normalize REQUIRED_USER_AGENT str by trimming whitespace and removing surrounding quotes
const REQUIRED_USER_AGENT = rawEnvUserAgent.trim().replace(/^['"]|['"]$/g, '');
const CACHE_TTL = process.env.CACHE_TTL || '86400';
const SWR_TTL = process.env.SWR_TTL || '3600';
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || '5000', 10);
const RATE_LIMIT_CONFIG = getRateLimitConfig(); // parsed from environment variables

// validate environment on initialization
if (!LOSPEC_API_KEY) {
    throw new Error('Missing LOSPEC_API_KEY environment variable.');
}

const CACHE_DISABLED_HEADERS = {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'CDN-Cache-Control': 'no-store',
    'Vercel-CDN-Cache-Control': 'no-store',
};

/**
 * Resolves the requested Lospec sub-path from rewrite parameters or the raw pathname
 */
function getSubPath(requestUrl: URL): string {
    const subPath =
        requestUrl.searchParams.get('segments') ||
        requestUrl.searchParams.get('...path') ||
        requestUrl.pathname.replace(/^\/api\/lospec\/?/, '');

    return subPath.replace(/^\/+|\/+$/g, '');
}

/**
 * Returns a debug payload describing how the proxy would handle the current request
 */
function getDebugInfo(context: DebugContext): Response {
    const debugHeaders = new Headers({
        ...CACHE_DISABLED_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
    });

    return Response.json({
        debug: true,
        request: {
            method: 'GET',
            incomingUrl: context.requestUrl.toString(),
            subPath: context.subPath,
            userAgent: context.clientUA,
            clientIP: context.clientIP,
        },
        accessControl: {
            requiredUserAgent: REQUIRED_USER_AGENT || null,
            isUserAgentAllowed: REQUIRED_USER_AGENT === '' || context.clientUA === REQUIRED_USER_AGENT,
        },
        rateLimit: {
            enabled: RATE_LIMIT_CONFIG.enabled,
            requestsPerWindow: RATE_LIMIT_CONFIG.requests,
            windowMs: RATE_LIMIT_CONFIG.windowMs,
            allowed: context.rateLimitStatus.allowed,
            remaining: context.rateLimitStatus.remaining,
            resetMs: context.rateLimitStatus.resetMs,
        },
        outboundRequest: {
            url: context.upstreamUrl.toString(),
            method: 'GET',
            headers: {
                authorization: context.proxyHeaders.has('Authorization') ? 'Bearer [redacted]' : null,
            },
            timeoutMs: FETCH_TIMEOUT_MS,
        },
        cache: (context.subPath === 'health' || CACHE_TTL === '0')
            ? {
                cacheControl: CACHE_DISABLED_HEADERS['Cache-Control'],
                cdnCacheControl: CACHE_DISABLED_HEADERS['CDN-Cache-Control'],
                vercelCdnCacheControl: CACHE_DISABLED_HEADERS['Vercel-CDN-Cache-Control'],
            }
            : {
                vercelCdnCacheControl:
                    `public, max-age=120, s-maxage=${CACHE_TTL}, stale-while-revalidate=${SWR_TTL}`,
            },
    }, {
        status: 200,
        headers: debugHeaders,
    });
}

/**
 * Builds the headers to be sent upstream to the Lospec API
 */
function setProxyHeaders(isHealth: boolean): Headers {
    const headers = new Headers();
    if (!isHealth) {
        // only add Authorization header for non-health requests to avoid exposing it unnecessarily
        headers.set('Authorization', `Bearer ${LOSPEC_API_KEY}`);
    }
    return headers;
}

/**
 * Builds the response headers to be sent back to the client
 */
function setResponseHeaders(
    upstreamHeaders: Headers,
    isHealth: boolean,
    rateLimitStatus: RateLimitStatus
): Headers {
    const headers = new Headers(upstreamHeaders);
    if (isHealth || CACHE_TTL === '0') {
        Object.entries(CACHE_DISABLED_HEADERS).forEach(([key, value]) => {
            headers.set(key, value);
        });
    } else {
        headers.set(
            'Vercel-CDN-Cache-Control',
            `public, max-age=120, s-maxage=${CACHE_TTL}, stale-while-revalidate=${SWR_TTL}`
        );
    }
    headers.set('RateLimit-Limit', RATE_LIMIT_CONFIG.requests.toString());
    headers.set('RateLimit-Remaining', rateLimitStatus.remaining.toString());
    headers.set('RateLimit-Reset', (Date.now() + rateLimitStatus.resetMs).toString());
    return headers;
}

/**
 * Proxies GET requests to the Lospec API with optional User-Agent validation, rate limiting and
 * cache control
 */
export default async function handler(req: Request) {
    if (req.method !== 'GET') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    const requestUrl = new URL(req.url, UPSTREAM_BASE_URL);
    const isDebug = ['1', 'true', 'yes'].includes(
        (requestUrl.searchParams.get('debug') || '').toLowerCase()
    );

    const clientUA = req.headers.get('user-agent') || '';
    const clientIP = getClientIp(req);
    const isUserAgentAllowed = REQUIRED_USER_AGENT === '' || clientUA === REQUIRED_USER_AGENT;

    if (!isDebug && !isUserAgentAllowed) {
        return new Response('Forbidden', { status: 403 });
    }

    const rateLimitStatus = checkRateLimit(clientIP);
    if (!isDebug && !rateLimitStatus.allowed) {
        const resetSecs = Math.ceil(rateLimitStatus.resetMs / 1000);
        return new Response('Too Many Requests', {
            status: 429,
            headers: {
                'Retry-After': resetSecs.toString(),
                'RateLimit-Limit': RATE_LIMIT_CONFIG.requests.toString(),
                'RateLimit-Remaining': '0',
                'RateLimit-Reset': (Date.now() + rateLimitStatus.resetMs).toString(),
            },
        });
    }

    const subPath = getSubPath(requestUrl);
    const isHealth = subPath === 'health';

    const upstreamSearchParams = new URLSearchParams(requestUrl.searchParams);
    upstreamSearchParams.delete('debug');
    upstreamSearchParams.delete('segments');
    upstreamSearchParams.delete('...path');  // inserted by Vercel

    const upstreamUrl = new URL(isHealth ? '/health' : `/${subPath}`, UPSTREAM_BASE_URL);
    if (!isHealth) {
        upstreamUrl.search = upstreamSearchParams.toString();
    }

    const proxyHeaders = setProxyHeaders(isHealth);

    if (isDebug) {
        const debugContext: DebugContext = {
            requestUrl,
            subPath,
            clientUA,
            clientIP,
            rateLimitStatus,
            upstreamUrl,
            proxyHeaders,
        };
        return getDebugInfo(debugContext);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const upstreamRes = await fetch(upstreamUrl, {
            method: 'GET',
            headers: proxyHeaders,
            signal: controller.signal,
        });

        const resHeaders = setResponseHeaders(upstreamRes.headers, isHealth, rateLimitStatus);

        return new Response(upstreamRes.body, {
            status: upstreamRes.status,
            statusText: upstreamRes.statusText,
            headers: resHeaders,
        });
    } catch (err: any) {
        if (err.name === 'AbortError') {
            return new Response('Upstream Timeout', { status: 504 });
        }
        return new Response('Upstream Error', { status: 502 });
    } finally {
        clearTimeout(timeoutId);
    }
}
