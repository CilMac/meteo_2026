// Lieux favoris. Coordonnées issues du géocodage Open-Meteo (Agay : point littoral, voir RAPPORT_LOT0.md).
// `countryCode` choisit le plan de modèles dans weather-provider.js.

export const FAVORITES = [
  { id: "bar-le-duc", name: "Bar-le-Duc", country: "France", countryCode: "FR", latitude: 48.77275, longitude: 5.16108, timezone: "Europe/Paris" },
  { id: "agay", name: "Agay", country: "France", countryCode: "FR", latitude: 43.43248, longitude: 6.85564, timezone: "Europe/Paris" },
  { id: "paris", name: "Paris", country: "France", countryCode: "FR", latitude: 48.85341, longitude: 2.3488, timezone: "Europe/Paris" },
  { id: "nancy", name: "Nancy", country: "France", countryCode: "FR", latitude: 48.68439, longitude: 6.18496, timezone: "Europe/Paris" },
  { id: "strasbourg", name: "Strasbourg", country: "France", countryCode: "FR", latitude: 48.58392, longitude: 7.74553, timezone: "Europe/Paris" },
  { id: "montreal", name: "Montréal", country: "Canada", countryCode: "CA", latitude: 45.50884, longitude: -73.58781, timezone: "America/Toronto" },
  { id: "perigueux", name: "Périgueux", country: "France", countryCode: "FR", latitude: 45.18691, longitude: 0.71439, timezone: "Europe/Paris" },
  { id: "tokyo", name: "Tokyo", country: "Japon", countryCode: "JP", latitude: 35.6895, longitude: 139.69171, timezone: "Asia/Tokyo" },
];

export const DEFAULT_PLACE = FAVORITES[0];
export const CUSTOM_ID = "custom";

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";

// Nettoie la saisie : pas de caractères de contrôle, espaces normalisés, longueur bornée. Renvoie null si inexploitable.
export function cleanQuery(raw) {
  const q = String(raw ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return q.length >= 2 ? q : null;
}

const validTimezone = (tz) => {
  if (typeof tz !== "string" || !tz) return false;
  try { new Intl.DateTimeFormat("fr-FR", { timeZone: tz }); return true; } catch { return false; }
};
const inRange = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const str = (v, max = 100) => (typeof v === "string" ? v.slice(0, max) : "");

// Un lieu n'est accepté que s'il a des coordonnées et un fuseau réels : rien n'est deviné.
export function validatePlace(p) {
  if (!p || typeof p !== "object") return null;
  if (!inRange(p.latitude, -90, 90) || !inRange(p.longitude, -180, 180) || !validTimezone(p.timezone)) return null;
  const name = str(p.name, 80);
  if (!name) return null;
  return {
    id: CUSTOM_ID, name, admin1: str(p.admin1, 80), country: str(p.country, 80),
    countryCode: /^[A-Z]{2}$/.test(p.countryCode ?? "") ? p.countryCode : "",
    latitude: p.latitude, longitude: p.longitude, timezone: p.timezone,
    elevation: typeof p.elevation === "number" ? p.elevation : null,
  };
}

export function placeLabel(p) {
  return [p.name, p.admin1 && p.admin1 !== p.name ? p.admin1 : null, p.country].filter(Boolean).join(", ");
}

// Recherche par géocodage. Toutes les homonymies sont renvoyées pour un choix explicite.
export async function searchPlaces(query, { fetchImpl = fetch } = {}) {
  const q = cleanQuery(query);
  if (!q) throw new Error("Saisissez au moins 2 caractères.");
  const url = `${GEOCODE_URL}?${new URLSearchParams({ name: q, count: "10", language: "fr", format: "json" })}`;
  let res;
  try { res = await fetchImpl(url); } catch (e) { throw new Error(`Recherche impossible (réseau) : ${e.message}`); }
  if (!res.ok) throw new Error(`Le service de recherche a répondu HTTP ${res.status}`);
  let body;
  try { body = await res.json(); } catch { throw new Error("Réponse du service de recherche illisible"); }
  const results = Array.isArray(body?.results) ? body.results : [];
  return results.map((r) => validatePlace({
    name: r.name, admin1: r.admin1, country: r.country, countryCode: r.country_code,
    latitude: r.latitude, longitude: r.longitude, timezone: r.timezone, elevation: r.elevation,
  })).filter(Boolean);
}
