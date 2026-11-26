// Calque « nuages et pluie » de la carte : valeurs des modèles à l'instant T, lues par Open-Meteo sur une grille de points
// couvrant la zone affichée (le premier point est la position de l'appareil, arrondie à 0,01°), puis interpolées en image.
// Rien n'est inventé : un point sans valeur reste transparent, jamais « 0 ». Pas de dépendance au DOM à l'import (tests Node).

import { timed, seconds, TIMEOUTS } from "./net.js?v=26ccf5e2";

const API = "https://api.open-meteo.com/v1/forecast";
export const MAX_LAT = 80;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const latOfY = (y) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
const r2 = (v) => Math.round(v * 100) / 100;

export class SkyError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

// Lecture JSON avec délai maximal ; erreurs typées (network, timeout, http, format).
function getJson(url, fetchImpl, timeoutMs) {
  return timed(timeoutMs, async (signal) => {
    let res;
    try { res = await fetchImpl(url, { signal }); } catch (e) { throw new SkyError("network", `réseau indisponible (${e.message})`); }
    if (!res.ok) throw new SkyError("http", `Open-Meteo a répondu HTTP ${res.status}`);
    try { return await res.json(); } catch { throw new SkyError("format", "réponse illisible"); }
  }, () => new SkyError("timeout", `Open-Meteo ne répond pas (aucune réponse en ${seconds(timeoutMs)})`));
}

// Nombre de colonnes × lignes pour environ `total` points, selon la forme (largeur / hauteur) de la zone.
export function gridDims(aspect, total = 48) {
  const a = isNum(aspect) && aspect > 0 ? aspect : 1;
  const ny = clamp(Math.round(Math.sqrt(total / a)), 4, 10);
  const nx = clamp(Math.round(total / ny), 4, 10);
  return { nx, ny };
}

// Points de la grille, du nord au sud puis d'ouest en est ; lignes régulières en projection de la carte (Mercator),
// pour que l'image interpolée se superpose exactement au fond de carte.
export function gridPoints({ south, north, west, east }, nx, ny) {
  const yN = mercY(clamp(north, -MAX_LAT, MAX_LAT)), yS = mercY(clamp(south, -MAX_LAT, MAX_LAT));
  const pts = [];
  for (let j = 0; j < ny; j++) {
    const lat = latOfY(yN + ((yS - yN) * j) / (ny - 1));
    for (let i = 0; i < nx; i++) pts.push({ lat: r2(lat), lon: r2(clamp(west + ((east - west) * i) / (nx - 1), -180, 180)) });
  }
  return pts;
}

// Pluie en mm par heure. La valeur « current » d'Open-Meteo est un cumul sur le pas du modèle (900 s ici : vérifié, elle égale
// l'entrée « minutely_15 » du même instant, et le cumul horaire est la somme des quatre pas) ; on ramène donc à l'heure.
export const rainMmPerHour = (precip, intervalSec) => (isNum(precip) && precip >= 0 && isNum(intervalSec) && intervalSec > 0 ? (precip * 3600) / intervalSec : null);

// Un point de la réponse → valeurs ; tout ce qui n'est pas un nombre devient null.
export function parseCurrent(c) {
  if (!c || typeof c !== "object") return { cloud: null, rain: null, wind: null, dir: null, gust: null };
  const n = (v) => (isNum(v) ? v : null);
  const cloud = n(c.cloud_cover);
  return {
    cloud: cloud === null ? null : clamp(cloud, 0, 100),
    rain: rainMmPerHour(c.precipitation, c.interval),
    wind: n(c.wind_speed_10m), dir: n(c.wind_direction_10m), gust: n(c.wind_gusts_10m),
  };
}

// Prévision heure par heure (curseur de la carte plein écran, 26/11/2026). Réponse « hourly » d'Open-Meteo, heures en UTC :
// la série commence à l'heure en cours (vérifié : 10:00 à 10:51 UTC). On garde les `n` premières heures APRÈS `nowMs`.
// Convention (doc Open-Meteo, la même que la vue des 12 heures) : pluie et rafales = cumul / maximum de l'heure qui se termine
// à l'heure dite (déjà en mm par heure) ; nuages, vent et direction = valeur à l'heure dite.
export function hourIndexes(times, nowMs, n) {
  const out = [];
  if (!Array.isArray(times)) return out;
  times.forEach((s, i) => { const t = Date.parse(`${s}Z`); if (out.length < n && Number.isFinite(t) && t > nowMs) out.push({ i, at: t }); });
  return out;
}
export function parseHour(h, i) {
  const n = (v) => (isNum(v) ? v : null);
  const at = (k) => n(h?.[k]?.[i]);
  const cloud = at("cloud_cover"), rain = at("precipitation");
  return { cloud: cloud === null ? null : clamp(cloud, 0, 100), rain: rain === null || rain < 0 ? null : rain, wind: at("wind_speed_10m"), dir: at("wind_direction_10m"), gust: at("wind_gusts_10m") };
}
// Étapes horaires de toute la grille, à partir des réponses de chaque point (le 1er = l'appareil). Une heure absente
// ou décalée chez un point donne null pour ce point (jamais « 0 »).
export function hourSteps(list, nowMs, n) {
  const idx = hourIndexes(list[0]?.hourly?.time, nowMs, n);
  return idx.map(({ i, at }) => {
    const vals = list.map((x) => (x?.hourly?.time?.[i] === list[0].hourly.time[i] ? parseHour(x.hourly, i) : parseHour(null, 0)));
    return { at, here: vals[0], cloud: vals.slice(1).map((v) => v.cloud), rain: vals.slice(1).map((v) => v.rain) };
  });
}

// Lit la grille. `here` = {lat, lon} de l'appareil (arrondie ici). Renvoie { at (ms UTC), here, nx, ny, cloud[], rain[], steps[] } (null = inconnu).
// hours > 0 : ajoute dans le même appel la prévision des `hours` heures suivantes (steps, voir hourSteps) ; sinon steps = [].
export async function fetchSky({ here, bounds, nx, ny, hours = 0 }, { fetchImpl = fetch, timeoutMs = TIMEOUTS.sky, now = Date.now() } = {}) {
  const pts = [{ lat: r2(here.lat), lon: r2(here.lon) }, ...gridPoints(bounds, nx, ny)];
  const q = new URLSearchParams({
    latitude: pts.map((p) => p.lat).join(","), longitude: pts.map((p) => p.lon).join(","),
    current: "cloud_cover,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m", wind_speed_unit: "kmh",
  });
  if (hours > 0) { q.set("hourly", "cloud_cover,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m"); q.set("forecast_hours", String(hours + 2)); }
  const body = await getJson(`${API}?${q}`, fetchImpl, timeoutMs);
  const list = Array.isArray(body) ? body : [body];
  if (list.length !== pts.length) throw new SkyError("format", "réponse inattendue (nombre de points)");
  const vals = list.map((x) => parseCurrent(x?.current));
  const t = Date.parse(`${list[0]?.current?.time}Z`); // sans fuseau demandé, l'heure est en UTC
  return {
    at: Number.isFinite(t) ? t : null, here: vals[0], nx, ny,
    cloud: vals.slice(1).map((v) => v.cloud), rain: vals.slice(1).map((v) => v.rain),
    steps: hours > 0 ? hourSteps(list, now, hours) : [],
  };
}

// Interpolation bilinéaire dans une grille nx × ny (fx, fy en coordonnées de grille) ; NaN si un des 4 voisins est inconnu.
export function bilinear(values, nx, ny, fx, fy) {
  const x = clamp(fx, 0, nx - 1), y = clamp(fy, 0, ny - 1);
  const i = Math.min(Math.floor(x), nx - 2), j = Math.min(Math.floor(y), ny - 2), tx = x - i, ty = y - j;
  const g = (a, b) => values[b * nx + a];
  const v00 = g(i, j), v10 = g(i + 1, j), v01 = g(i, j + 1), v11 = g(i + 1, j + 1);
  if (![v00, v10, v01, v11].every(isNum)) return NaN;
  return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
}

// Échelles de couleurs (la légende est dessinée avec les mêmes constantes que l'image).
export const CLOUD_RGB = [88, 101, 118], CLOUD_FROM = 20, CLOUD_MAX_ALPHA = 0.55;
export const RAIN_STOPS = [[0.1, [150, 205, 255]], [1, [60, 150, 240]], [2.5, [30, 100, 215]], [7.6, [110, 50, 200]], [20, [200, 40, 170]]];
export const RAIN_MIN = RAIN_STOPS[0][0];

export const cloudAlpha = (pct) => (isNum(pct) && pct > CLOUD_FROM ? Math.pow(Math.min(1, (pct - CLOUD_FROM) / (100 - CLOUD_FROM)), 1.2) * CLOUD_MAX_ALPHA : 0);
export function rainColor(mmh) {
  if (!isNum(mmh) || mmh < RAIN_MIN) return null;
  let k = 0;
  while (k < RAIN_STOPS.length - 2 && mmh > RAIN_STOPS[k + 1][0]) k++;
  const [a, ca] = RAIN_STOPS[k], [b, cb] = RAIN_STOPS[k + 1], t = clamp((mmh - a) / (b - a), 0, 1);
  const rgb = ca.map((c, i) => Math.round(c + (cb[i] - c) * t));
  const level = clamp((mmh - RAIN_MIN) / (RAIN_STOPS.at(-1)[0] - RAIN_MIN), 0, 1);
  return { rgb, alpha: 0.4 + 0.45 * Math.sqrt(level) };
}
const toCssRgb = (rgb, a = 1) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
export const cloudGradientCss = () => `linear-gradient(90deg, ${toCssRgb(CLOUD_RGB, 0)}, ${toCssRgb(CLOUD_RGB, CLOUD_MAX_ALPHA * 0.5)}, ${toCssRgb(CLOUD_RGB, CLOUD_MAX_ALPHA)})`;
export const rainGradientCss = () => `linear-gradient(90deg, ${RAIN_STOPS.map(([, c], i) => `${toCssRgb(c, 0.85)} ${Math.round((i / (RAIN_STOPS.length - 1)) * 100)}%`).join(", ")})`;

// Pixels RGBA (w × h) : nuages (gris translucide) puis pluie par-dessus (bleu → violet). Rien là où la valeur est inconnue.
// show : calques dessinés (26/11/2026 : nuages et pluie séparables, pour ne voir que la pluie).
export function skyPixels({ cloud, rain, nx, ny }, w, h, show = { clouds: true, rain: true }) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = (x / (w - 1)) * (nx - 1), fy = (y / (h - 1)) * (ny - 1);
      let r = 0, g = 0, b = 0, a = 0;
      const ca = show.clouds ? cloudAlpha(bilinear(cloud, nx, ny, fx, fy)) : 0;
      if (ca > 0) { [r, g, b] = CLOUD_RGB; a = ca; }
      const rc = show.rain ? rainColor(bilinear(rain, nx, ny, fx, fy)) : null;
      if (rc) {
        const ao = rc.alpha + a * (1 - rc.alpha); // « over » : la pluie recouvre le nuage
        r = (rc.rgb[0] * rc.alpha + r * a * (1 - rc.alpha)) / ao; g = (rc.rgb[1] * rc.alpha + g * a * (1 - rc.alpha)) / ao; b = (rc.rgb[2] * rc.alpha + b * a * (1 - rc.alpha)) / ao; a = ao;
      }
      const o = (y * w + x) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = Math.round(a * 255);
    }
  }
  return out;
}

// Image (data URL) du calque, dans le navigateur.
export function skyImageUrl(sky, w, h, show) {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(skyPixels(sky, w, h, show), w, h), 0, 0);
  return canvas.toDataURL("image/png");
}

// Direction du vent : en météo, c'est d'où il vient. La flèche pointe là où il va (direction + 180°).
const FROM = ["du nord", "du nord-est", "d'est", "du sud-est", "du sud", "du sud-ouest", "d'ouest", "du nord-ouest"];
export const windFromText = (d) => (isNum(d) ? `Vent ${FROM[Math.round((((d % 360) + 360) % 360) / 45) % 8]}` : "Vent indisponible");
export const arrowAngle = (d) => (isNum(d) ? (((d + 180) % 360) + 360) % 360 : null);

// Vent et ciel de la seule position de l'appareil (un point) : la flèche du vent reste affichée même quand le calque est éteint.
export async function fetchHere(here, { fetchImpl = fetch, timeoutMs = TIMEOUTS.sky } = {}) {
  const q = new URLSearchParams({
    latitude: String(r2(here.lat)), longitude: String(r2(here.lon)),
    current: "cloud_cover,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m", wind_speed_unit: "kmh",
  });
  const body = await getJson(`${API}?${q}`, fetchImpl, timeoutMs);
  return parseCurrent(Array.isArray(body) ? body[0]?.current : body?.current);
}

// Double toucher sur la carte (26/11/2026) : sur iPhone, le « dblclick » dont dépend Leaflet n'arrivait pas (quel que soit le navigateur, on ne compte pas dessus),
// d'où une détection maison. Un toucher = appui court sans glisser ; deux touchers rapprochés dans le temps et l'espace = zoom.
// Points : { x, y } en pixels d'écran, t en ms.
export const TAP = { maxPressMs: 350, maxMovePx: 10, maxGapMs: 350, maxDistPx: 30 };
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
export const isTap = (down, up) => Boolean(down && up) && up.t - down.t >= 0 && up.t - down.t <= TAP.maxPressMs && dist(down, up) <= TAP.maxMovePx;
export const isDoubleTap = (prev, cur) => Boolean(prev && cur) && cur.t - prev.t > 0 && cur.t - prev.t <= TAP.maxGapMs && dist(prev, cur) <= TAP.maxDistPx;

// ── Radar de pluie OBSERVÉE : RainViewer (26/11/2026) ──────────────────────────────────────────────────────────────────────────
// Lu sur rainviewer.com/api (26/11/2026) : gratuit, sans clé, « personal and educational use only », crédit « RainViewer » + lien
// demandé, 100 demandes par minute et par adresse IP, aucune garantie de disponibilité. Passé : 2 h, une image toutes les 10 min ;
// plus de prévision ni de satellite depuis le 01/01/2026 ; zoom 7 au plus (au-delà, une image « Zoom Level Not Supported », vérifié) ;
// une seule palette, « Universal Blue » (n° 2). Tuiles de 512 px : le niveau 7 correspond au zoom 8 de la carte (zoomOffset −1).
// Couverture : image noire opaque hors radar, transparente sous radar (pixels vérifiés), grisée sur la carte.
export const RADAR = { stepMin: 20, frames: 7, nativeZoom: 8, color: 2, options: "1_1" /* lissé, neige en couleurs à part */ };
export const RADAR_INDEX_URL = "https://api.rainviewer.com/public/weather-maps.json";
export const RADAR_COVERAGE_URL = "https://tilecache.rainviewer.com/v2/coverage/0/512/{z}/{x}/{y}/0/0_0.png";
// Images retenues, de la plus ancienne à la plus récente : la dernière publiée, puis en remontant, une tous les stepMin minutes
// (écart mesuré sur les heures réelles : une image manquante ne décale pas les autres). Hôte et chemin vérifiés avant d'en faire
// une adresse d'image (la réponse vient d'un service tiers).
export function radarFrames(json, { stepMin = RADAR.stepMin, maxFrames = RADAR.frames } = {}) {
  const host = json?.host, past = json?.radar?.past;
  if (typeof host !== "string" || !/^https:\/\/([a-z0-9-]+\.)*rainviewer\.com$/.test(host) || !Array.isArray(past)) return [];
  const ok = past.filter((f) => isNum(f?.time) && typeof f.path === "string" && /^\/v2\/radar\/[A-Za-z0-9]+$/.test(f.path)).sort((a, b) => a.time - b.time);
  const out = [];
  let prev = Infinity;
  for (let i = ok.length - 1; i >= 0 && out.length < maxFrames; i--) {
    if (prev - ok[i].time < stepMin * 60 - 60) continue; // une minute de tolérance
    out.unshift({ at: ok[i].time * 1000, url: `${host}${ok[i].path}/512/{z}/{x}/{y}/${RADAR.color}/${RADAR.options}.png` });
    prev = ok[i].time;
  }
  return out;
}
export async function fetchRadarFrames({ fetchImpl = fetch, timeoutMs = TIMEOUTS.sky } = {}) {
  const body = await timed(timeoutMs, async (signal) => {
    let res;
    try { res = await fetchImpl(RADAR_INDEX_URL, { signal }); } catch (e) { throw new SkyError("network", `réseau indisponible (${e.message})`); }
    if (!res.ok) throw new SkyError("http", `RainViewer a répondu HTTP ${res.status}`);
    try { return await res.json(); } catch { throw new SkyError("format", "réponse illisible"); }
  }, () => new SkyError("timeout", `RainViewer ne répond pas (aucune réponse en ${seconds(timeoutMs)})`));
  const frames = radarFrames(body);
  if (!frames.length) throw new SkyError("format", "aucune image radar dans la réponse de RainViewer");
  return frames;
}
// Réflectivité (dBZ) → intensité de pluie, relation de Marshall-Palmer (Z = 200 R^1,6) : approximation classique, pour la pluie
// seulement (pas pour la neige ni la grêle). Sert à la seule légende.
export const dbzToMmh = (dbz) => (10 ** (dbz / 10) / 200) ** (1 / 1.6);
// Couleurs de la palette « Universal Blue » de 10 à 55 dBZ, tous les 5 dBZ (tableau officiel rainviewer_api_colors_table.csv,
// lu le 26/11/2026 ; la pluie et la neige ont chacune leur colonne).
export const RADAR_RAIN = ["#cec08796", "#88ddeeff", "#00a3e0ff", "#0077aaff", "#005588ff", "#ffee00ff", "#ffaa00ff", "#ff4400ff", "#c10000ff", "#ffaaffff"];
export const RADAR_SNOW = ["#bfffffff", "#9fdfffff", "#7fbfffff", "#5f9fffff", "#4f8fffff", "#3f7fffff", "#2f6fffff", "#1f5fffff", "#0f4fffff", "#003fffff"];
export const RADAR_TICKS_DBZ = [10, 25, 40, 55]; // régulièrement espacés sur la barre (10 → 55 dBZ)
const fmtMmh = (v) => (v < 1 ? v.toFixed(1).replace(".", ",") : String(Math.round(v)));
export const radarTicks = () => RADAR_TICKS_DBZ.map((d, i, a) => `${fmtMmh(dbzToMmh(d))}${i === a.length - 1 ? "+" : ""}`);
export const radarGradientCss = (list) => `linear-gradient(90deg, ${list.map((c, i) => `${c} ${Math.round((i / (list.length - 1)) * 100)}%`).join(", ")})`;

// ── Pluie et neige séparées (26/11/2026) ─────────────────────────────────────────────────────────────────────────────────────
// Chaque point d'une image radar porte une couleur de la palette « Universal Blue » : celles de la pluie et celles de la neige
// (tableau officiel, « dBZ:RRGGBBAA », points transparents exclus) n'ont AUCUNE couleur en commun (vérifié), d'où un classement sûr.
// Essai du 26/11/2026 sur deux images réelles, lissées ou non : 99 à 100 % des points reconnus (le lissage ne crée pas de couleurs
// intermédiaires). Les autres (moins de 1 %, des roses absents du tableau, sens non publié) restent tels quels. La neige est recolorée
// en violet (choix de l'utilisateur) : ses bleus se confondaient avec ceux de la pluie. Sur la carte, tout est affiché (show par défaut) :
// les cases « pluie seule / neige seule » ont été retirées le 26/11/2026, le violet suffisant ; show ne sert plus qu'aux tests.
export const RV_RAIN = "-10:63615914 -9:66635a19 -8:69665c1e -7:6c685d24 -6:6f6b5f29 -5:726e612e -4:75706234 -3:78736439 -2:7c75653e -1:7f786744 0:827b6949 1:857d6a4e 2:88806c54 3:8b826d59 4:8e856f5e 5:92887164 6:9e93756e 7:aa9e7978 8:b6a97e82 9:c2b4828c 10:cec08796 11:d2c48ba0 12:d6c88faa 13:dacc93b4 14:ded097be 15:88ddeeff 16:6cd1ebff 17:51c5e8ff 18:36bae5ff 19:1baee2ff 20:00a3e0ff 21:009ad5ff 22:0091caff 23:0088bfff 24:007fb4ff 25:0077aaff 26:0070a3ff 27:00699cff 28:006295ff 29:005b8eff 30:005588ff 31:005180ff 32:004e78ff 33:004a70ff 34:004768ff 35:ffee00ff 36:ffe000ff 37:ffd200ff 38:ffc500ff 39:ffb700ff 40:ffaa00ff 41:ff9f00ff 42:ff9500ff 43:ff8b00ff 44:ff8100ff 45:ff4400ff 46:f23600ff 47:e62800ff 48:d91b00ff 49:cd0d00ff 50:c10000ff 51:a80000ff 52:8f0000ff 53:760000ff 54:5d0000ff 55:ffaaffff 56:ff9fffff 57:ff95ffff 58:ff8bffff 59:ff81ffff 60:ff77ffff 61:ff6cffff 62:ff62ffff 63:ff58ffff 64:ff4effff 65:ffffffff 75:00ff00ff";
export const RV_SNOW = "-9:ceffff0c -8:cdffff19 -7:ccffff26 -6:cbffff33 -5:cbffff3f -4:caffff4c -3:c9ffff59 -2:c8ffff66 -1:c7ffff72 0:c7ffff7f 1:c6ffff8c 2:c5ffff99 3:c4ffffa5 4:c3ffffb2 5:c3ffffbf 6:c2ffffcc 7:c1ffffd8 8:c0ffffe5 9:bffffff2 10:bfffffff 11:b8f8ffff 12:b2f2ffff 13:abebffff 14:a5e5ffff 15:9fdfffff 16:98d8ffff 17:92d2ffff 18:8bcbffff 19:85c5ffff 20:7fbfffff 21:78b8ffff 22:72b2ffff 23:6babffff 24:65a5ffff 25:5f9fffff 26:5b9bffff 27:5898ffff 28:5595ffff 29:5292ffff 30:4f8fffff 31:4b8bffff 32:4888ffff 33:4585ffff 34:4282ffff 35:3f7fffff 36:3b7bffff 37:3878ffff 38:3575ffff 39:3272ffff 40:2f6fffff 41:2b6bffff 42:2868ffff 43:2565ffff 44:2262ffff 45:1f5fffff 46:1b5bffff 47:1858ffff 48:1555ffff 49:1252ffff 50:0f4fffff 51:0c4bffff 52:0948ffff 53:0645ffff 54:0242ffff 55:003fffff 56:003bffff 57:0038ffff 58:0035ffff 59:0032ffff 60:002fffff 61:002bffff 62:0028ffff 63:0025ffff 64:0022ffff 65:001fffff 66:001bffff 67:0018ffff 68:0015ffff 69:0012ffff 70:000fffff 71:000cffff 72:0009ffff 73:0006ffff 74:0002ffff 75:0000ffff";
const parseRv = (txt) => txt.split(" ").map((t) => { const [d, h] = t.split(":"); return [Number(d), parseInt(h, 16) >>> 0]; });
const RAIN_SET = new Set(parseRv(RV_RAIN).map(([, c]) => c));
const SNOW_DBZ = new Map(parseRv(RV_SNOW).map(([d, c]) => [c, d]));
export const SNOW_VIOLET = [[10, [225, 210, 255]], [30, [160, 110, 235]], [55, [90, 30, 170]]]; // clair = faible, foncé = forte
export const SNOW_MIN_ALPHA = 200; // la neige la plus faible de RainViewer est presque transparente : rendue lisible
export function snowColor(dbz) {
  const st = SNOW_VIOLET, d = clamp(dbz, st[0][0], st[st.length - 1][0]);
  for (let k = 1; k < st.length; k++) {
    const [a, ca] = st[k - 1], [b, cb] = st[k];
    if (d <= b) { const t = (d - a) / (b - a); return ca.map((v, i) => Math.round(v + (cb[i] - v) * t)); }
  }
  return st[st.length - 1][1];
}
export const snowGradientCss = () => `linear-gradient(90deg, ${[10, 20, 30, 40, 55].map((d, i, a) => `rgb(${snowColor(d).join(", ")}) ${Math.round((i / (a.length - 1)) * 100)}%`).join(", ")})`;
// Filtre en place des pixels RGBA d'une image radar : show = { rain, snow }. Renvoie le décompte (pour les tests).
export function filterRadarPixels(px, show = { rain: true, snow: true }) {
  const n = { rain: 0, snow: 0, other: 0 };
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (!a) continue;
    const c = ((px[i] << 24) | (px[i + 1] << 16) | (px[i + 2] << 8) | a) >>> 0;
    if (RAIN_SET.has(c)) { n.rain++; if (!show.rain) px[i + 3] = 0; continue; }
    const d = SNOW_DBZ.get(c);
    if (d !== undefined) {
      n.snow++;
      if (!show.snow) { px[i + 3] = 0; continue; }
      const [r, g, b] = snowColor(d);
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = Math.max(a, SNOW_MIN_ALPHA);
      continue;
    }
    n.other++;
    if (!(show.rain && show.snow)) px[i + 3] = 0;
  }
  return n;
}

// Échelles de la carte (26/11/2026, choix de l'utilisateur) : deux zooms retenus chacun de son côté.
// « lieu » (calques éteints, ouverture) : 12 au départ (échelle 2 km, nom du lieu lisible) ; « météo » (Nuages ou Pluie allumés) :
// 8 au départ et 10 au plus (la grille d'environ 48 points n'a plus de sens plus près) ; relief : 17 au plus (tuiles d'OpenTopoMap).
export const MAP_ZOOM = { place: 12, sky: 8, skyMax: 10, topoMax: 17, max: 19, min: 3 };
export const maxZoomFor = ({ sky = false, topo = false } = {}) => Math.min(sky ? MAP_ZOOM.skyMax : MAP_ZOOM.max, topo ? MAP_ZOOM.topoMax : MAP_ZOOM.max);
// Réglages retenus (meteo.map) : { zoomPlace, zoomSky, topo } ; valeur absente ou hors bornes = défaut. L'ancien { zoom } est ignoré.
export function parseMapPrefs(raw) {
  let p = null;
  try { p = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { p = null; }
  const zoomIn = (v, max) => (Number.isInteger(v) && v >= MAP_ZOOM.min && v <= max ? v : null);
  return {
    zoomPlace: zoomIn(p?.zoomPlace, MAP_ZOOM.max) ?? MAP_ZOOM.place,
    zoomSky: zoomIn(p?.zoomSky, MAP_ZOOM.skyMax) ?? MAP_ZOOM.sky,
    topo: p?.topo === true,
  };
}
