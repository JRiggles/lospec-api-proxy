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

// validate environment on initialization
if (!LOSPEC_API_KEY) {
    throw new Error('Missing LOSPEC_API_KEY environment variable.');
}

const CACHE_DISABLED_HEADERS = {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'CDN-Cache-Control': 'no-store',
    'Vercel-CDN-Cache-Control': 'no-store',
};

function getSubPath(requestUrl: URL): string {
    const rewrittenSegments = requestUrl.searchParams.get('segments');
    const dynamicPath = requestUrl.searchParams.get('...path');
    if (rewrittenSegments) {
        return rewrittenSegments.replace(/^\/+|\/+$/g, '');
    }
    if (dynamicPath) {
        return dynamicPath.replace(/^\/+|\/+$/g, '');
    }
    return requestUrl.pathname.replace(/^\/api\/lospec\/?/, '').replace(/^\/+|\/+$/g, '');
}

function getDebugInfo(
    requestUrl: URL,
    subPath: string,
    isHealth: boolean,
    clientUA: string,
    upstreamUrl: URL,
    proxyHeaders: Headers
): Response {
    const debugHeaders = new Headers({
        ...CACHE_DISABLED_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
    });

    return Response.json({
        debug: true,
        request: {
            method: 'GET',
            incomingUrl: requestUrl.toString(),
            subPath,
            isHealth,
            userAgent: clientUA,
        },
        accessControl: {
            requiredUserAgent: REQUIRED_USER_AGENT || null,
            isUserAgentAllowed: REQUIRED_USER_AGENT === '' || clientUA === REQUIRED_USER_AGENT,
        },
        outboundRequest: {
            url: upstreamUrl.toString(),
            method: 'GET',
            headers: {
                authorization: proxyHeaders.has('Authorization') ? 'Bearer [redacted]' : null,
            },
            timeoutMs: FETCH_TIMEOUT_MS,
        },
        cache: (isHealth || CACHE_TTL === '0')
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

export default async function handler(req: Request) {
    if (req.method !== 'GET') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    const requestUrl = new URL(req.url, UPSTREAM_BASE_URL);
    const isDebug = ['1', 'true', 'yes'].includes(
        (requestUrl.searchParams.get('debug') || '').toLowerCase()
    );

    const clientUA = req.headers.get('user-agent') || '';
    const isUserAgentAllowed = REQUIRED_USER_AGENT === '' || clientUA === REQUIRED_USER_AGENT;

    if (!isDebug && !isUserAgentAllowed) {
        return new Response('Forbidden', { status: 403 });
    }

    const subPath = getSubPath(requestUrl);
    const isHealth = subPath === 'health';

    const upstreamSearchParams = new URLSearchParams(requestUrl.searchParams);
    upstreamSearchParams.delete('debug');
    upstreamSearchParams.delete('segments');
    upstreamSearchParams.delete('...path');

    const upstreamUrl = new URL(isHealth ? '/health' : `/${subPath}`, UPSTREAM_BASE_URL);
    if (!isHealth) {
        upstreamUrl.search = upstreamSearchParams.toString();
    }

    const proxyHeaders = new Headers();
    if (!isHealth) {
        proxyHeaders.set('Authorization', `Bearer ${LOSPEC_API_KEY}`);
    }

    if (isDebug) {
        return getDebugInfo(requestUrl, subPath, isHealth, clientUA, upstreamUrl, proxyHeaders);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const upstreamRes = await fetch(upstreamUrl, {
            method: 'GET',
            headers: proxyHeaders,
            signal: controller.signal,
        });

        const resHeaders = new Headers(upstreamRes.headers);
        if (isHealth || CACHE_TTL === '0') {
            Object.entries(CACHE_DISABLED_HEADERS).forEach(([key, value]) => {
                resHeaders.set(key, value);
            });
        } else {
            resHeaders.set(
                'Vercel-CDN-Cache-Control',
                `public, max-age=120, s-maxage=${CACHE_TTL}, stale-while-revalidate=${SWR_TTL}`
            );
        }

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
