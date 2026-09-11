import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the workspace root so stray lockfiles in parent directories
  // (e.g. ~/package-lock.json) don't confuse module resolution.
  turbopack: {
    root: projectDir,
  },
};

export default nextConfig;
