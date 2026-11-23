// Pression MESURÉE : dernier message METAR (observation d'aviation) de la station la plus proche, lu via l'Iowa Environmental Mesonet
// (domaine public, attribution souhaitée). La position de l'utilisateur ne quitte pas l'appareil pour cet appel : on ne demande que la liste
// des stations d'un pays, et la plus proche est choisie ici. Rien n'est inventé : sans station proche et récente, l'appelant garde la valeur du modèle.

import { timed, seconds, TIMEOUTS } from "./net.js?v=26ccf5e2";

const IEM_URL = "https://mesonet.agron.iastate.edu/api/1/currents.json";
export const OBS_MAX_KM = 100;                 // au-delà, la pression d'une station n'est plus celle d'ici
export const OBS_MAX_AGE_MS = 3 * 60 * 60 * 1000; // un METAR a une heure ; au-delà de 3 h, la station est considérée muette
export const OBS_CACHE_MS = 10 * 60 * 1000;
const INHG_TO_HPA = 33.8639;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export class ObsError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180, dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// QNH en hPa : « Q1013 » du message METAR (valeur telle que publiée), sinon l'altimètre en pouces de mercure converti.
export function qnhHpa(row) {
  const m = /\bQ(\d{4})\b/.exec(typeof row?.raw === "string" ? row.raw : "");
  if (m) { const v = Number(m[1]); if (v >= 850 && v <= 1100) return v; }
  return isNum(row?.alti) && row.alti > 25 && row.alti < 32.5 ? Math.round(row.alti * INHG_TO_HPA) : null;
}

// Station la plus proche qui a une pression récente, dans la limite de distance ; null sinon.
export function pickStation(rows, lat, lon, { now = Date.now(), maxKm = OBS_MAX_KM, maxAgeMs = OBS_MAX_AGE_MS } = {}) {
  const found = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!isNum(r?.lat) || !isNum(r?.lon) || typeof r.station !== "string") continue;
    const hpa = qnhHpa(r), at = Date.parse(r.utc_valid);
    if (hpa === null || !Number.isFinite(at) || now - at > maxAgeMs || at - now > 10 * 60 * 1000) continue;
    const km = distanceKm(lat, lon, r.lat, r.lon);
    if (km <= maxKm) found.push({ station: r.station, name: typeof r.name === "string" ? r.name : r.station, km, hpa, at });
  }
  found.sort((a, b) => a.km - b.km);
  return found[0] ?? null;
}

const cache = new Map();
// Dernières observations d'un pays (réseau « FR__ASOS » pour la France), gardées 10 minutes : une seule lecture sert à la pression
// et aux orages observés. Les pays à réseaux par région (Canada, États-Unis…) ne sont pas couverts.
async function networkRows(countryCode, { fetchImpl, now, timeoutMs }) {
  if (!/^[A-Z]{2}$/.test(countryCode ?? "")) throw new ObsError("country", "Pays inconnu : pas de réseau de stations à interroger.");
  const network = `${countryCode}__ASOS`;
  let rows = cache.get(network);
  if (!rows || now - rows.at > OBS_CACHE_MS) {
    // Délai court : la vue « Lieu actuel » attend cette mesure ; sans réponse à temps, elle garde la valeur du modèle (« ≈ »).
    const body = await timed(timeoutMs, async (signal) => {
      let res;
      try { res = await fetchImpl(`${IEM_URL}?${new URLSearchParams({ network })}`, { signal }); } catch (e) { throw new ObsError("network", `Stations indisponibles (réseau) : ${e.message}`); }
      if (!res.ok) throw new ObsError("http", `Le service des stations a répondu HTTP ${res.status}`);
      try { return await res.json(); } catch { throw new ObsError("format", "Réponse du service des stations illisible"); }
    }, () => new ObsError("timeout", `Le service des stations ne répond pas (aucune réponse en ${seconds(timeoutMs)})`));
    if (!Array.isArray(body?.data)) throw new ObsError("format", "Réponse du service des stations inattendue");
    rows = { at: now, data: body.data };
    cache.set(network, rows);
  }
  return rows.data;
}
export async function fetchObservedPressure({ latitude, longitude, countryCode }, { fetchImpl = fetch, now = Date.now(), timeoutMs = TIMEOUTS.pressure } = {}) {
  const data = await networkRows(countryCode, { fetchImpl, now, timeoutMs });
  const best = pickStation(data, latitude, longitude, { now });
  if (!best) throw new ObsError("none", `Aucune station avec une mesure récente à moins de ${OBS_MAX_KM} km.`);
  return best;
}

// ── Tendance sur 3 heures (23/11/2026) ───────────────────────────────────────────────────────────────────────────────────────
// Pression mesurée par la MÊME station environ 3 h plus tôt. Les stations européennes et japonaises donnent le QNH au hPa entier : un
// écart affiché de 1 hPa peut n'être presque rien, il est donc dit « à peu près stable ». Sans relevé à l'heure voulue : pas de tendance.
const IEM_HISTORY_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py";
export const TREND_MS = 3 * 60 * 60 * 1000;
export const TREND_TOLERANCE_MS = 30 * 60 * 1000; // relevé retenu : entre 2 h 30 et 3 h 30 avant le dernier
export const TREND_MIN_HPA = 2;                   // en dessous : « à peu près stable »

// Réponse CSV « station,valid,alti,metar » (heures UTC) → [{ at, hpa }], lignes illisibles ignorées.
export function parseHistory(csv, station) {
  const out = [];
  for (const line of String(csv ?? "").split(/\r?\n/)) {
    const m = /^([^,]+),(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}),([^,]*),(.*)$/.exec(line);
    if (!m || m[1] !== station) continue;
    const at = Date.parse(`${m[2]}T${m[3]}:00Z`), alti = Number.parseFloat(m[4]);
    const hpa = qnhHpa({ raw: m[5], alti: Number.isFinite(alti) ? alti : null });
    if (Number.isFinite(at) && hpa !== null) out.push({ at, hpa });
  }
  return out;
}
// Relevé le plus proche de « 3 h avant » ; null si aucun dans la tolérance.
export function pressureTrend(observed, history) {
  if (!observed || !isNum(observed.hpa) || !isNum(observed.at)) return null;
  const target = observed.at - TREND_MS;
  let past = null;
  for (const h of Array.isArray(history) ? history : []) {
    const gap = Math.abs(h.at - target);
    if (gap <= TREND_TOLERANCE_MS && (!past || gap < Math.abs(past.at - target))) past = h;
  }
  if (!past) return null;
  const delta = observed.hpa - past.hpa;
  return { hpa: past.hpa, at: past.at, delta, dir: delta >= TREND_MIN_HPA ? "up" : delta <= -TREND_MIN_HPA ? "down" : "steady" };
}
const historyCache = new Map();
// Tendance de la station déjà choisie, ou null (relevé absent) ; lève ObsError si le service est illisible.
export async function fetchPressureTrend(observed, { fetchImpl = fetch, now = Date.now(), timeoutMs = TIMEOUTS.pressure } = {}) {
  if (!observed || !/^[A-Z0-9]{3,8}$/.test(observed.station)) return null;
  const key = `${observed.station}|${observed.at}`;
  let hit = historyCache.get(key);
  if (!hit || now - hit.at > OBS_CACHE_MS) {
    const hours = Math.min(12, Math.ceil((now - observed.at + TREND_MS + TREND_TOLERANCE_MS) / 3600000) + 1);
    const q = `station=${observed.station}&data=alti&data=metar&hours=${hours}&tz=Etc/UTC&format=onlycomma&latlon=no&missing=null&trace=null&direct=no&report_type=3&report_type=4`;
    const csv = await timed(timeoutMs, async (signal) => {
      let res;
      try { res = await fetchImpl(`${IEM_HISTORY_URL}?${q}`, { signal }); } catch (e) { throw new ObsError("network", `Historique de la station indisponible (réseau) : ${e.message}`); }
      if (!res.ok) throw new ObsError("http", `Le service des stations a répondu HTTP ${res.status}`);
      return res.text();
    }, () => new ObsError("timeout", `Le service des stations ne répond pas (aucune réponse en ${seconds(timeoutMs)})`));
    hit = { at: now, history: parseHistory(csv, observed.station) };
    historyCache.set(key, hit);
  }
  return pressureTrend(observed, hit.history);
}
export const TREND_WORD = { up: "en hausse", down: "en baisse", steady: "à peu près stable" };
// « En hausse : +2 hPa depuis 16:00 (1023 hPa). » ; « À peu près stable depuis 16:00 (1024 hPa). »
export function trendText(trend, fmtTime) {
  if (!trend) return null;
  const since = `depuis ${fmtTime(trend.at)} (${trend.hpa}\u00a0hPa)`;
  if (trend.dir === "steady") return `À peu près stable ${since}.`;
  return `${trend.dir === "up" ? "En hausse : +" : "En baisse : −"}${Math.abs(trend.delta)}\u00a0hPa ${since}.`;
}

// Textes de la pression affichée : mesure d'une station (valeur seule, avec le détail dans l'info-bulle) ou, à défaut, valeur du modèle (« ≈ »).
// trend : tendance de cette mesure (jamais avec la valeur d'un modèle).
export function pressureDisplay(model, observed, fmtTime = (ms) => new Date(ms).toISOString().slice(11, 16), trend = null) {
  if (observed) {
    const detail = `${observed.name} (${observed.station}), à ${Math.round(observed.km)} km, relevé de ${fmtTime(observed.at)}`;
    return {
      hpa: observed.hpa, text: `${observed.hpa} hPa`, measured: true, trend: trend ?? null, trendText: trendText(trend, fmtTime),
      // QNH : pression de la station ramenée au niveau de la mer avec l'atmosphère STANDARD (pas la température réelle, contrairement
      // à la pression au niveau de la mer des modèles) ; l'écart reste faible en plaine, plus marqué en altitude par temps froid ou chaud.
      title: `Pression MESURÉE à la station (QNH, ramenée au niveau de la mer selon l'atmosphère standard) : ${detail}.${trend ? ` ${trendText(trend, fmtTime)}` : ""}`,
      note: `Pression mesurée par la station météo d'aéroport la plus proche, ramenée au niveau de la mer selon l'atmosphère standard (QNH) : ${detail}. Ce n'est pas la mesure de l'emplacement exact. Le QNH peut différer d'environ 1 à 2 hPa de la pression au niveau de la mer calculée avec la température réelle, surtout pour une station en altitude par temps froid ou chaud. Source : messages METAR, via l'Iowa Environmental Mesonet.`,
    };
  }
  if (isNum(model)) {
    return {
      hpa: model, text: `≈ ${Math.round(model)} hPa`, measured: false,
      title: "Pression au niveau de la mer CALCULÉE par le modèle (aucune mesure de station récente à proximité).",
      note: "Aucune station avec une mesure récente à proximité : la valeur est calculée par le modèle (pas une mesure).",
    };
  }
  return { hpa: null, text: "— hPa", measured: false, title: "Pression indisponible", note: "Pression indisponible." };
}

// ── Orages OBSERVÉS (23/11/2026) ─────────────────────────────────────────────────────────────────────────────────────────────
// Code « temps présent » du METAR : TS = orage sur l'aéroport (TSRA, +TSRA, TSGR…), VCTS = à proximité (environ 8 à 16 km),
// RETS… = orage récent (dans l'heure passée). Seule la partie OBSERVÉE du message est lue : tout ce qui suit TEMPO, BECMG, NOSIG,
// RMK… est une prévision ou une remarque (vu à Toulouse et Orly : « TEMPO … TSRA » sans orage observé). Les stations automatiques
// françaises (AUTO) signalent bien l'orage (vérifié : 67 messages à Dijon à l'été 2025, tous en AUTO).
export const STORM_OBS_KM = 50;
export const STORM_OBS_MAX_AGE_MS = 60 * 60 * 1000;
const STORM_RANK = { ts: 3, vc: 2, recent: 1 };
export function metarStorm(raw) {
  if (typeof raw !== "string") return null;
  const observed = raw.split(/\s(?:TEMPO|BECMG|NOSIG|RMK|INTER|PROB\d{2}|FM\d{4,6})\b/)[0];
  let best = null;
  for (const tok of observed.split(/\s+/)) {
    const kind = /^[+-]?TS[A-Z]*$/.test(tok) ? "ts" : /^VCTS[A-Z]*$/.test(tok) ? "vc" : /^RETS[A-Z]*$/.test(tok) ? "recent" : null;
    if (kind && (!best || STORM_RANK[kind] > STORM_RANK[best.kind])) best = { kind, code: tok };
  }
  return best;
}
// Stations à moins de maxKm dont le dernier message (de moins d'une heure) signale un orage, de la plus proche à la plus lointaine.
export function stormsNear(rows, lat, lon, { now = Date.now(), maxKm = STORM_OBS_KM, maxAgeMs = STORM_OBS_MAX_AGE_MS } = {}) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!isNum(r?.lat) || !isNum(r?.lon) || typeof r.station !== "string") continue;
    const at = Date.parse(r.utc_valid);
    if (!Number.isFinite(at) || now - at > maxAgeMs || at - now > 10 * 60 * 1000) continue;
    const storm = metarStorm(r.raw);
    if (!storm) continue;
    const km = distanceKm(lat, lon, r.lat, r.lon);
    if (km <= maxKm) out.push({ station: r.station, name: typeof r.name === "string" ? r.name : r.station, km, at, ...storm });
  }
  return out.sort((a, b) => a.km - b.km);
}
// Liste (vide si aucun orage signalé) ; lève ObsError si le réseau est illisible : l'appelant n'affiche alors rien.
export async function fetchObservedStorms({ latitude, longitude, countryCode }, { fetchImpl = fetch, now = Date.now(), timeoutMs = TIMEOUTS.pressure } = {}) {
  return stormsNear(await networkRows(countryCode, { fetchImpl, now, timeoutMs }), latitude, longitude, { now });
}
// « ⚡ Orage observé à l'aéroport de Nancy (23 km), relevé de 14:30. » (+ « et 1 autre station »)
export function stormText(storms, fmtTime) {
  if (!Array.isArray(storms) || !storms.length) return null;
  const s = storms[0];
  const what = s.kind === "ts" ? "Orage observé à l'aéroport de" : s.kind === "vc" ? "Orage signalé près de l'aéroport de" : "Orage récent (dans l'heure passée) à l'aéroport de";
  const more = storms.length > 1 ? ` (et ${storms.length - 1} autre${storms.length > 2 ? "s" : ""} station${storms.length > 2 ? "s" : ""} à moins de ${STORM_OBS_KM} km)` : "";
  return `⚡ ${what} ${s.name} (${Math.round(s.km)} km), relevé de ${fmtTime(s.at)}${more}.`;
}
