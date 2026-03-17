export const config = { runtime: "edge" }


export default async function handler(req: Request) {
    const url = new URL(req.url)
    // extract everything after /api/lospec/
    const path = url.pathname.replace(/^\/api\/lospec\//, "")
    if (!path || path.includes("..")) {
        return new Response("Invalid path", { status: 400 })
    }
    // only allow known Lospec API endpoints for security
    const apiVersion = process.env.LOSPEC_API_VERSION || "api/v1";
    const allowedPaths = [
        // Palettes endpoints
        `${apiVersion}/palettes`,
        `${apiVersion}/palettes/`,  // /palettes/{slug}
        `${apiVersion}/palettes/daily`,
        `${apiVersion}/palettes/random`,
        `${apiVersion}/palettes/suggest`,
        // Daily Tags endpoints
        `${apiVersion}/dailytags`,
        `${apiVersion}/dailytags/`,  // /dailytags/{slug}
        `${apiVersion}/dailytags/daily`,
        // User endpoints
        `${apiVersion}/user`,
        `${apiVersion}/usage`,
        // API system endpoints
        "health"
    ];
    if (!allowedPaths.some(p => path.startsWith(p))) {
        return new Response("Forbidden", { status: 403 });
    }
    // build the target Lospec API endpoint URL
    const target = new URL(`https://api.lospec.com/${path}`)
    target.search = url.search // forward query strings
    // forward request with your API key from environment
    const res = await fetch(target.toString(), {
        headers: {
            Authorization: `Bearer ${process.env.LOSPEC_API_KEY}`,
            "User-Agent": "aseprite-lospec-extension"
        }
    })
    if (!res.ok) {
        return new Response("Lospec request failed", { status: res.status })
    }
    // forward the response with appropriate headers
    return new Response(res.body, {
        status: res.status,
        headers: {
            "Content-Type": res.headers.get("content-type") ?? "application/json",
            "Cache-Control": "public, s-maxage=3600"
        }
    })
}
