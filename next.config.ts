import type { NextConfig } from 'next';

// セキュリティヘッダー（CSP / HSTS 等）は Phase 2 で追加する（実装Todo P2-01）。
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;