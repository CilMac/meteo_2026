// Position réelle de l'appareil (géolocalisation du navigateur) et nom du lieu (géocodage inverse OpenStreetMap / Nominatim).
// Rien n'est stocké : la position n'est gardée qu'en mémoire, le temps de la session.
import { validatePlace } from "./places.js";

const REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
export const GEO_ID = "geo";
export const GEO_MAX_AGE_MS = 10 * 60 * 1000; // une même position n'est pas recalculée avant 10 minutes (sauf demande explicite)

// Aux services tiers (nom du lieu, prévision), la position n'est envoyée qu'arrondie à 0,01° (environ 1 km) : assez pour une prévision.
export const roundCoord = (v, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;

// « 48,7727° N · 5,1611° E » (coordonnées de l'appareil, 4 décimales ≈ 10 m).
export function formatCoords(lat, lon) {
  const f = (v, pos, neg) => `${Math.abs(v).toLocaleString("fr-FR", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}° ${v >= 0 ? pos : neg}`;
  return `${f(lat, "N", "S")} · ${f(lon, "E", "O")}`;
}

export class GeoError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

// Promesse autour de navigator.geolocation. Les messages disent la vraie cause, sans rien deviner.
export function getPosition({ geolocation = globalThis.navigator?.geolocation, timeoutMs = 15000, maxAgeMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!geolocation) return reject(new GeoError("unsupported", "La géolocalisation n'est pas disponible sur cet appareil ou ce navigateur."));
    geolocation.getCurrentPosition(
      (p) => {
        const { latitude, longitude, accuracy } = p.coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return reject(new GeoError("unavailable", "Position reçue illisible."));
        resolve({ latitude, longitude, accuracy: Number.isFinite(accuracy) ? accuracy : null });
      },
      (e) => reject(new GeoError(
        e?.code === 1 ? "denied" : e?.code === 3 ? "timeout" : "unavailable",
        e?.code === 1 ? "Accès à la position refusé : autorisez la localisation pour ce site dans les réglages du navigateur ou de l'appareil."
          : e?.code === 3 ? "La position n'a pas pu être obtenue à temps."
            : "Position indisponible (signal ou service de localisation).")),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: maxAgeMs });
  });
}

// Nom du lieu le plus proche. Ne devine rien : si le service ne répond pas ou ne nomme rien, l'appelant le sait.
const cache = new Map();
export async function reverseGeocode(lat, lon, { fetchImpl = fetch } = {}) {
  const key = `${roundCoord(lat)},${roundCoord(lon)}`;
  if (cache.has(key)) return cache.get(key);
  const url = `${REVERSE_URL}?${new URLSearchParams({ format: "jsonv2", lat: String(roundCoord(lat)), lon: String(roundCoord(lon)), zoom: "10", addressdetails: "1", "accept-language": "fr" })}`;
  let res;
  try { res = await fetchImpl(url); } catch (e) { throw new GeoError("network", `Nom du lieu indisponible (réseau) : ${e.message}`); }
  if (!res.ok) throw new GeoError("http", `Le service de noms de lieux a répondu HTTP ${res.status}`);
  let body;
  try { body = await res.json(); } catch { throw new GeoError("format", "Réponse du service de noms de lieux illisible"); }
  const a = body?.address ?? {};
  const name = [a.city, a.town, a.village, a.municipality, a.hamlet, a.suburb, a.county].find((v) => typeof v === "string" && v.trim());
  if (!name) throw new GeoError("empty", "Aucun nom de lieu trouvé pour cette position.");
  const result = {
    name: name.trim(),
    admin1: typeof a.state === "string" ? a.state : "",
    country: typeof a.country === "string" ? a.country : "",
    countryCode: typeof a.country_code === "string" ? a.country_code.toUpperCase() : "",
  };
  cache.set(key, result);
  return result;
}

// Lieu utilisable par le fournisseur de prévisions. Sans nom trouvé : « Position GPS », jamais un nom inventé.
// Sans pays connu, le plan de modèles par défaut s'applique (pas de modèle national).
export function placeFromPosition(pos, named, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const place = validatePlace({
    name: named?.name || "Position GPS", admin1: named?.admin1 ?? "", country: named?.country ?? "", countryCode: named?.countryCode ?? "",
    latitude: roundCoord(pos.latitude), longitude: roundCoord(pos.longitude), timezone,
  });
  return place ? { ...place, id: GEO_ID } : null;
}
