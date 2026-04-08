/**
 * Curated voice IDs for onboarding demos (Retell `voice_id` from Dashboard or GET /list-voices).
 * There is no public global catalog: IDs must match what *your* Retell API key returns.
 * Run: `npm run list-retell-voices` (RETELL_API_KEY in env) to dump real `voice_id`s.
 * Order = display order. `displayName` overrides Retell's voice_name for client-facing UI.
 *
 * Cimo (retell-Cimo): optional custom preview (Retell’s default clip may mention their product):
 *   VOICE_PREVIEW_CIMO_URL=…  (or VOICE_PREVIEW_CLARA_URL)
 *
 * **Backfill (off by default):** Only voices in VOICE_SHORTLIST are returned unless you set
 *   VOICE_OPTIONS_MIN_TOTAL=N   (e.g. 10)
 * on the server. Then we add more voices from Retell’s full list-voices until N cards exist
 * (one per display name). That’s why you used to see random/extra names — it was padding the list.
 * Keep it unset (or 0) so clients only see this curated list.
 *
 * EXCLUDED_BACKFILL_NAMES: block names from backfill only (e.g. Adrian / Alejandro if backfill on).
 */
export const VOICE_SHORTLIST = [
  { voiceId: "retell-Cimo", displayName: "Cimo" },
  { voiceId: "11labs-Josh", displayName: "Josh" },
  { voiceId: "11labs-Arnold", displayName: "Arnold" },
  { voiceId: "11labs-Sam", displayName: "Sam" },
  { voiceId: "11labs-Emily", displayName: "Emily" },
  { voiceId: "11labs-Jessica", displayName: "Jessica" },
  { voiceId: "11labs-Rachel", displayName: "Rachel" },
  { voiceId: "11labs-Bella", displayName: "Bella" },
  { voiceId: "11labs-Hailey", displayName: "Hailey" },
  { voiceId: "11labs-Grace", displayName: "Grace" },
];

/** Blocked from backfill only (shortlist rows are never filtered by this) */
const EXCLUDED_BACKFILL_NAMES = new Set(["adrian", "alejandro"]);

/**
 * Shortlist `voiceId`s absent from Retell `list-voices` (org may not expose that preset, or id casing/name changed).
 * Exposed on GET …/voice-options as `shortlistMissingVoiceIds` for debugging.
 */
export function missingShortlistVoiceIds(retellVoices) {
  const list = Array.isArray(retellVoices) ? retellVoices : [];
  const ids = new Set(list.map((v) => v.voice_id).filter(Boolean));
  return VOICE_SHORTLIST.filter((e) => !ids.has(e.voiceId)).map((e) => e.voiceId);
}

function parseMinTotal() {
  const raw = process.env.VOICE_OPTIONS_MIN_TOTAL;
  if (raw === undefined || String(raw).trim() === "") return 0;
  const n = parseInt(String(raw), 10);
  if (Number.isNaN(n) || n < 1) return 0;
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
    if (!nameKey || usedDisplayNames.has(nameKey)) return false;
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

  const minExtra = parseMinTotal();
  const target = minExtra > 0 ? Math.max(out.length, minExtra) : out.length;
  const candidates = list
    .filter((v) => v.voice_id && !usedIds.has(v.voice_id))
    .filter((v) => (v.preview_audio_url || "").trim())
    .filter((v) => !EXCLUDED_BACKFILL_NAMES.has(normDisplay(v.voice_name)))
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
    if (EXCLUDED_BACKFILL_NAMES.has(normDisplay(label))) continue;
    addVoice(v.voice_id, label, (v.preview_audio_url || "").trim());
  }

  return out;
}
