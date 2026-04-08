/**
 * Curated voice IDs for onboarding demos (Retell `voice_id` from Dashboard or GET /list-voices).
 * Order = display order. `displayName` overrides Retell's voice_name for client-facing UI.
 */
export const VOICE_SHORTLIST = [
  { voiceId: "retell-Cimo", displayName: "Clara" },
  // Replace with real `voice_id` values from your Retell account (list-voices / dashboard):
  // { voiceId: "retell-…", displayName: "Jordan" },
  // { voiceId: "retell-…", displayName: "Sam" },
];

/**
 * @param {Array<{ voice_id: string; voice_name?: string; preview_audio_url?: string }>} retellVoices
 * @returns {Array<{ voiceId: string; displayName: string; previewAudioUrl: string }>}
 */
export function mergeShortlistWithRetell(retellVoices) {
  const byId = new Map(
    (retellVoices || []).map((v) => [v.voice_id, v])
  );
  const out = [];
  for (const entry of VOICE_SHORTLIST) {
    const v = byId.get(entry.voiceId);
    if (!v) continue;
    out.push({
      voiceId: v.voice_id,
      displayName: entry.displayName || v.voice_name || v.voice_id,
      previewAudioUrl: v.preview_audio_url || "",
    });
  }
  return out;
}
