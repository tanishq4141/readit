import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";

const monorepoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  output: "export",
  reactCompiler: true,
  turbopack: {
    root: monorepoRoot,
  },
};

export default nextConfig;
