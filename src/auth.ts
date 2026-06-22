import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// Token cache lives in the project root alongside the source.
const TOKEN_CACHE_PATH = path.resolve(import.meta.dirname, "..", ".f1-radio-token");

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

export async function promptForToken(): Promise<string> {
  const token = await ask("Enter your Ascendon token: ");
  if (!token) {
    throw new Error("No token provided");
  }
  return token;
}

/** Returns the cached token, or null if none exists. */
export async function loadCachedToken(): Promise<string | null> {
  try {
    const raw = await readFile(TOKEN_CACHE_PATH, "utf8");
    const token = raw.trim();
    return token || null;
  } catch {
    return null;
  }
}

/** Writes the token to the cache file. */
export async function cacheToken(token: string): Promise<void> {
  await writeFile(TOKEN_CACHE_PATH, token, "utf8");
}

/** Deletes the cache file (silently ignores if missing). */
export async function clearTokenCache(): Promise<void> {
  try {
    await unlink(TOKEN_CACHE_PATH);
  } catch {
    // ignore
  }
}
