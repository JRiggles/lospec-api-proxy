# Lospec API Proxy
*Version 0.0.1*

This project provides a proxy endpoint for the [Lospec API](https://api.lospec.com/docs), designed to be used in edge environments (e.g., Vercel Edge Functions).

## Features
- Restricts access to known Lospec API endpoints for safety
- Forwards requests to Lospec API with your API key
- Supports environment-based configuration for API version and key

## Usage
### Environment Variables
- `LOSPEC_API_KEY`: Your Lospec API key (required, see [Getting an API Key](https://api.lospec.com/docs/#description/getting-an-api-key) for details)
- `LOSPEC_API_VERSION`: API version prefix (optional, defaults to `api/v1`, which is the only version presently available)

### Endpoint
Proxy requests to `/api/lospec/{path}`. Only allowed paths are forwarded.

## Example
```
GET /api/lospec/api/v1/palettes/daily
```
