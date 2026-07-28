import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  outputFileTracingRoot: projectRoot,
  output: "standalone",
  poweredByHeader: false,
  experimental: {
    // Turbopack-aware: tree-shake these packages at module level in both
    // Webpack (pages/app fallback) and Turbopack dev server.
    // lucide-react alone accounts for ~280 extra modules per page without this.
    optimizePackageImports: [
      "lucide-react",
      "chart.js",
      "react-chartjs-2",
    ],
    // Critters is opt-in because the inlining pass dominated recent build time.
    // Enable it only for a measured release build with NEXT_OPTIMIZE_CSS=1.
    optimizeCss: process.env.NEXT_OPTIMIZE_CSS === "1",
  },
};

export default nextConfig;
