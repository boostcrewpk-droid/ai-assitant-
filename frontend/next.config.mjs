// Server-side only (no NEXT_PUBLIC_ prefix): the browser never sees or calls this URL.
// The browser calls /api/* on the Vercel domain (same origin = no CORS); Vercel forwards to Render.
const BACKEND_URL = (process.env.BACKEND_URL || "http://localhost:8000").replace(/\/+$/, "");
if (process.env.VERCEL && !process.env.BACKEND_URL) {
  throw new Error("BACKEND_URL is not set. Add it in Vercel -> Settings -> Environment Variables.");
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` },
      { source: "/backend-health", destination: `${BACKEND_URL}/health` },
    ];
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [{ key: "Content-Type", value: "application/manifest+json" }],
      },
    ];
  },
};
export default nextConfig;
