#!/usr/bin/env node
/**
 * Print voice_id values your Retell org actually returns from list-voices.
 * Use this to fix VOICE_SHORTLIST in voiceShortlist.mjs (no public global catalog exists).
 *
 *   cd clara-server && RETELL_API_KEY=... node scripts/list-retell-voices.mjs
 *   npm run list-retell-voices   # uses clara-server/.env if present, else shell env
 */
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const key = process.env.RETELL_API_KEY;
if (!key?.trim()) {
  console.error(
    "Set RETELL_API_KEY (shell env or clara-server/.env). Never commit the key."
  );
  process.exit(1);
}

const res = await fetch("https://api.retellai.com/list-voices", {
  headers: {
    Authorization: `Bearer ${key.trim()}`,
    "Content-Type": "application/json",
  },
});

if (!res.ok) {
  const t = await res.text().catch(() => "");
  console.error("list-voices failed:", res.status, t);
  process.exit(1);
}

const data = await res.json();
const list = Array.isArray(data) ? data : data.voices || [];

const rows = list
  .filter((v) => v?.voice_id)
  .map((v) => ({
    voice_id: v.voice_id,
    voice_name: v.voice_name ?? "",
    provider: v.provider ?? "",
    accent: v.accent ?? "",
    gender: v.gender ?? "",
  }))
  .sort((a, b) =>
    String(a.voice_id).localeCompare(String(b.voice_id), undefined, {
      sensitivity: "base",
    })
  );

const only11 = process.argv.includes("--elevenlabs");
const filtered = only11
  ? rows.filter((r) => String(r.provider).toLowerCase() === "elevenlabs")
  : rows;

console.log(
  only11
    ? "ElevenLabs-backed voices only (--elevenlabs):\n"
    : "All voices from list-voices:\n"
);
console.table(filtered);

console.log(
  "\nJSON (copy voice_id into voiceShortlist.mjs):",
  JSON.stringify(filtered.map((r) => r.voice_id), null, 2)
);
