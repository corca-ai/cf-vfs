import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

// Replays write JSON; retained large results are compressed after completion.
export async function readResult(url) {
  try {
    return JSON.parse(await readFile(url, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return JSON.parse(gunzipSync(await readFile(new URL(`${url.href}.gz`))).toString());
  }
}
