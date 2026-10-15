// Prévisions d'ensemble (cahier : piste V2 « dispersion réelle »). Un seul appel à l'API d'ensemble d'Open-Meteo,
// plusieurs modèles, des dizaines de scénarios par modèle. On en tire une médiane, une fourchette et des probabilités.
// Ce sont des scénarios BRUTS, non calibrés ; ce n'est pas la prévision d'un modèle précis.

const ENSEMBLE_URL = "https://ensemble-api.open-meteo.com/v1/ensemble";
export const ENSEMBLE_FIRST_DAY = 4; // J+4 : début de la fourchette
export const ENSEMBLE_MEDIAN_FROM = 8; // J+8 : la médiane remplace la valeur d'un seul scénario
export const WET_MM = 1; // « pluie » dans les scénarios = au moins 1 mm sur le jour

// suffix : fin des noms de colonnes renvoyés par l'API ; chaque modèle pèse autant, quel que soit son nombre de scénarios.
export const ENSEMBLE_MODELS = [
  { id: "ecmwf_ifs025", suffix: "ecmwf_ifs025_ensemble", label: "ECMWF IFS" },
  { id: "ecmwf_aifs025", suffix: "ecmwf_aifs025_ensemble", label: "ECMWF AIFS" },
  { id: "gfs_seamless", suffix: "ncep_gefs_seamless", label: "GFS (NOAA)" },
  { id: "gem_global", suffix: "gem_global_ensemble", label: "GEM (ECCC)" },
];
const VARS = { tmax: "temperature_2m_max", tmin: "temperature_2m_min", precip: "precipitation_sum" };
const MIN_MEMBERS = 5; // en dessous, un modèle n'est pas retenu pour ce jour

export class EnsembleError extends Error {
  constructor(kind, message) { super(message); this.name = "EnsembleError"; this.kind = kind; }
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// Quantile pondéré (interpolation par paliers : plus petite valeur dont le poids cumulé atteint q).
export function weightedQuantile(items, q) {
  const pts = items.filter((p) => isNum(p.value) && p.weight > 0).sort((a, b) => a.value - b.value);
  if (!pts.length) return null;
  const total = pts.reduce((s, p) => s + p.weight, 0);
  let acc = 0;
  for (const p of pts) { acc += p.weight; if (acc / total >= q - 1e-9) return p.value; }
  return pts[pts.length - 1].value;
}
const weightedMean = (items) => {
  const pts = items.filter((p) => isNum(p.value) && p.weight > 0);
  const total = pts.reduce((s, p) => s + p.weight, 0);
  return total ? pts.reduce((s, p) => s + p.value * p.weight, 0) / total : null;
};

// Valeurs par modèle pour un jour : { modelId: [valeurs des scénarios] }
function perModel(raw, variable, dayIndex) {
  const out = {};
  for (const m of ENSEMBLE_MODELS) {
    const vals = [];
    const base = `${variable}_`;
    for (const [key, col] of Object.entries(raw.daily)) {
      if (!key.startsWith(base) || !key.endsWith(`_${m.suffix}`)) continue;
      const middle = key.slice(base.length, key.length - m.suffix.length - 1); // "member07" ou "" (contrôle)
      if (middle !== "" && !/^member\d+$/.test(middle)) continue;
      const v = col?.[dayIndex];
      if (isNum(v)) vals.push(v);
    }
    if (vals.length >= MIN_MEMBERS) out[m.id] = vals;
  }
  return out;
}
// Chaque modèle pèse 1 ; ses scénarios se partagent ce poids.
const weighted = (byModel) => Object.values(byModel).flatMap((vals) => vals.map((value) => ({ value, weight: 1 / vals.length })));

export function spreadLabel(widthC) {
  if (!isNum(widthC)) return null;
  if (widthC < 4) return "faible";
  if (widthC <= 8) return "moyenne";
  return "forte";
}

// Résumé d'un jour à partir de la réponse brute (colonnes quotidiennes par scénario).
export function summarizeDay(raw, dayIndex) {
  const tmaxBy = perModel(raw, VARS.tmax, dayIndex), tminBy = perModel(raw, VARS.tmin, dayIndex), prBy = perModel(raw, VARS.precip, dayIndex);
  const tmax = weighted(tmaxBy), tmin = weighted(tminBy), pr = weighted(prBy);
  if (!tmax.length && !pr.length) return null;
  const q = (items, p) => weightedQuantile(items, p);
  const wetTotal = pr.reduce((s, p) => s + p.weight, 0);
  const usedModels = [...new Set([...Object.keys(tmaxBy), ...Object.keys(prBy)])];
  const count = (by) => Object.values(by).reduce((n, v) => n + v.length, 0);
  const nMembers = count(tmaxBy) || count(prBy); // scénarios retenus (selon les températures, sinon la pluie)
  const width = isNum(q(tmax, 0.9)) && isNum(q(tmax, 0.1)) ? q(tmax, 0.9) - q(tmax, 0.1) : null;
  return {
    models: usedModels, nModels: usedModels.length, nMembers,
    tmax: tmax.length ? { median: q(tmax, 0.5), p10: q(tmax, 0.1), p90: q(tmax, 0.9) } : null,
    tmin: tmin.length ? { median: q(tmin, 0.5), p10: q(tmin, 0.1), p90: q(tmin, 0.9) } : null,
    precip: pr.length ? { mean: weightedMean(pr), p90: q(pr, 0.9), probWet: wetTotal ? pr.filter((p) => p.value >= WET_MM).reduce((s, p) => s + p.weight, 0) / wetTotal : null } : null,
    spreadC: width, spread: spreadLabel(width),
  };
}

export function buildEnsembleUrl(place, startDate, endDate) {
  const q = new URLSearchParams({
    latitude: place.latitude, longitude: place.longitude, timezone: place.timezone,
    start_date: startDate, end_date: endDate, models: ENSEMBLE_MODELS.map((m) => m.id).join(","),
    daily: Object.values(VARS).join(","),
  });
  return `${ENSEMBLE_URL}?${q}`;
}

// dates : dates locales (YYYY-MM-DD) de J à J+14, telles que renvoyées par la prévision principale.
export function summarizeEnsemble(raw, dates) {
  if (!raw?.daily?.time) throw new EnsembleError("format", "Réponse d'ensemble incomplète");
  const days = {};
  raw.daily.time.forEach((date, i) => {
    if (!dates.includes(date)) return;
    const s = summarizeDay(raw, i);
    if (s) days[date] = s;
  });
  return days;
}

// Récupère les scénarios de J+4 à J+14. Ne lève jamais : toute erreur devient { status: "unavailable" }.
export async function fetchEnsemble(place, dates, { fetchImpl = fetch, timeoutMs = 12000, now = new Date() } = {}) {
  const wanted = dates.slice(ENSEMBLE_FIRST_DAY);
  if (wanted.length === 0) return { status: "unavailable", reason: "Aucune date à couvrir." };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let res;
    try { res = await fetchImpl(buildEnsembleUrl(place, wanted[0], wanted[wanted.length - 1]), { signal: ctl.signal }); }
    catch (e) { return { status: "unavailable", reason: `Scénarios inaccessibles (${e.name === "AbortError" ? "délai dépassé" : e.message}).` }; }
    if (!res.ok) return { status: "unavailable", reason: `Le service d'ensemble a répondu HTTP ${res.status}.` };
    let raw;
    try { raw = await res.json(); } catch { return { status: "unavailable", reason: "Réponse d'ensemble illisible." }; }
    let days;
    try { days = summarizeEnsemble(raw, wanted); } catch (e) { return { status: "unavailable", reason: e.message }; }
    if (!Object.keys(days).length) return { status: "unavailable", reason: "Aucun scénario exploitable." };
    const models = ENSEMBLE_MODELS.filter((m) => Object.values(days).some((d) => d.models.includes(m.id)));
    return { status: "ok", days, models, fetchedAt: now.toISOString() };
  } finally { clearTimeout(timer); }
}
