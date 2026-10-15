// Vigilances officielles (cahier 10). Règle absolue : sans confirmation vérifiable → « non confirmée » + lien officiel.
// Jamais de « vigilance verte » déduite du beau temps, jamais d'alerte ou de couleur inventée.

const ECCC_ALERTS_URL = "https://api.weather.gc.ca/collections/weather-alerts/items";
export const ECCC_LICENCE_URL = "https://eccc-msc.github.io/open-data/licence/readme_en/";
export const ECCC_ATTRIBUTION = "Contains information licenced under the Data Server End-use Licence of Environment and Climate Change Canada.";

// Service officiel par pays et motif de non-confirmation en V1.
const OFFICIAL = {
  FR: {
    name: "Météo-France — vigilance", url: "https://vigilance.meteofrance.fr/",
    reason: "L'API officielle de vigilance exige un jeton : elle n'est pas intégrée dans cette version.",
    extra: { name: "Vigicrues (crues)", url: "https://www.vigicrues.gouv.fr/" },
  },
  JP: {
    name: "JMA — avertissements et alertes", url: "https://www.jma.go.jp/bosai/warning/",
    reason: "Le fichier public testé n'était pas à jour (date de publication ancienne) : il ne peut pas être présenté comme une alerte en vigueur.",
  },
  CA: { name: "Environnement et Changement climatique Canada — alertes", url: "https://weather.gc.ca/warnings/index_f.html", reason: "" },
};
const GENERIC = {
  name: "OMM — alertes météorologiques officielles dans le monde", url: "https://severeweather.wmo.int/",
  reason: "Aucun service national n'est intégré pour ce pays.",
};

export const officialSource = (place) => OFFICIAL[place.countryCode] ?? GENERIC;

export function unconfirmed(place, reason) {
  const src = officialSource(place);
  return { status: "unconfirmed", source: null, alerts: [], reason: reason ?? src.reason, link: src.url, linkName: src.name, extra: src.extra ?? null, checkedAt: null };
}

// ---------- ECCC (Canada) ----------
const ringContains = (ring, x, y) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const polygonContains = (poly, x, y) => ringContains(poly[0], x, y) && !poly.slice(1).some((hole) => ringContains(hole, x, y));
// null si la géométrie est absente ou d'un type inconnu : on ne peut alors pas conclure.
export function pointInGeometry(lon, lat, geometry) {
  if (!geometry) return null;
  if (geometry.type === "Polygon") return polygonContains(geometry.coordinates, lon, lat);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.some((p) => polygonContains(p, lon, lat));
  return null;
}

const COLOUR_RANK = { rouge: 0, red: 0, orange: 1, jaune: 2, yellow: 2, gris: 3, grey: 3 };
const ENDED = new Set(["ended", "cancelled", "terminé", "annulé"]);

// Reproduit les champs d'ECCC tels quels (la licence exige de ne pas altérer le contenu ni le sens).
export function normalizeEcccAlert(feature) {
  const p = feature.properties ?? {};
  return {
    id: feature.id ?? p.feature_id ?? null,
    type: p.alert_type ?? null, name: p.alert_name_fr ?? p.alert_name_en ?? null,
    colour: p.risk_colour_fr ?? p.risk_colour_en ?? null,
    status: p.status_fr ?? p.status_en ?? null, area: p.feature_name_fr ?? p.feature_name_en ?? null,
    expiresAt: p.expiration_datetime ?? null, eventEnd: p.event_end_datetime ?? null,
    text: p.alert_text_fr ?? p.alert_text_en ?? null,
    _ended: ENDED.has(String(p.status_en ?? "").toLowerCase()) || ENDED.has(String(p.status_fr ?? "").toLowerCase()),
  };
}
const isActive = (a, now) => !a._ended && (!a.expiresAt || new Date(a.expiresAt) > now);

export async function fetchEcccWarnings(place, { fetchImpl = fetch, now = new Date(), timeoutMs = 8000 } = {}) {
  const d = 0.02;
  const bbox = [place.longitude - d, place.latitude - d, place.longitude + d, place.latitude + d].join(",");
  const url = `${ECCC_ALERTS_URL}?${new URLSearchParams({ f: "json", limit: "50", bbox })}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let res;
    try { res = await fetchImpl(url, { signal: ctl.signal }); }
    catch (e) { return unconfirmed(place, `Service d'alertes ECCC inaccessible (${e.name === "AbortError" ? "délai dépassé" : e.message}).`); }
    if (!res.ok) return unconfirmed(place, `Le service d'alertes ECCC a répondu HTTP ${res.status}.`);
    let body;
    try { body = await res.json(); } catch { return unconfirmed(place, "Réponse du service d'alertes ECCC illisible."); }
    const features = body?.features;
    if (!Array.isArray(features)) return unconfirmed(place, "Réponse du service d'alertes ECCC incomplète.");
    if ((body.numberMatched ?? features.length) > features.length) return unconfirmed(place, "Liste d'alertes ECCC incomplète : vérification impossible.");

    const alerts = [];
    for (const f of features) {
      const inside = pointInGeometry(place.longitude, place.latitude, f.geometry);
      if (inside === null) return unconfirmed(place, "Une alerte ECCC sans zone exploitable : vérification impossible.");
      if (!inside) continue;
      const a = normalizeEcccAlert(f);
      if (isActive(a, now)) alerts.push(a);
    }
    alerts.sort((a, b) => (COLOUR_RANK[a.colour?.toLowerCase()] ?? 9) - (COLOUR_RANK[b.colour?.toLowerCase()] ?? 9));
    const src = officialSource(place);
    return { status: "confirmed", source: "ECCC", alerts, reason: "", link: src.url, linkName: src.name, extra: null, checkedAt: now.toISOString() };
  } finally { clearTimeout(timer); }
}

// Point d'entrée : une seule fonction selon le pays. Ne lève jamais : toute erreur devient « non confirmée ».
export async function loadWarnings(place, opts = {}) {
  if (place.countryCode === "CA") return fetchEcccWarnings(place, opts);
  return unconfirmed(place);
}
