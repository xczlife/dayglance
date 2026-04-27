import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export async function readText(filePath, fallback = null) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

export async function writeTextAtomic(filePath, text) {
  await ensureDir(path.dirname(filePath));
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp`);
  await fs.writeFile(tempPath, text, "utf8");
  await fs.rename(tempPath, filePath);
}

export async function writeJsonAtomic(filePath, value) {
  await writeTextAtomic(filePath, JSON.stringify(value, null, 2));
}
