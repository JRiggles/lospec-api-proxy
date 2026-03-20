import type { RateLimitStatus } from './rateLimit';

export interface DebugContext {
    requestUrl: URL;
    subPath: string;
    clientUA: string;
    clientIP: string;
    rateLimitStatus: RateLimitStatus;
    upstreamUrl: URL;
    proxyHeaders: Headers;
}
