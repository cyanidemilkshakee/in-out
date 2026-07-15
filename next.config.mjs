import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
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
    // optimizeCss adds critters inlining pass which is slow in dev — disable it.
    // It's useful for prod builds only; enable via `next build` env if needed.
    optimizeCss: false,
  },
};

export default nextConfig;
