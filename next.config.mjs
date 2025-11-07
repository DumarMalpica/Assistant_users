/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  env: {
    PORT: process.env.PORT || 8080,
  }
};

export default nextConfig;
