import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // H6/H7: the root is the default-locale landing, not the retired M0 demo.
  // /fr and /en follow the short-locale URL convention used elsewhere.
  async redirects() {
    return [
      { source: "/", destination: "/fr-CA", permanent: false },
      { source: "/fr", destination: "/fr-CA", permanent: false },
      { source: "/en", destination: "/en-CA", permanent: false },
    ];
  },
};

export default withNextIntl(nextConfig);
