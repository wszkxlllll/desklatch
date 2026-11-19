import { copyFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
async function copyAssets(relative) {
  const source = path.join(root, "src", relative);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) await copyAssets(name);
    else if (entry.isFile() && /\.(py|ps1)$/.test(entry.name)) {
      const target = path.join(root, "dist", name);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(source, entry.name), target);
    }
  }
}
await copyAssets("");
