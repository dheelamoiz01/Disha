import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  devIndicators: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    const cspHeader = `
      default-src 'self';
      script-src 'self' 'unsafe-eval' 'unsafe-inline';
      style-src 'self' 'unsafe-inline';
      img-src 'self' blob: data: https://*.tile.openstreetmap.org https://tile.openstreetmap.org https://server.arcgisonline.com https://*.arcgisonline.com https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com https://*.google.com https://*.googleapis.com https://*.gstatic.com https://*.googleusercontent.com https://mt0.google.com https://mt1.google.com https://mt2.google.com https://mt3.google.com;
      font-src 'self';
      object-src 'none';
      base-uri 'self';
      form-action 'self';
      frame-ancestors 'none';
      worker-src 'self' blob: data:;
      child-src 'self' blob: data:;
      connect-src 'self' blob: data: https://*.tile.openstreetmap.org https://tile.openstreetmap.org https://server.arcgisonline.com https://*.arcgisonline.com https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com https://*.google.com https://*.googleapis.com https://*.gstatic.com https://*.googleusercontent.com https://mt0.google.com https://mt1.google.com https://mt2.google.com https://mt3.google.com;
    `.replace(/\s{2,}/g, ' ').trim();

    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: cspHeader },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }
        ],
      },
    ];
  }
};

export default nextConfig;
