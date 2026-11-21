// Pression MESURÉE : dernier message METAR (observation d'aviation) de la station la plus proche, lu via l'Iowa Environmental Mesonet
// (domaine public, attribution souhaitée). La position de l'utilisateur ne quitte pas l'appareil pour cet appel : on ne demande que la liste
// des stations d'un pays, et la plus proche est choisie ici. Rien n'est inventé : sans station proche et récente, l'appelant garde la valeur du modèle.

import { timed, seconds, TIMEOUTS } from "./net.js";

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
// Dernières observations d'un pays (réseau « FR__ASOS » pour la France). Les pays à réseaux par région (Canada, États-Unis…) ne sont pas couverts.
export async function fetchObservedPressure({ latitude, longitude, countryCode }, { fetchImpl = fetch, now = Date.now(), timeoutMs = TIMEOUTS.pressure } = {}) {
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
  const best = pickStation(rows.data, latitude, longitude, { now });
  if (!best) throw new ObsError("none", `Aucune station avec une mesure récente à moins de ${OBS_MAX_KM} km.`);
  return best;
}

// Textes de la pression affichée : mesure d'une station (valeur seule, avec le détail dans l'info-bulle) ou, à défaut, valeur du modèle (« ≈ »).
export function pressureDisplay(model, observed, fmtTime = (ms) => new Date(ms).toISOString().slice(11, 16)) {
  if (observed) {
    const detail = `${observed.name} (${observed.station}), à ${Math.round(observed.km)} km, relevé de ${fmtTime(observed.at)}`;
    return {
      hpa: observed.hpa, text: `${observed.hpa} hPa`, measured: true,
      // QNH : pression de la station ramenée au niveau de la mer avec l'atmosphère STANDARD (pas la température réelle, contrairement
      // à la pression au niveau de la mer des modèles) ; l'écart reste faible en plaine, plus marqué en altitude par temps froid ou chaud.
      title: `Pression MESURÉE à la station (QNH, ramenée au niveau de la mer selon l'atmosphère standard) : ${detail}.`,
      note: `Pression mesurée par la station météo d'aéroport la plus proche, ramenée au niveau de la mer selon l'atmosphère standard (QNH) : ${detail}. Ce n'est pas la mesure de votre emplacement exact. Le QNH peut différer d'environ 1 à 2 hPa de la pression au niveau de la mer calculée avec la température réelle, surtout pour une station en altitude par temps froid ou chaud. Source : messages METAR, via l'Iowa Environmental Mesonet.`,
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
