import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ...(process.env.NODE_ENV === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }] : []),
    ] }];
  },
  // CT920 shares one user.slice task limit (4096) across every agent and
  // service; a default build (one worker per core, each with its own thread
  // pool) hit "OS can't spawn worker thread" there. NEXT_BUILD_CPUS caps the
  // build workers where needed; unset (CI, laptops) keeps Next's default.
  experimental: {
    // Proxy buffers multipart requests before the route applies its 25 MiB file cap.
    proxyClientMaxBodySize: 28 * 1024 * 1024,
    ...(process.env.NEXT_BUILD_CPUS ? { cpus: Number(process.env.NEXT_BUILD_CPUS) } : {}),
  },
  // H6/H7: the root is the default-locale landing, not the retired M0 demo.
  // /fr and /en follow the short-locale URL convention used elsewhere.
  // Using rewrites() instead of redirects() for the root path to ensure
  // the Railway healthcheck gets an HTTP 200 OK.
  async rewrites() {
    return [
      { source: "/", destination: "/fr-CA" },
    ];
  },
  async redirects() {
    return [
      { source: "/fr", destination: "/fr-CA", permanent: false },
      { source: "/en", destination: "/en-CA", permanent: false },
    ];
  },
};

export default withNextIntl(nextConfig);
