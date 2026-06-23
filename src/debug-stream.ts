/**
 * debug-stream.ts
 * Fetches one manifest + one segment and dumps diagnostics.
 *
 * Usage:
 *   pnpm debug-stream --content-id 1000010177 --channel-id 1007 [--seg 94] [--platform BIG_SCREEN_HLS]
 *
 * Writes:
 *   /tmp/f1-debug-manifest.xml   -- raw MPD or m3u8
 *   /tmp/f1-debug-init.mp4       -- init segment (if DASH)
 *   /tmp/f1-debug-seg.mp4        -- one media segment (if DASH)
 *   /tmp/f1-debug-concat.mp4     -- init+seg concatenated (for ffprobe)
 */

import fs from "node:fs/promises";
import process from "node:process";
import { cacheToken, clearTokenCache, loadCachedToken, promptForToken } from "./auth.js";
import { buildSegmentUrl, parseManifest } from "./dash.js";
import { fetchEntitlementToken, fetchStreamUrl } from "./f1api.js";
import { downloadInit, downloadSegment } from "./segments.js";
import { spawn } from "node:child_process";

// ---- CLI args ---------------------------------------------------------------

interface DebugArgs {
  contentId: number;
  channelId: number;
  segNumber: number;
  platform: string;
}

function parseArgs(): DebugArgs {
  const argv = process.argv.slice(2);
  const args: DebugArgs = {
    contentId: 0,
    channelId: 0,
    segNumber: 94, // ~9 minutes in (9*60/5.76 ≈ 94)
    platform: "BIG_SCREEN_HLS",
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case "--content-id": args.contentId = Number(next); i++; break;
      case "--channel-id": args.channelId = Number(next); i++; break;
      case "--seg": args.segNumber = Number(next); i++; break;
      case "--platform": args.platform = next; i++; break;
    }
  }

  if (!args.contentId || !args.channelId) {
    console.error("Usage: pnpm debug-stream --content-id N --channel-id N [--seg N] [--platform STR]");
    process.exit(1);
  }

  return args;
}

// ---- Hex dump first N bytes -------------------------------------------------

function hexDump(buf: Buffer, n = 64): string {
  const slice = buf.subarray(0, n);
  const hex = Array.from(slice).map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const ascii = Array.from(slice).map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
  return `${hex}\n  ASCII: ${ascii}`;
}

// ---- Detect content protection in raw XML -----------------------------------

function checkDrm(xml: string): void {
  if (xml.includes("ContentProtection")) {
    console.log("  [DRM] ContentProtection elements FOUND in manifest -- segments are likely encrypted");
    // Extract scheme IDs
    const matches = [...xml.matchAll(/schemeIdUri="([^"]+)"/g)];
    const schemes = [...new Set(matches.map((m) => m[1]))];
    console.log("  [DRM] Scheme IDs:", schemes.filter((s) => s.includes("widevine") || s.includes("cenc") || s.includes("clearkey") || s.includes("playready")));
  } else {
    console.log("  [DRM] No ContentProtection elements found -- stream appears unencrypted");
  }
}

// ---- Run ffprobe on a file --------------------------------------------------

function ffprobe(filePath: string): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", ["-v", "quiet", "-show_streams", "-show_format", filePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    proc.once("close", () => {
      console.log(out.trim());
      resolve();
    });
    proc.once("error", () => resolve());
  });
}

// ---- Patch fetchStreamUrl to use alternate platform -------------------------

async function fetchStreamUrlWithPlatform(
  ascendonToken: string,
  entitlementToken: string,
  contentId: number,
  channelId: number,
  platform: string,
): Promise<string> {
  // The PLAY endpoint path has BIG_SCREEN_HLS hard-coded; we re-implement here with a variable platform.
  const base = `https://f1tv.formula1.com/2.0/R/ENG/${platform}/ALL/CONTENT/PLAY`;
  const url = new URL(base);
  url.searchParams.set("contentId", String(contentId));
  url.searchParams.set("channelId", String(channelId));

  const res = await fetch(url, {
    headers: {
      ascendontoken: ascendonToken,
      entitlementtoken: entitlementToken,
    },
  });

  if (!res.ok) {
    throw new Error(`PLAY API HTTP ${res.status} for platform ${platform}`);
  }

  const json = (await res.json()) as { resultObj?: { url?: string }; message?: string };
  if (!json.resultObj?.url) {
    throw new Error(`No URL in response: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.resultObj.url;
}

// ---- Main -------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();

  // Auth
  let ascendonToken: string;
  let entitlementToken: string;

  const cached = await loadCachedToken();
  if (cached) {
    try {
      entitlementToken = await fetchEntitlementToken(cached);
      ascendonToken = cached;
    } catch {
      console.warn("Cached token invalid. Re-enter.");
      await clearTokenCache();
      ascendonToken = await promptForToken();
      entitlementToken = await fetchEntitlementToken(ascendonToken);
      await cacheToken(ascendonToken);
    }
  } else {
    ascendonToken = await promptForToken();
    entitlementToken = await fetchEntitlementToken(ascendonToken);
    await cacheToken(ascendonToken);
  }

  console.log(`\n=== debug-stream ===`);
  console.log(`contentId: ${args.contentId}  channelId: ${args.channelId}  seg: ${args.segNumber}  platform: ${args.platform}`);

  // 1. Fetch stream URL
  console.log(`\n[1] Fetching stream URL via ${args.platform}...`);
  const streamUrl = await fetchStreamUrlWithPlatform(
    ascendonToken, entitlementToken, args.contentId, args.channelId, args.platform,
  );
  console.log(`  Stream URL: ${streamUrl}`);

  // 2. Detect format from URL
  const isHls = streamUrl.includes(".m3u8");
  const isDash = streamUrl.includes(".mpd") || (!isHls);
  console.log(`  Detected format: ${isHls ? "HLS (m3u8)" : "DASH (mpd)"}`);

  // 3. Fetch manifest
  console.log(`\n[2] Fetching manifest...`);
  const manifestRes = await fetch(streamUrl);
  if (!manifestRes.ok) throw new Error(`Manifest HTTP ${manifestRes.status}`);
  const manifestText = await manifestRes.text();

  const manifestPath = "/tmp/f1-debug-manifest.xml";
  await fs.writeFile(manifestPath, manifestText, "utf8");
  console.log(`  Saved to ${manifestPath} (${manifestText.length} bytes)`);
  console.log(`  First 300 chars: ${manifestText.slice(0, 300).replace(/\n/g, " ")}`);

  // 4. DRM check
  console.log(`\n[3] DRM check...`);
  checkDrm(manifestText);

  if (isHls) {
    console.log("\n  [HLS stream -- DASH segment download skipped]");
    console.log("  Inspect /tmp/f1-debug-manifest.xml to find audio segment URLs.");
    return;
  }

  // 5. Parse DASH manifest
  console.log(`\n[4] Parsing DASH manifest (looking for 'tea' audio track)...`);
  let manifest: { initUrl: string; mediaTemplate: string; baseUrl: string };
  try {
    manifest = parseManifest(manifestText, streamUrl);
    console.log(`  initUrl: ${manifest.initUrl}`);
    console.log(`  mediaTemplate: ${manifest.mediaTemplate}`);
  } catch (err) {
    console.error(`  Parse error: ${err instanceof Error ? err.message : String(err)}`);
    console.log("  (Check the manifest XML manually)");
    return;
  }

  // 6. Download init segment
  console.log(`\n[5] Downloading init segment...`);
  const initBuf = await downloadInit(manifest.initUrl);
  const initPath = "/tmp/f1-debug-init.mp4";
  await fs.writeFile(initPath, initBuf);
  console.log(`  ${initBuf.length} bytes  saved to ${initPath}`);
  console.log(`  First bytes:\n  ${hexDump(initBuf)}`);

  // 7. Download one media segment
  const segUrl = buildSegmentUrl(manifest.mediaTemplate, args.segNumber);
  console.log(`\n[6] Downloading segment ${args.segNumber}...`);
  console.log(`  URL: ${segUrl}`);
  const segBuf = await downloadSegment(segUrl);
  const segPath = "/tmp/f1-debug-seg.mp4";
  await fs.writeFile(segPath, segBuf);
  console.log(`  ${segBuf.length} bytes  saved to ${segPath}`);
  console.log(`  First bytes:\n  ${hexDump(segBuf)}`);

  // 8. Concatenate and ffprobe
  const concatBuf = Buffer.concat([initBuf, segBuf]);
  const concatPath = "/tmp/f1-debug-concat.mp4";
  await fs.writeFile(concatPath, concatBuf);
  console.log(`\n[7] ffprobe on init+seg concat (${concatBuf.length} bytes):`);
  await ffprobe(concatPath);

  console.log(`\n=== Done ===`);
  console.log(`Files: ${manifestPath}  ${initPath}  ${segPath}  ${concatPath}`);
  console.log(`To listen: ffplay -f s16le -ar 48000 <(ffmpeg -i ${concatPath} -ar 48000 -f s16le -)`);
  console.log(`To try WEB_HLS platform: pnpm debug-stream --content-id ${args.contentId} --channel-id ${args.channelId} --platform WEB_HLS`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
