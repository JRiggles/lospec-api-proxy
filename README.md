# Lospec API Proxy
*Version 0.0.1*

A Vercel Edge Function proxy for the [Lospec API](https://api.lospec.com/docs) with caching, request streaming, and optional access control.

**Purpose:**
This proxy securely forwards requests to the Lospec API while protecting your API key. It enables client-side applications to access Lospec API features without exposing credentials or handling authentication directly.

## Features
- **Edge-based proxy**: Runs on Vercel Edge Functions for low-latency responses
- **Response streaming**: Efficiently passes through upstream responses without buffering
- **Intelligent caching**: Configurable TTL with separate policies for health checks vs API endpoints
- **Request timeout**: Configurable upstream fetch timeout
- **Optional access control**: Validate User-Agent headers for additional security
- **Debug mode**: Inspect request/response details with `?debug=1`
- **GET-only**: Only GET requests are supported because that's what the Lospec API supports; other requests types will receive a `405 Method Not Allowed` response

## Environment Variables

**Required:**
- `LOSPEC_API_KEY`: Your Lospec API key. [Get your API key here.](https://api.lospec.com/docs/#description/getting-an-api-key)

**Recommended:**
- `REQUIRED_USER_AGENT`: If set, only requests with this User-Agent header are allowed (default: empty = no validation)

  *See [Access Control](#access-control) below for more information*
  
**Optional:**
- `CACHE_TTL`: Max age for CDN cache in seconds (default: `86400` = 24 hours)
- `SWR_TTL`: Stale-while-revalidate TTL in seconds (default: `3600` = 1 hour)
- `FETCH_TIMEOUT_MS`: Upstream request timeout in milliseconds (default: `5000`)

Set these in your Vercel project dashboard under Settings → Environment Variables.

```shell
# REQUIRED
LOSPEC_API_KEY=<your api key here>
# RECOMMENDED
REQUIRED_USER_AGENT=""
# OPTIONAL
CACHE_TTL=86400
SWR_TTL=3600
FETCH_TIMEOUT_MS=5000
```

## Usage

### Proxying Requests
All requests to `/api/lospec/*` are forwarded to the Lospec API:

```bash
# Get daily palette
curl "https://your-deployment.vercel.app/api/lospec/api/v1/palettes/daily"

# Get random palette
curl "https://your-deployment.vercel.app/api/lospec/api/v1/palettes/random"

# Get a palette by its Lospec URL slug
curl "https://your-deployment.vercel.app/api/lospec/api/v1/palettes/{slug}"
```

See the [Lospec API Docs](https://api.lospec.com/docs) for all available endpoints.

### Authorization
For non-health endpoints, the proxy automatically adds your `LOSPEC_API_KEY` as a Bearer token.

Health check endpoint (`/api/lospec/health`) does not require authentication.

### Debug Mode
Append `?debug=1` (or `=true` or `=yes`) to inspect the proxy's request/response details:

```bash
curl "https://your-deployment.vercel.app/api/lospec/api/v1/palettes/daily?debug=1"
```
> [!NOTE]
> Requests are not sent upstream to the Lospec API when using debug mode

Returns:
```json
{
  "debug": true,
  "request": {
    "method": "GET",
    "incomingUrl": "...",
    "subPath": "api/v1/palettes/daily",
    "isHealth": false,
    "userAgent": "..."
  },
  "accessControl": {
    "requiredUserAgent": null,
    "isUserAgentAllowed": true
  },
  "outboundRequest": {
    "url": "https://api.lospec.com/api/v1/palettes/daily",
    "method": "GET",
    "headers": {
      "authorization": "Bearer [redacted]"
    },
    "timeoutMs": 5000
  },
  "cache": {
    "vercelCdnCacheControl": "public, max-age=120, s-maxage=86400, stale-while-revalidate=3600"
  }
}
```

### Caching Behavior
- **Health endpoint** (`/api/lospec/health`): No caching (`no-store, no-cache, must-revalidate`)
- **Regular endpoints**: CDN cached with `s-maxage=${CACHE_TTL}`, `stale-while-revalidate=${SWR_TTL}`

> [!TIP]
> Setting `CACHE_TTL="0"` disables all caching for regular endpoints

### Access Control
If `REQUIRED_USER_AGENT` is set, all non-debug requests must include that exact User-Agent header, or they'll receive a `403 Forbidden` response.
You should set this variable to a unique User-Agent string and your application should make requests to the proxy with that same User-Agent in its header, otherwise any user agent can pass requests to the Lospec API via your proxy. 

Setting this won't prevent determined users from abusing your API key

Example with User-Agent validation:
```bash
curl -H "User-Agent: MyApp/1.0" "https://your-deployment.vercel.app/api/lospec/api/v1/palettes/daily"
```

# Acknowledgments
This project is not affiliated with or endorsed by Lospec. The Lospec API and platform are created and maintained by Sam Keddy ([Skeddles](https://github.com/Skeddles)). All credit for Lospec and its API goes to Sam Keddy and the Lospec team.
