// Carnet de relevés de la vue « Lieu actuel » : chaque ouverture (position réelle trouvée, météo chargée) garde ce que
// l'application affichait pour les 12 heures suivantes, afin de le comparer plus tard à ce qui s'est réellement passé.
// Stockage local de l'appareil uniquement (rien n'est envoyé) ; export en fichier JSON à la demande.
import { next24h } from "./weather-provider.js?v=afd8726c";
import { MINI_HOURS } from "./weather-render.js?v=374c8c64";

export const JOURNAL_KEY = "meteo.journal";
export const JOURNAL_FORMAT = 1;
export const SAME_SPOT_DEG = 0.01; // même endroit : écart ≤ 0,01° en latitude et en longitude (≈ 1 km)
export const SAME_SPOT_MS = 60 * 60 * 1000; // même moment : relevés pris à moins d'une heure d'écart
export const JOURNAL_MAX = 2000; // au-delà, les plus anciens sont retirés (≈ 1 Ko par relevé, sous les ≈ 5 Mo du stockage)

const r2 = (x) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
// Une colonne : valeurs brutes (non arrondies à l'affichage, absente = null) et modèle de chaque valeur,
// écrit une seule fois s'il est le même pour toutes les heures.
function column(hours, key) {
  const m = hours.map((x) => x[key]?.model ?? null);
  return { v: hours.map((x) => r2(x[key]?.value)), m: m.every((x) => x === m[0]) ? m[0] : m };
}

// Un relevé : ce que montre la vue (mêmes heures, mêmes valeurs, même modèle pour chaque valeur).
export function makeRecord(data, coords, { named = false, at = Date.now(), n = MINI_HOURS } = {}) {
  const hours = next24h(data).slice(0, n);
  if (!hours.length || !coords) return null;
  return {
    pris_le: new Date(at).toISOString(),
    heure_locale_situation: data.current?.time ?? null,
    lieu: data.location?.name ?? null,
    nom_trouve: Boolean(named),
    pays: data.location?.country ?? null,
    fuseau: data.location?.timezone ?? null,
    lat: r2(coords.latitude), lon: r2(coords.longitude), // arrondi 0,01° (≈ 1 km)
    precision_m: typeof coords.accuracy === "number" ? Math.round(coords.accuracy) : null,
    altitude_modele_m: data.location?.elevation ?? null,
    heures: hours.map((x) => x.time), // heure locale du lieu ; pluie, probabilité et rafales portent sur l'heure qui se termine à cette heure-là
    pluie_mm: column(hours, "precip"), proba_pct: column(hours, "precipProb"), temp_c: column(hours, "temp"), ressenti_c: column(hours, "apparent"),
    vent_kmh: column(hours, "wind"), rafales_kmh: column(hours, "gust"), code_meteo: column(hours, "weatherCode"),
  };
}

// Ajout : un relevé pris au même endroit moins d'une heure après le précédent le remplace (pas de doublons).
export function addRecord(list, rec, max = JOURNAL_MAX) {
  if (!rec) return list;
  const out = [...list];
  const last = out[out.length - 1];
  const same = last && Math.abs(last.lat - rec.lat) <= SAME_SPOT_DEG + 1e-9 && Math.abs(last.lon - rec.lon) <= SAME_SPOT_DEG + 1e-9
    && Date.parse(rec.pris_le) - Date.parse(last.pris_le) < SAME_SPOT_MS;
  if (same) out[out.length - 1] = rec; else out.push(rec);
  return out.length > max ? out.slice(out.length - max) : out;
}

// Lecture tolérante : stockage absent ou corrompu = carnet vide (jamais d'erreur bloquante).
export function parseJournal(text) {
  try { const v = JSON.parse(text); return Array.isArray(v) ? v.filter((r) => r && Array.isArray(r.heures)) : []; } catch { return []; }
}

export function exportText(list, at = Date.now()) {
  return JSON.stringify({
    format: "meteo_IA.releves", version: JOURNAL_FORMAT,
    exporte_le: new Date(at).toISOString(), nombre: list.length,
    conventions: "Valeurs des modèles telles qu'affichées dans « Lieu actuel », une colonne par grandeur, dans l'ordre de « heures » (v = valeurs, m = modèle de chaque valeur, ou un seul nom s'il est le même partout ; null = absente). Heures en heure locale du fuseau indiqué. Pluie, probabilité et rafales : heure qui se termine à l'heure indiquée ; température, ressenti, vent, code météo : à cette heure-là. Position arrondie à 0,01°.",
    releves: list,
  }, null, 1);
}
export const exportName = (at = Date.now()) => `releves-rando-${new Date(at).toISOString().slice(0, 10)}.json`;

// Accès au stockage, toujours protégé (navigation privée, stockage plein ou bloqué).
export function loadJournal(storage = globalThis.localStorage) {
  try { return parseJournal(storage.getItem(JOURNAL_KEY)); } catch { return []; }
}
export function saveRecord(rec, storage = globalThis.localStorage) {
  const list = addRecord(loadJournal(storage), rec);
  try { storage.setItem(JOURNAL_KEY, JSON.stringify(list)); return { ok: true, count: list.length }; }
  catch { return { ok: false, count: loadJournal(storage).length }; }
}
