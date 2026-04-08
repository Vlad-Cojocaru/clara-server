/**
 * Curated voice IDs for onboarding demos (Retell `voice_id` from Dashboard or GET /list-voices).
 * Order = display order. `displayName` overrides Retell's voice_name for client-facing UI.
 *
 * Clara (retell-Cimo): Retell's default preview clip mentions their product. Set on the server:
 *   VOICE_PREVIEW_CLARA_URL=https://your-cdn/.../clara-demo.mp3
 * Use a short MP3 you generate (same voice / line you want), with no vendor branding in the script.
 *
 * More options: add rows below with real IDs from your account, or rely on backfill (see VOICE_OPTIONS_MIN_TOTAL).
 */
export const VOICE_SHORTLIST = [
  { voiceId: "retell-Cimo", displayName: "Clara" },
  { voiceId: "11labs-Adrian", displayName: "Adrian" },
  { voiceId: "11labs-Emily", displayName: "Emily" },
  { voiceId: "11labs-Jessica", displayName: "Jessica" },
  { voiceId: "11labs-Rachel", displayName: "Rachel" },
  { voiceId: "11labs-Bella", displayName: "Bella" },
];

function parseMinTotal() {
  const n = parseInt(process.env.VOICE_OPTIONS_MIN_TOTAL || "8", 10);
  if (Number.isNaN(n) || n < 1) return 8;
  return Math.min(20, n);
}

/**
 * Preview URL for a shortlist row: env override for Clara, optional per-entry override, else Retell URL.
 * @param {{ voiceId: string; displayName?: string; previewUrlOverride?: string }} entry
 * @param {{ preview_audio_url?: string }} retellVoice
 */
function resolvePreviewUrl(entry, retellVoice) {
  const fromEnv =
    entry.voiceId === "retell-Cimo"
      ? (process.env.VOICE_PREVIEW_CLARA_URL || "").trim()
      : "";
  const fromEntry = (entry.previewUrlOverride || "").trim();
  const custom = fromEntry || fromEnv;
  const fromApi = (retellVoice?.preview_audio_url || "").trim();
  return custom || fromApi;
}

/**
 * @param {Array<{ voice_id: string; voice_name?: string; preview_audio_url?: string }>} retellVoices
 * @returns {Array<{ voiceId: string; displayName: string; previewAudioUrl: string }>}
 */
export function mergeShortlistWithRetell(retellVoices) {
  const list = Array.isArray(retellVoices) ? retellVoices : [];
  const byId = new Map(list.map((v) => [v.voice_id, v]));
  const out = [];
  const used = new Set();

  for (const entry of VOICE_SHORTLIST) {
    const v = byId.get(entry.voiceId);
    if (!v) continue;
    const previewAudioUrl = resolvePreviewUrl(entry, v);
    out.push({
      voiceId: v.voice_id,
      displayName: entry.displayName || v.voice_name || v.voice_id,
      previewAudioUrl,
    });
    used.add(v.voice_id);
  }

  const target = Math.max(out.length, parseMinTotal());
  const candidates = list
    .filter((v) => v.voice_id && !used.has(v.voice_id))
    .filter((v) => (v.preview_audio_url || "").trim())
    .sort((a, b) =>
      String(a.voice_name || a.voice_id).localeCompare(
        String(b.voice_name || b.voice_id),
        undefined,
        { sensitivity: "base" }
      )
    );

  for (const v of candidates) {
    if (out.length >= target) break;
    out.push({
      voiceId: v.voice_id,
      displayName: v.voice_name || v.voice_id,
      previewAudioUrl: (v.preview_audio_url || "").trim(),
    });
    used.add(v.voice_id);
  }

  return out;
}
