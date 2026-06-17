import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.dirname(path.dirname(__filename));
const sourceDir = path.join(rootDir, "public");
const outputDir = path.join(rootDir, "dist");

await rm(outputDir, { recursive: true, force: true });
await cp(sourceDir, outputDir, { recursive: true });

console.log("Built Cloudflare Pages assets into dist/");
