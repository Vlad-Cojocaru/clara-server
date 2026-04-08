/**
 * Curated voice IDs for onboarding demos (Retell `voice_id` from Dashboard or GET /list-voices).
 * Order = display order. `displayName` overrides Retell's voice_name for client-facing UI.
 *
 * Cimo (retell-Cimo): Retell's default preview may mention their product. Optional server env:
 *   VOICE_PREVIEW_CIMO_URL=https://your-cdn/.../cimo-demo.mp3
 *   (falls back to VOICE_PREVIEW_CLARA_URL if set for backwards compatibility)
 *
 * Backfill fills up to VOICE_OPTIONS_MIN_TOTAL (default 8) from list-voices, one card per unique
 * display name. Names in EXCLUDED_DISPLAY_NAMES are never shown (shortlist or backfill).
 */
export const VOICE_SHORTLIST = [
  { voiceId: "retell-Cimo", displayName: "Cimo" },
  { voiceId: "11labs-Emily", displayName: "Emily" },
  { voiceId: "11labs-Jessica", displayName: "Jessica" },
  { voiceId: "11labs-Rachel", displayName: "Rachel" },
  { voiceId: "11labs-Bella", displayName: "Bella" },
  { voiceId: "11labs-Hailey", displayName: "Hailey" },
  { voiceId: "11labs-Grace", displayName: "Grace" },
];

/** Display names (lowercase) never shown */
const EXCLUDED_DISPLAY_NAMES = new Set(["adrian", "alejandro"]);

function parseMinTotal() {
  const n = parseInt(process.env.VOICE_OPTIONS_MIN_TOTAL || "8", 10);
  if (Number.isNaN(n) || n < 1) return 8;
  return Math.min(20, n);
}

function normDisplay(s) {
  return String(s || "").trim().toLowerCase();
}

/**
 * @param {{ voiceId: string; displayName?: string; previewUrlOverride?: string }} entry
 * @param {{ preview_audio_url?: string }} retellVoice
 */
function resolvePreviewUrl(entry, retellVoice) {
  const fromEnv =
    entry.voiceId === "retell-Cimo"
      ? (process.env.VOICE_PREVIEW_CIMO_URL || process.env.VOICE_PREVIEW_CLARA_URL || "").trim()
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
  const usedIds = new Set();
  const usedDisplayNames = new Set();

  function addVoice(voiceId, displayName, previewAudioUrl) {
    const nameKey = normDisplay(displayName);
    if (!nameKey || EXCLUDED_DISPLAY_NAMES.has(nameKey) || usedDisplayNames.has(nameKey))
      return false;
    usedDisplayNames.add(nameKey);
    out.push({
      voiceId,
      displayName: String(displayName).trim() || voiceId,
      previewAudioUrl: previewAudioUrl || "",
    });
    usedIds.add(voiceId);
    return true;
  }

  for (const entry of VOICE_SHORTLIST) {
    const v = byId.get(entry.voiceId);
    if (!v) continue;
    const previewAudioUrl = resolvePreviewUrl(entry, v);
    const label = entry.displayName || v.voice_name || v.voice_id;
    addVoice(v.voice_id, label, previewAudioUrl);
  }

  const target = Math.max(out.length, parseMinTotal());
  const candidates = list
    .filter((v) => v.voice_id && !usedIds.has(v.voice_id))
    .filter((v) => (v.preview_audio_url || "").trim())
    .filter((v) => !EXCLUDED_DISPLAY_NAMES.has(normDisplay(v.voice_name)))
    .sort((a, b) =>
      String(a.voice_name || a.voice_id).localeCompare(
        String(b.voice_name || b.voice_id),
        undefined,
        { sensitivity: "base" }
      )
    );

  for (const v of candidates) {
    if (out.length >= target) break;
    const label = v.voice_name || v.voice_id;
    if (EXCLUDED_DISPLAY_NAMES.has(normDisplay(label))) continue;
    addVoice(v.voice_id, label, (v.preview_audio_url || "").trim());
  }

  return out;
}
