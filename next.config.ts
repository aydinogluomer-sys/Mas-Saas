import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No dev overlay indicator — keeps visual-regression screenshots deterministic.
  devIndicators: false,
};

export default nextConfig;
