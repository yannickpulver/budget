import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output for the Docker image: a self-contained server bundle
  // with only the traced production dependencies, run via `node server.js`.
  output: "standalone",
  // better-sqlite3 is a native addon — keep it out of the webpack bundle and
  // let Node require it directly from node_modules at runtime. pdf-parse
  // (Swissquote statement import) pulls in pdfjs-dist's worker/canvas code,
  // which has the same bundling problem.
  serverExternalPackages: ["better-sqlite3", "pdf-parse"],
};

export default nextConfig;
