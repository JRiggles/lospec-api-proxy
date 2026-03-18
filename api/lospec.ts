export const config = {runtime: 'edge'};

const UPSTREAM_BASE_URL = 'https://api.lospec.com';

function normalizeEnvString(value: string | undefined): string {
    if (!value) {
        return '';
    }

    const trimmed = value.trim();
    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
        return trimmed.slice(1, -1);
    }

    return trimmed;
}

// environment variables
const LOSPEC_API_KEY = process.env.LOSPEC_API_KEY;
const REQUIRED_USER_AGENT = normalizeEnvString(process.env.REQUIRED_USER_AGENT);
const CACHE_TTL = process.env.CACHE_TTL || '86400';
const SWR_TTL = process.env.SWR_TTL || '3600';
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || '5000', 10);

// validate environment on initialization
if (!LOSPEC_API_KEY) {
    throw new Error('Missing LOSPEC_API_KEY environment variable.');
}

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
    // DEBUG: temporarily disablu user agen check
    // if (!isDebug && !isUserAgentAllowed) {
    //     return new Response('Forbidden', { status: 403 });
    // }

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
        const debugHeaders = new Headers({
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Content-Type': 'application/json; charset=utf-8',
            'CDN-Cache-Control': 'no-store',
            'Vercel-CDN-Cache-Control': 'no-store',
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
                isUserAgentAllowed,
            },
            outboundRequest: {
                url: upstreamUrl.toString(),
                method: 'GET',
                headers: {
                    authorization: proxyHeaders.has('Authorization') ? 'Bearer [redacted]' : null,
                },
                timeoutMs: FETCH_TIMEOUT_MS,
            },
            cache: isHealth
                ? {
                    cacheControl: 'no-store, no-cache, must-revalidate',
                    cdnCacheControl: 'no-store',
                    vercelCdnCacheControl: 'no-store',
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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const upstreamRes = await fetch(upstreamUrl, {
            method: 'GET',
            headers: proxyHeaders,
            signal: controller.signal,
        });

        const resHeaders = new Headers(upstreamRes.headers);
        if (isHealth) {
            resHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate');
            resHeaders.set('CDN-Cache-Control', 'no-store');
            resHeaders.set('Vercel-CDN-Cache-Control', 'no-store');
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
