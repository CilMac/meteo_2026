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
// L'IEM refuse (429) deux demandes d'historique dans la même seconde (vérifié le 25/11/2026) : à l'ouverture, l'écran d'accueil et la page
// en font une chacun. Même station : lecture partagée, même en cours ; sinon une seule nouvelle tentative, un peu plus tard.
export const TREND_RETRY_MS = 2000;
async function readHistory(url, fetchImpl, timeoutMs) {
  return timed(timeoutMs, async (signal) => {
    let res;
    try { res = await fetchImpl(url, { signal }); } catch (e) { throw new ObsError("network", `Historique de la station indisponible (réseau) : ${e.message}`); }
    if (!res.ok) throw new ObsError("http", `Le service des stations a répondu HTTP ${res.status}`);
    return res.text();
  }, () => new ObsError("timeout", `Le service des stations ne répond pas (aucune réponse en ${seconds(timeoutMs)})`));
}
// Tendance de la station déjà choisie, ou null (relevé absent) ; lève ObsError si le service est illisible.
export async function fetchPressureTrend(observed, { fetchImpl = fetch, now = Date.now(), timeoutMs = TIMEOUTS.pressure, retryMs = TREND_RETRY_MS } = {}) {
  if (!observed || !/^[A-Z0-9]{3,8}$/.test(observed.station)) return null;
  const key = `${observed.station}|${observed.at}`;
  let hit = historyCache.get(key);
  if (!hit || now - hit.at > OBS_CACHE_MS) {
    const hours = Math.min(12, Math.ceil((now - observed.at + TREND_MS + TREND_TOLERANCE_MS) / 3600000) + 1);
    const q = `station=${observed.station}&data=alti&data=metar&hours=${hours}&tz=Etc/UTC&format=onlycomma&latlon=no&missing=null&trace=null&direct=no&report_type=3&report_type=4`;
    const url = `${IEM_HISTORY_URL}?${q}`;
    const read = readHistory(url, fetchImpl, timeoutMs).catch(async (e) => {
      if (e.kind === "timeout") throw e;
      await new Promise((r) => setTimeout(r, retryMs)); // un 429 sans en-tête CORS se présente comme une panne de réseau
      return readHistory(url, fetchImpl, timeoutMs);
    });
    hit = { at: now, history: read.then((csv) => parseHistory(csv, observed.station)) };
    historyCache.set(key, hit);
    hit.history.catch(() => { if (historyCache.get(key) === hit) historyCache.delete(key); }); // échec : rien n'est gardé
  }
  return pressureTrend(observed, await hit.history);
}
export const TREND_WORD = { up: "en hausse", down: "en baisse", steady: "à peu près stable" };
// « En hausse : +2 hPa depuis 16:00 (1023 hPa). » ; « À peu près stable depuis 16:00 (1024 hPa). »
export function trendText(trend, fmtTime) {
  if (!trend) return null;
  const since = `depuis ${fmtTime(trend.at)} (${trend.hpa}\u00a0hPa)`;
  if (trend.dir === "steady") return `À peu près stable ${since}.`;
  return `${trend.dir === "up" ? "En hausse : +" : "En baisse : −"}${Math.abs(trend.delta)}\u00a0hPa ${since}.`;
}

// Contenu de la fenêtre du baromètre : titre de tendance, lignes visibles (« now » et « past » légendent les aiguilles), explications repliées.
const trendHead = (t) => (!t ? null : t.dir === "steady" ? "À peu près stable" : `En ${t.dir === "up" ? "hausse" : "baisse"} de ${Math.abs(t.delta)}\u00a0hPa`);
const NOTE_WORDS = ["Mots du cadran", "indications traditionnelles, pour le décor. Une pression seule ne fait pas une prévision."];
function measuredPanel(observed, trend, fmtTime) {
  return {
    trend: trendHead(trend),
    rows: [
      { key: "now", label: "Dernier relevé", time: fmtTime(observed.at), value: `${observed.hpa}\u00a0hPa` },
      ...(trend ? [{ key: "past", label: "Environ 3\u00a0h avant", time: fmtTime(trend.at), value: `${trend.hpa}\u00a0hPa` }] : []),
      { key: "place", label: `Station de ${observed.name}`, time: "", value: `à ${Math.round(observed.km)}\u00a0km` },
    ],
    notes: [
      ...(trend ? [["Aiguilles", "noire, le dernier relevé ; dorée, environ 3 h plus tôt, à la même station."],
        ["Tendance", "en général, une hausse accompagne une amélioration et une baisse une dégradation, sans que ce soit une prévision. La plupart des stations arrondissent au hPa : 1 hPa d'écart est dit « à peu près stable »."]] : []),
      ["Mesure", `faite à la station météo d'aéroport la plus proche (${observed.station}), pas à l'emplacement exact.`],
      ["Niveau de la mer", "la valeur y est ramenée selon l'atmosphère standard (QNH). Elle peut différer d'environ 1 à 2 hPa de celle calculée avec la température réelle, surtout pour une station en altitude par temps froid ou chaud."],
      NOTE_WORDS,
      ["Source", "messages METAR, via l'Iowa Environmental Mesonet."],
    ],
  };
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
      panel: measuredPanel(observed, trend, fmtTime),
    };
  }
  if (isNum(model)) {
    return {
      hpa: model, text: `≈ ${Math.round(model)} hPa`, measured: false,
      title: "Pression au niveau de la mer CALCULÉE par le modèle (aucune mesure de station récente à proximité).",
      panel: {
        trend: null,
        rows: [{ key: "now", label: "Maintenant", time: "", value: `≈\u00a0${Math.round(model)}\u00a0hPa` }, { key: "place", label: "Calculée par un modèle, pas mesurée", time: "", value: "" }],
        notes: [["Pourquoi « ≈ »", "aucune station avec une mesure récente à proximité : la valeur, au niveau de la mer, est calculée par le modèle. Sans mesure, pas de tendance."], NOTE_WORDS],
      },
    };
  }
  return { hpa: null, text: "— hPa", measured: false, title: "Pression indisponible", panel: { trend: null, rows: [{ key: "place", label: "Pression indisponible", time: "", value: "" }], notes: [NOTE_WORDS] } };
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

// ── Message METAR décodé pour la bulle d'une station (26/11/2026) ─────────────────────────────────────────────────────────────────
// Seule la partie OBSERVÉE est lue (comme pour l'orage). Valeurs telles que publiées, converties seulement d'unité : vent en nœuds
// (ou m/s, km/h) → km/h ; hauteur des nuages en centaines de pieds au-dessus de l'aéroport → m (arrondi à 10 m). Le vent du METAR est
// la moyenne des 10 dernières minutes, la rafale le maximum de ces 10 minutes (définition OMM/OACI) ; une rafale n'est transmise que si
// elle dépasse nettement le vent moyen : son absence ne veut pas dire « 0 ». Un groupe absent ou illisible reste null : rien n'est deviné.
const KT_KMH = 1.852, FT_M = 0.3048;
const observedPart = (raw) => raw.split(/\s(?:TEMPO|BECMG|NOSIG|RMK|INTER|PROB\d{2}|FM\d{4,6})\b/)[0];
export function metarObs(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const o = { auto: false, tempC: null, dewC: null, wind: null, windVar: null, visM: null, visPlus: false, cavok: false, clouds: [], sky: null, vvM: null, wx: [] };
  const toks = observedPart(raw).trim().split(/\s+/);
  const t2 = (v) => (v.startsWith("M") ? -Number(v.slice(1)) : Number(v));
  for (const t of toks.slice(1)) {
    let m;
    if (t === "AUTO") o.auto = true;
    else if (t === "CAVOK") { o.cavok = true; o.visM = 10000; o.visPlus = true; }
    else if (!o.wind && (m = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)$/.exec(t))) {
      const f = m[4] === "KT" ? KT_KMH : m[4] === "MPS" ? 3.6 : 1, kmh = Math.round(Number(m[2]) * f);
      o.wind = { dir: m[1] === "VRB" ? null : Number(m[1]), variable: m[1] === "VRB", calm: Number(m[2]) === 0 && !m[3], kmh, gustKmh: m[3] ? Math.round(Number(m[3]) * f) : null };
    } else if (o.wind && !o.windVar && (m = /^(\d{3})V(\d{3})$/.exec(t))) o.windVar = [Number(m[1]), Number(m[2])];
    else if (o.visM === null && (m = /^(\d{4})(?:NDV)?$/.exec(t))) { const v = Number(m[1]); o.visM = v === 9999 ? 10000 : v; o.visPlus = v === 9999; }
    else if (o.visM === null && (m = /^(P)?(\d{1,2})SM$/.exec(t))) { o.visM = Math.round(Number(m[2]) * 1609.344); o.visPlus = !!m[1] || Number(m[2]) >= 10; }
    else if ((m = /^(FEW|SCT|BKN|OVC)(\d{3}|\/\/\/)(CB|TCU|\/\/\/)?$/.exec(t))) o.clouds.push({ cover: m[1], m: m[2] === "///" ? null : Math.round(Number(m[2]) * 100 * FT_M / 10) * 10, type: m[3] === "CB" || m[3] === "TCU" ? m[3] : null });
    else if ((m = /^VV(\d{3}|\/\/\/)$/.exec(t))) o.vvM = m[1] === "///" ? -1 : Math.round(Number(m[1]) * 100 * FT_M / 10) * 10;
    else if (/^(NSC|NCD|SKC|CLR)$/.test(t)) o.sky = t;
    else if ((m = /^(M?\d{2})\/(M?\d{2}|\/\/)?$/.exec(t))) { o.tempC = t2(m[1]); o.dewC = m[2] && m[2] !== "//" ? t2(m[2]) : null; }
    else if (/^(?:[+-]|VC|RE)?(?:MI|PR|BC|DR|BL|SH|TS|FZ)?(?:(?:DZ|RA|SN|SG|IC|PL|GR|GS|UP)+|BR|FG|FU|VA|DU|SA|HZ|PO|SQ|FC|SS|DS)$/.test(t) || /^(?:VC|RE)?TS$/.test(t)) o.wx.push(t);
  }
  return o;
}
const PHEN = { DZ: "bruine", RA: "pluie", SN: "neige", SG: "neige en grains", IC: "cristaux de glace", PL: "granules de glace", GR: "grêle", GS: "grésil",
  UP: "précipitation de type inconnu", BR: "brume", FG: "brouillard", FU: "fumée", VA: "cendres volcaniques", DU: "poussière", SA: "sable", HZ: "brume sèche",
  PO: "tourbillons de poussière", SQ: "grains", FC: "trombe", SS: "tempête de sable", DS: "tempête de poussière" };
// « -SHRA » → « averses de pluie, intensité faible (-SHRA) ». Le code reste affiché : la traduction peut se vérifier.
export function wxText(code) {
  const m = /^([+-]|VC|RE)?(MI|PR|BC|DR|BL|SH|TS|FZ)?([A-Z]*)$/.exec(code);
  if (!m) return code;
  const names = (m[3].match(/../g) ?? []).map((p) => PHEN[p] ?? p).join(" et ");
  const d = m[2];
  let t = d === "SH" ? `averses${names ? ` de ${names}` : ""}` : d === "TS" ? `orage${names ? ` avec ${names}` : ""}`
    : d === "FZ" ? (m[3] === "FG" ? "brouillard givrant" : `${names} se congelant au sol (verglaçante)`) : d === "BC" ? `bancs de ${names}`
    : d === "MI" ? `${names} mince (au ras du sol)` : d === "PR" ? `${names} partiel` : d === "BL" ? `${names} soulevée par le vent (haute)`
    : d === "DR" ? `${names} soulevée par le vent (basse)` : names;
  if (m[1] === "-") t += ", intensité faible"; else if (m[1] === "+") t += ", intensité forte";
  if (m[1] === "VC") t = `à proximité : ${t}`; else if (m[1] === "RE") t = `récemment : ${t}`;
  return `${t} (${code})`;
}
const COMPASS = ["nord", "nord-nord-est", "nord-est", "est-nord-est", "est", "est-sud-est", "sud-est", "sud-sud-est", "sud", "sud-sud-ouest", "sud-ouest", "ouest-sud-ouest", "ouest", "ouest-nord-ouest", "nord-ouest", "nord-nord-ouest"];
export const compassFrom = (deg) => { const n = COMPASS[Math.round(((deg % 360) / 22.5)) % 16]; return /^[eo]/.test(n) ? `de l'${n}` : `du ${n}`; };
const COVER = { FEW: "quelques nuages (1 à 2 octas)", SCT: "nuages épars (3 à 4 octas)", BKN: "nuages fragmentés (5 à 7 octas)", OVC: "ciel couvert (8 octas)" };
const SKY = { NSC: "pas de nuage significatif", NCD: "aucun nuage détecté (capteur automatique)", SKC: "ciel clair", CLR: "aucun nuage détecté sous 3 700 m environ (capteur automatique)" };
const fmtM = (m) => (m >= 1000 ? `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(m / 1000)} km` : `${m} m`);
// Lignes de la bulle, dans l'ordre : température, vent, rafales, visibilité, nuages, temps présent. skip = codes déjà dits (orage).
export function metarLines(o, { skip = [] } = {}) {
  if (!o) return [];
  const out = [];
  if (o.tempC !== null) out.push(`Température : ${o.tempC} °C${o.dewC !== null ? ` · point de rosée ${o.dewC} °C` : ""}`);
  if (o.wind) {
    const w = o.wind;
    if (w.calm) out.push("Vent : calme");
    else {
      const from = w.variable ? "direction variable" : compassFrom(w.dir) + ` (${w.dir}°)`;
      const v = o.windVar ? `, variant de ${o.windVar[0]}° à ${o.windVar[1]}°` : "";
      out.push(`Vent moyen sur 10 min : ${w.kmh} km/h, ${from}${v}`);
    }
    if (w.gustKmh !== null) out.push(`Rafales (max. sur 10 min) : ${w.gustKmh} km/h`);
  }
  if (o.cavok) out.push("CAVOK : visibilité 10 km ou plus, aucun nuage sous 1 500 m (plus haut si le relief l'exige), ni cumulonimbus ni temps significatif");
  else if (o.visM !== null) out.push(`Visibilité : ${o.visPlus ? `${fmtM(o.visM)} ou plus` : o.visM < 50 ? "moins de 50 m" : fmtM(o.visM)}`);
  if (o.vvM !== null) out.push(o.vvM < 0 ? "Ciel invisible (visibilité verticale non mesurée)" : `Ciel invisible : visibilité verticale ${o.vvM} m`);
  if (o.clouds.length) out.push(`Nuages (hauteur au-dessus de l'aéroport) : ${o.clouds.map((c) => `${COVER[c.cover]} à ${c.m === null ? "hauteur inconnue" : `${c.m} m`}${c.type === "CB" ? ", cumulonimbus" : c.type === "TCU" ? ", cumulus bourgeonnants" : ""}`).join(" ; ")}`);
  else if (o.sky && !o.cavok) out.push(`Nuages : ${SKY[o.sky]}`);
  const wx = o.wx.filter((c) => !skip.includes(c));
  if (wx.length) out.push(`Temps présent : ${wx.map(wxText).join(" ; ")}`);
  return out;
}

// ── Stations sur la carte (26/11/2026) ───────────────────────────────────────────────────────────────────────────────────────────
// Toutes les stations du réseau du pays (même lecture, gardée 10 min, que la pression et les orages : pas d'appel en plus si elle
// vient d'être faite) dont le dernier message a moins de 3 h : pression (QNH) et orage observé (message de moins d'une heure,
// mêmes règles que le bandeau). Une station sans l'un ni l'autre n'est pas montrée ; une valeur absente reste null.
export function stationsForMap(rows, { now = Date.now(), maxAgeMs = OBS_MAX_AGE_MS } = {}) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!isNum(r?.lat) || !isNum(r?.lon) || typeof r.station !== "string") continue;
    const at = Date.parse(r.utc_valid);
    if (!Number.isFinite(at) || now - at > maxAgeMs || at - now > 10 * 60 * 1000) continue;
    const hpa = qnhHpa(r), storm = now - at <= STORM_OBS_MAX_AGE_MS ? metarStorm(r.raw) : null;
    if (hpa === null && !storm) continue;
    out.push({ station: r.station, name: typeof r.name === "string" ? r.name : r.station, lat: r.lat, lon: r.lon, at, hpa, storm, obs: metarObs(r.raw), raw: typeof r.raw === "string" ? r.raw : null });
  }
  return out;
}
export async function fetchStationsForMap(countryCode, { fetchImpl = fetch, now = Date.now(), timeoutMs = TIMEOUTS.pressure } = {}) {
  return stationsForMap(await networkRows(countryCode, { fetchImpl, now, timeoutMs }), { now });
}
// Ligne d'orage de la fenêtre d'une station (mêmes mots que le bandeau).
export const STORM_WORDS = { ts: "Orage observé sur l'aéroport", vc: "Orage signalé à proximité de l'aéroport", recent: "Orage récent (dans l'heure passée)" };
