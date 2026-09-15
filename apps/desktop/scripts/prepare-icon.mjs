import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../web/icon-512.png");
const buildDir = resolve(here, "../build");

await mkdir(buildDir, { recursive: true });
await copyFile(source, resolve(buildDir, "icon.png"));
