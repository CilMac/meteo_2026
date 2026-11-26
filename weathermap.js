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

// Lit la grille. `here` = {lat, lon} de l'appareil (arrondie ici). Renvoie { at (ms UTC), here, nx, ny, cloud[], rain[] } (null = inconnu).
export async function fetchSky({ here, bounds, nx, ny }, { fetchImpl = fetch, timeoutMs = TIMEOUTS.sky } = {}) {
  const pts = [{ lat: r2(here.lat), lon: r2(here.lon) }, ...gridPoints(bounds, nx, ny)];
  const q = new URLSearchParams({
    latitude: pts.map((p) => p.lat).join(","), longitude: pts.map((p) => p.lon).join(","),
    current: "cloud_cover,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m", wind_speed_unit: "kmh",
  });
  const body = await getJson(`${API}?${q}`, fetchImpl, timeoutMs);
  const list = Array.isArray(body) ? body : [body];
  if (list.length !== pts.length) throw new SkyError("format", "réponse inattendue (nombre de points)");
  const vals = list.map((x) => parseCurrent(x?.current));
  const t = Date.parse(`${list[0]?.current?.time}Z`); // sans fuseau demandé, l'heure est en UTC
  return {
    at: Number.isFinite(t) ? t : null, here: vals[0], nx, ny,
    cloud: vals.slice(1).map((v) => v.cloud), rain: vals.slice(1).map((v) => v.rain),
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
