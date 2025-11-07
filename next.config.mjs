/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  env: {
    PORT: process.env.PORT || 8080,
  },
  experimental: {
    serverActions: true
  }
};

export default nextConfig;
