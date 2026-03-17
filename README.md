# Lospec API Proxy
*Version 0.0.1*

This project provides a proxy endpoint for the [Lospec API](https://api.lospec.com/docs), designed specifically for deployment on Vercel Edge Functions.

**Purpose:**
This proxy allows users to make authenticated requests to the Lospec API from environments that otherwise wouldn't support direct authentication, or would require hardcoding API keys into client apps. By deploying this proxy, you can securely access Lospec API features without exposing your API key or relying on unsupported platforms.

## Features
- Restricts access to known Lospec API endpoints for safety
- Forwards requests to Lospec API with your API key
- Supports environment-based configuration for API version and key

## Usage
### Environment Variables (Vercel)

**Required:**
- `LOSPEC_API_KEY`: Your Lospec API key. Must be set for the proxy to work. [Get your API key here.](https://api.lospec.com/docs/#description/getting-an-api-key)

**Optional:**
- `LOSPEC_API_VERSION`: API version prefix (default: `v1` - this is the latest version).
- `ENABLE_UA_FILTER`: Set to `true` to require a specific User-Agent header (default: `false`).
- `REQUIRED_USER_AGENT`: If `ENABLE_UA_FILTER` is `true`, requests must use this User-Agent value.
- `ENABLE_CACHING`: Set to `true` to enable response caching (default: `true`).
- `CACHE_DURATION`: Cache TTL in seconds (default: `3600`).
- `FETCH_TIMEOUT_MS`: Upstream fetch timeout in milliseconds (default: `5000`).

Set these variables in your Vercel project dashboard under "Environment Variables".

For local development, copy [.env.example](./.env.example) to `.env` and set your `LOSPEC_API_KEY`.

### Endpoint
Proxy requests to `/api/lospec/{path}`. Only valid Lospec API endpoints are forwarded.
See the [Lospec API Docs](https://api.lospec.com/docs) for a list of endpoints.

# Acknowledgments
This project is not affiliated with or endorsed by Lospec. The Lospec API and platform are created and maintained by Sam Keddy ([Skeddles](https://github.com/Skeddles)). All credit for Lospec and its API goes to Sam Keddy and the Lospec team.
