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
    // Kong's local listener is exposed on :1008 while its internal host
    // value is forwarded without the port. Allow the browser origin used by
    // the local reverse proxy for Auth.js/Server Actions. Deployments can
    // override this with a comma-separated list of host:port values.
    serverActions: {
      allowedOrigins: (
        process.env.NEXT_SERVER_ACTION_ALLOWED_ORIGINS ||
        "localhost:1008,127.0.0.1:1008"
      )
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    },
  },
};

export default nextConfig;
