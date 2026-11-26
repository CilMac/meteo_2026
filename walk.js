// « Puis-je me promener dans l'heure qui suit ? » : lit la pluie, la neige et le contexte (température ressentie, vent, visibilité, UV, nuit…)
// prévus par pas de 15 minutes à la position de l'appareil (Open-Meteo, valeurs des modèles, pas un radar) et en tire un verdict prudent
// accompagné de remarques. Rien n'est inventé : une donnée manquante donne « je ne sais pas » ou n'ajoute aucune remarque.
// Sans dépendance au DOM (tests Node).

import { timed, seconds, TIMEOUTS } from "./net.js?v=26ccf5e2";
import { modelShort } from "./weather-provider.js?v=afd8726c";

const API = "https://api.open-meteo.com/v1/forecast";
export const STEP_MS = 15 * 60 * 1000;
export const WINDOW_MS = 60 * 60 * 1000;
export const MAX_OFFSET_H = 12;   // on peut avancer le départ jusqu'à 12 h (les 12 heures de « Lieu actuel »)
export const MIN_STEPS = 3;       // en dessous, la fenêtre est trop pauvre pour conclure
export const WET_MM = 0.1;        // pluie : cumul d'un pas de 15 min à partir duquel il « pleut » (0,4 mm/h)
export const LIGHT_MMH = 1;       // pluie < 1 mm/h : faible ; < 4 mm/h : modérée ; au-delà : forte (seuils propres à l'application, pas des seuils officiels)
export const MODERATE_MMH = 4;
export const WET_SNOW_CM = 0.1;   // neige : cumul d'un pas de 15 min à partir duquel il « neige » (0,4 cm/h)
export const LIGHT_SNOW_CMH = 1;  // neige < 1 cm/h : faible ; < 3 cm/h : modérée ; au-delà : forte (seuils propres à l'application)
export const MODERATE_SNOW_CMH = 3;
// Conversion d'Open-Meteo (documentation de « snowfall ») : 7 cm de neige = 10 mm d'eau, soit 0,7 cm par mm ; vérifié dans les réponses de l'API.
export const SNOW_CM_PER_MM = 0.7;
export const GUST_WARN = 50, GUST_DANGER = 75; // km/h
export const HEAT_WARN = 30, HEAT_DANGER = 35;  // température ressentie, °C
export const COLD_INFO = 5, COLD_WARN = 0, COLD_DANGER = -10;
export const FOG_WARN_M = 1000, FOG_DANGER_M = 200;
const DROPS_CODE = 51; // types de temps OMM à partir de 51 : bruine, pluie, neige… (le brouillard, 45 et 48, n'en fait pas partie)
const FREEZING_CODES = [56, 57, 66, 67], SNOW_CODES = [71, 73, 75, 77, 85, 86], FOG_CODES = [45, 48];
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const capFirst = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
const r2 = (v) => Math.round(v * 100) / 100;
const fr1 = (v) => (Math.round(v * 10) / 10).toString().replace(".", ",");

export class WalkError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

export const mmPerHour = (mm15) => mm15 * 4;
// 0 = sec, 1 = faible, 2 = modérée, 3 = forte
export function rainLevel(mm15) {
  if (!isNum(mm15) || mm15 < WET_MM) return 0;
  const h = mmPerHour(mm15);
  return h < LIGHT_MMH ? 1 : h < MODERATE_MMH ? 2 : 3;
}
export function snowLevel(cm15) {
  if (!isNum(cm15) || cm15 < WET_SNOW_CM) return 0;
  const h = cm15 * 4;
  return h < LIGHT_SNOW_CMH ? 1 : h < MODERATE_SNOW_CMH ? 2 : 3;
}
export const LEVEL_WORD = ["sec", "faible", "modérée", "forte"];

// Modèles : ceux du tableau « Lieu actuel » (même ordre de priorité, valeur par valeur, comme weather-provider.js), puis en dernier
// recours le choix automatique d'Open-Meteo (« best_match »), seul à fournir la visibilité et l'indice UV (vérifié le 22/11/2026).
export const FALLBACK_MODEL = "best_match";
export function walkModels(models) {
  const list = Array.isArray(models) ? models.filter((m) => typeof m === "string" && m) : [];
  return [...new Set([...list, FALLBACK_MODEL])];
}
// Colonne d'une variable pour un modèle : suffixée (plusieurs modèles demandés) ou simple (un seul).
const column = (block, variable, model, models) => block?.[`${variable}_${model}`] ?? (models.length === 1 ? block?.[variable] : undefined) ?? null;
// Premier modèle de la liste qui donne une valeur pour ce pas : { v, m } ; aucun : { v: null, m: null } (jamais 0 deviné).
function pickAt(block, variable, i, models, ok = isNum) {
  for (const m of models) { const v = column(block, variable, m, models)?.[i]; if (ok(v)) return { v, m }; }
  return { v: null, m: null };
}
// Orage (23/11/2026) : le modèle principal (celui qui donne le code météo du pas) OU le choix automatique d'Open-Meteo.
// Mesuré sur 9 lieux et 7 modèles : JMA et GEM ne codent jamais d'orage, ECMWF presque jamais ; GFS, ICON et le choix
// automatique, si. → { by: [modèles qui annoncent l'orage], hail: grêle annoncée } ou null.
export const STORM_CODES = [95, 96, 99], HAIL_CODES = [96, 99];
export function stormAt(block, i, mainModel, models) {
  const voices = [...new Set([mainModel, FALLBACK_MODEL].filter((x) => x && models.includes(x)))];
  const by = [], codes = [];
  for (const mod of voices) { const c = column(block, "weather_code", mod, models)?.[i]; if (STORM_CODES.includes(c)) { by.push(mod); codes.push(c); } }
  return by.length ? { by, hail: codes.some((c) => HAIL_CODES.includes(c)) } : null;
}
const MINUTELY = { mm: "precipitation", snow: "snowfall", code: "weather_code", gust: "wind_gusts_10m", feels: "apparent_temperature", temp: "temperature_2m", day: "is_day", vis: "visibility" };
const HOURLY = { prob: "precipitation_probability", depth: "snow_depth", uv: "uv_index" };

// Lecture : { rows, hourly, prob (%), depth (m de neige au sol), uv } ; rows = [{ t (fin du pas, ms UTC), mm, snow (cm), code, gust, feels, temp, day, vis, src }],
// src = modèle de chaque valeur ({ mm: "meteofrance_seamless", … }).
export async function fetchNextHour({ lat, lon, models: plan = [] }, { fetchImpl = fetch, now = Date.now(), timeoutMs = TIMEOUTS.walk } = {}) {
  const models = walkModels(plan);
  const q = new URLSearchParams({
    latitude: String(r2(lat)), longitude: String(r2(lon)), // arrondi à 0,01° (environ 1 km), comme pour la prévision
    minutely_15: Object.values(MINUTELY).join(","),
    past_minutely_15: "1", forecast_minutely_15: String((MAX_OFFSET_H + 2) * 4),
    hourly: Object.values(HOURLY).join(","), forecast_hours: String(MAX_OFFSET_H + 2),
    models: models.join(","),
    timezone: "GMT", wind_speed_unit: "kmh",
  });
  const body = await timed(timeoutMs, async (signal) => {
    let res;
    try { res = await fetchImpl(`${API}?${q}`, { signal }); } catch (e) { throw new WalkError("network", `réseau indisponible (${e.message})`); }
    if (!res.ok) throw new WalkError("http", `Open-Meteo a répondu HTTP ${res.status}`);
    try { return await res.json(); } catch { throw new WalkError("format", "réponse illisible"); }
  }, () => new WalkError("timeout", `Open-Meteo ne répond pas (aucune réponse en ${seconds(timeoutMs)})`));
  const m = body?.minutely_15;
  if (!m || !Array.isArray(m.time) || !models.some((x) => Array.isArray(column(m, "precipitation", x, models)))) throw new WalkError("format", "réponse inattendue (pas de données à 15 minutes)");
  const OK = { mm: (v) => isNum(v) && v >= 0, day: (v) => v === 0 || v === 1 };
  const rows = m.time.map((s, i) => {
    const r = { t: Date.parse(`${s}Z`), src: {} }; // fuseau GMT demandé
    for (const [k, variable] of Object.entries(MINUTELY)) { const { v, m: mod } = pickAt(m, variable, i, models, OK[k]); r[k] = v; r.src[k] = mod; }
    r.storm = stormAt(m, i, r.src.code, models);
    return r;
  }).filter((r) => Number.isFinite(r.t));
  // valeurs horaires : une entrée par heure ; on prend celle de l'heure qui contient l'instant voulu (hourlyAt)
  const h = body?.hourly;
  const hourly = h && Array.isArray(h.time) ? h.time.map((s, i) => {
    const x = { t: Date.parse(`${s}Z`), src: {} };
    for (const [k, variable] of Object.entries(HOURLY)) { const { v, m: mod } = pickAt(h, variable, i, models); x[k] = v; x.src[k] = mod; }
    return x;
  }).filter((x) => Number.isFinite(x.t)) : [];
  return { rows, hourly, ...hourlyAt(hourly, now) };
}

// Probabilité, neige au sol et UV de l'heure qui contient l'instant `t`, par grandeur.
// Open-Meteo : la probabilité et l'UV d'une entrée « 18:00 » portent sur l'heure PRÉCÉDENTE (17 h → 18 h) ; on prend donc
// l'entrée qui se termine dans l'heure suivant `t` (jamais une autre heure à sa place). La neige au sol est une valeur instantanée :
// l'entrée la plus récente qui ne dépasse pas `t`.
const PRECEDING_HOUR = new Set(["prob", "uv"]);
const HOUR_MS = 60 * 60 * 1000;
export function hourlyAt(hourly, t) {
  const out = { prob: null, depth: null, uv: null };
  const src = { prob: null, depth: null, uv: null }; // modèle de chaque valeur retenue
  for (const key of Object.keys(out)) {
    if (PRECEDING_HOUR.has(key)) {
      const x = (hourly ?? []).find((e) => e.t > t && e.t <= t + HOUR_MS);
      if (x && isNum(x[key])) { out[key] = x[key]; src[key] = x.src?.[key] ?? null; }
      continue;
    }
    let bestT = -Infinity;
    for (const x of hourly ?? []) if (isNum(x[key]) && x.t <= t && x.t > bestT) { bestT = x.t; out[key] = x[key]; src[key] = x.src?.[key] ?? null; }
  }
  return { ...out, src };
}

// « Modèles : pluie, neige, type de temps, température, rafales : Météo-France ; probabilité : ECMWF ; visibilité, UV : choix automatique d'Open-Meteo. »
// Seules les grandeurs qui ont une valeur dans la fenêtre sont citées ; plusieurs modèles pour une même grandeur : « A puis B » (ordre des pas).
const SOURCE_WORDS = [["mm", "pluie"], ["snow", "neige"], ["code", "type de temps"], ["temp", "température"], ["feels", "ressenti"], ["gust", "rafales"], ["vis", "visibilité"]];
const HOURLY_WORDS = [["prob", "probabilité"], ["depth", "neige au sol"], ["uv", "UV"]];
export function walkSources(steps, hourSrc = {}) {
  const groups = new Map(); // libellé des modèles → grandeurs
  const add = (word, models) => {
    const label = [...new Set(models.filter(Boolean))].map(modelShort).join(" puis ");
    if (!label) return;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(word);
  };
  for (const [k, word] of SOURCE_WORDS) add(word, steps.map((s) => s.src?.[k]));
  for (const [k, word] of HOURLY_WORDS) add(word, [hourSrc?.[k]]);
  if (!groups.size) return null;
  return `Modèles : ${[...groups].map(([label, words]) => `${words.join(", ")} : ${label}`).join(" ; ")}.`;
}

// Heure locale « AAAA-MM-JJTHH:MM » d'un fuseau IANA → instant (ms UTC), sans bibliothèque ; illisible : null.
// Deux passes pour tomber juste autour des changements d'heure.
export function localToMs(iso, tz) {
  const m = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.exec(String(iso)); // format strict : Date.parse accepte aussi n'importe quoi
  const guess = m ? Date.parse(`${m[0]}:00Z`) : NaN;
  if (!Number.isFinite(guess)) return null;
  let fmt;
  try { fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch { return null; }
  const offset = (t) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
  };
  const first = guess - offset(guess);
  return guess - offset(first);
}

// Pas de 15 minutes qui concernent l'heure à venir : ceux qui se terminent après « maintenant » et commencent avant « maintenant + 1 h ».
export function windowSteps(rows, now) {
  return rows.filter((r) => r.t > now && r.t - STEP_MS < now + WINDOW_MS).sort((a, b) => a.t - b.t);
}

const minutes = (ms) => Math.max(0, Math.round(ms / 60000));
const roundDown5 = (m) => Math.floor(m / 5) * 5;
const min = (xs) => Math.min(...xs.filter(isNum));
const max = (xs) => Math.max(...xs.filter(isNum));

// Type et niveau d'un pas : 0 = sec ; kind = rain | snow | freezing
export function stepKind(s) {
  const wetRain = isNum(s.mm) && s.mm >= 0.05;
  if (FREEZING_CODES.includes(s.code) && wetRain) return { kind: "freezing", level: Math.max(1, rainLevel(s.mm)) };
  const wetSnow = (isNum(s.snow) && s.snow >= WET_SNOW_CM) || (SNOW_CODES.includes(s.code) && isNum(s.mm) && s.mm >= WET_MM);
  if (wetSnow) return { kind: "snow", level: Math.max(1, snowLevel(isNum(s.snow) ? s.snow : s.mm * SNOW_CM_PER_MM)) }; // sans hauteur de neige : estimée depuis l'eau
  return { kind: "rain", level: rainLevel(s.mm) };
}

// Remarques hors pluie : chaleur, froid, verglas, neige au sol, brouillard, vent, UV, nuit. sev : info | warn | danger.
export function walkRemarks(steps, { depth = null, uv = null, wet = false, now = Date.now() } = {}) {
  const r = [];
  const add = (sev, icon, text) => r.push({ sev, icon, text });
  const feelsMax = max(steps.map((s) => s.feels)), feelsMin = min(steps.map((s) => s.feels)), tempMin = min(steps.map((s) => s.temp));
  const gust = max(steps.map((s) => s.gust)), vis = min(steps.map((s) => s.vis));
  if (feelsMax >= HEAT_DANGER) add("danger", "🥵", `Chaleur dangereuse : ressenti jusqu'à ${Math.round(feelsMax)} °C. Évitez l'effort, sortez tôt ou tard, emportez beaucoup d'eau. (La vigilance canicule officielle n'est pas vérifiée ici : vigilance.meteofrance.fr.)`);
  else if (feelsMax >= HEAT_WARN) add("warn", "☀️", `Forte chaleur : ressenti jusqu'à ${Math.round(feelsMax)} °C. Eau, chapeau, crème solaire, pauses à l'ombre.`);
  if (feelsMin <= COLD_DANGER) add("danger", "🥶", `Froid extrême : ressenti ${Math.round(feelsMin)} °C. Risque d'engelures en quelques minutes sur la peau découverte : reportez, ou couvrez-vous entièrement.`);
  else if (feelsMin <= COLD_WARN) add("warn", "🧤", `Gel : ressenti ${Math.round(feelsMin)} °C. Bonnet, gants et plusieurs couches chaudes.`);
  else if (feelsMin <= COLD_INFO) add("info", "🧣", `Frais : ressenti ${Math.round(feelsMin)} °C. Prévoyez une couche chaude.`);
  if (tempMin <= 1 && wet) add("warn", "🧊", "Température proche de 0 °C avec des précipitations : risque de verglas sur les routes et les sentiers. Marchez prudemment, chaussures adhérentes.");
  else if (tempMin <= 0) add("info", "🧊", `Gel (${Math.round(tempMin)} °C) : plaques de verglas possibles là où le sol est humide ou à l'ombre.`);
  if (isNum(depth) && depth >= 0.01) add(depth >= 0.2 ? "warn" : "info", "⛄", `Neige au sol : environ ${Math.round(depth * 100)} cm. Chaussures adaptées ; sentiers glissants ou difficiles à lire.`);
  if (Number.isFinite(vis) && (vis < FOG_WARN_M || steps.some((s) => FOG_CODES.includes(s.code)))) {
    add(vis < FOG_DANGER_M ? "danger" : "warn", "🌫️", Number.isFinite(vis) && vis < FOG_WARN_M ? `Brouillard : visibilité jusqu'à ${Math.round(vis / 10) * 10} m. Restez sur des chemins connus, soyez visible.` : "Brouillard possible : visibilité réduite. Restez sur des chemins connus.");
  }
  if (gust >= GUST_DANGER) add("danger", "💨", `Vent très fort : rafales jusqu'à ${Math.round(gust)} km/h. Évitez forêts, crêtes et zones découvertes.`);
  else if (gust >= GUST_WARN) add("warn", "💨", `Vent fort : rafales jusqu'à ${Math.round(gust)} km/h. Prudence près des arbres.`);
  if (isNum(uv) && uv >= 6) add(uv >= 8 ? "warn" : "info", "🕶️", `Indice UV ${Math.round(uv)} (${uv >= 11 ? "extrême" : uv >= 8 ? "très élevé" : "élevé"}) : lunettes, chapeau, crème solaire.`);
  const days = steps.map((s) => s.day);
  if (days.every((d) => d === 0)) add("info", "🔦", "Il fait nuit : lampe frontale ou vêtements visibles, restez sur des chemins connus.");
  else if (days[0] === 1 && days.includes(0)) add("info", "🌆", `La nuit tombe dans environ ${minutes(steps[days.indexOf(0)].t - STEP_MS - now)} min : prévoyez une lampe.`);
  return r;
}

const WORDS = {
  rain: { noun: "pluie", verb: "Il pleut", unit: "mm/h", fact: "Pluie la plus forte" },
  snow: { noun: "neige", verb: "Il neige", unit: "cm/h", fact: "Neige la plus forte" },
};

// Verdict. Niveaux : go, caution, short, light, wait, shower, mixed, no, storm, ice, unknown.
// `now` est le début de la fenêtre (maintenant, ou le départ décalé de quelques heures) ; ctx.depart = « 20:54 » quand le départ est décalé.
export function walkAdvice(rows, ctx = {}, now = Date.now()) {
  const { prob = null, depth = null, uv = null, depart = null, observedWet = false } = typeof ctx === "number" || ctx === null ? { prob: ctx } : ctx; // ancienne signature : (rows, prob, now)
  const later = depart !== null;
  const steps = windowSteps(rows, now);
  if (steps.length < MIN_STEPS || steps.some((s) => s.mm === null)) {
    return { level: "unknown", title: "Je ne sais pas", text: "Les prévisions à 15 minutes sont incomplètes pour votre position : impossible de conclure. Regardez le ciel, ou consultez le tableau des prochaines heures.", steps, facts: [], remarks: [], kind: "rain" };
  }
  const info = steps.map(stepKind);
  const lvl = info.map((i) => i.level);
  const wet = lvl.map((l) => l > 0);
  const anyWet = wet.some(Boolean);
  const kind = info.some((i) => i.kind === "freezing") ? "freezing" : info.some((i) => i.kind === "snow") ? "snow" : "rain";
  const W = WORDS[kind === "snow" ? "snow" : "rain"];
  const maxLvl = Math.max(...lvl);
  // orage : modèle principal (code du pas) ou choix automatique (s.storm, voir stormAt)
  const stormBy = [...new Set(steps.flatMap((s) => s.storm?.by ?? (STORM_CODES.includes(s.code) ? [s.src?.code ?? null] : [])))];
  const thunder = stormBy.length > 0;
  const hail = steps.some((s) => s.storm?.hail || HAIL_CODES.includes(s.code));
  const mainModel = steps.find((s) => s.src?.code)?.src.code ?? null;
  const mmSum = steps.reduce((a, s) => a + s.mm, 0), snowSum = steps.reduce((a, s) => a + (isNum(s.snow) ? s.snow : 0), 0);
  const peak = kind === "snow" ? Math.max(...steps.map((s) => (isNum(s.snow) ? s.snow : s.mm * SNOW_CM_PER_MM))) * 4 : mmPerHour(Math.max(...steps.map((s) => s.mm)));
  const remarks = walkRemarks(steps, { depth, uv, wet: anyWet, now });
  const facts = [];
  if (maxLvl > 0) facts.push(`${W.fact} : ${peak < 10 ? fr1(peak) : Math.round(peak)} ${W.unit} (${LEVEL_WORD[maxLvl]}).`);
  facts.push(kind === "snow" ? `Cumul de neige approximatif sur l'heure : ${fr1(snowSum)} cm.` : `Cumul approximatif sur l'heure : ${fr1(mmSum)} mm.`);
  if (isNum(prob)) facts.push(`Probabilité de précipitations de ${later ? "l'heure de départ" : "l'heure en cours"} : ${Math.round(prob)} % (la probabilité et la quantité sont deux informations distinctes).`);
  const tmin = min(steps.map((s) => s.temp)), fmin = min(steps.map((s) => s.feels));
  if (Number.isFinite(tmin)) facts.push(`Température : ${Math.round(tmin)} °C${Number.isFinite(fmin) ? `, ressentie ${Math.round(fmin)} °C au plus bas` : ""}.`);
  const danger = remarks.some((r) => r.sev === "danger");
  const out = (level, title, text) => ({ level, title, text: later ? `Départ à ${depart} : ${text}` : text, steps, facts, remarks, kind });

  if (kind === "freezing") return out("ice", "Pluie verglaçante : ne sortez pas", "Les modèles annoncent de la pluie ou de la bruine verglaçante dans l'heure qui suit : chaussées et trottoirs deviennent une patinoire. La sortie est déconseillée.");
  if (thunder) {
    // qui l'annonce : dit honnêtement quand seul le choix automatique voit l'orage et pas le modèle principal
    const named = stormBy.filter(Boolean);
    const onlyOther = mainModel && !named.includes(mainModel);
    const nm = (x) => (x === FALLBACK_MODEL ? "le choix automatique d'Open-Meteo" : modelShort(x)); // avec l'article, dans une phrase
    const who = !named.length ? "Les modèles annoncent" : named.length > 1 ? `${capFirst(named.map(nm).join(" et "))} annoncent` : `${capFirst(nm(named[0]))} annonce`;
    const res = out("storm", "Orage possible : restez à l'abri", `${who} de l'orage${hail ? ", avec risque de grêle," : ""} dans l'heure qui suit${onlyOther ? ` (${modelShort(mainModel)} n'en prévoit pas)` : ""}. Ne partez pas vous promener, surtout en terrain découvert ou sous les arbres.`);
    return { ...res, storm: { by: named, main: mainModel, onlyOther: Boolean(onlyOther) } };
  }
  if (!anyWet) {
    // Bruine ou gouttes annoncées sans cumul notable (type de temps ≥ 51, ou un peu d'eau sous le seuil de 0,1 mm par quart d'heure) :
    // jamais « pas une goutte » (même règle que l'écran d'accueil, 26/11/2026 : bruine vécue un matin où tout était « au vert »).
    const drops = steps.some((s) => s.mm > 0 || (isNum(s.code) && s.code >= DROPS_CODE));
    if (danger) return out("caution", "Pas de pluie, mais des conditions difficiles", `${drops ? "Au plus quelques gouttes ou un peu de bruine dans l'heure qui suit" : "Aucune précipitation prévue dans l'heure qui suit"}, mais lisez attentivement les remarques ci-dessous avant de partir.`);
    if (observedWet && !drops) return out("light", "Rien de prévu, mais observé à proximité", "Les modèles ne prévoient aucune précipitation dans l'heure qui suit, mais une station d'aéroport proche en signale en ce moment (ci-dessous) : prévoyez une veste.");
    return drops
      ? out("light", "Au plus quelques gouttes", "Les modèles annoncent un peu de bruine ou quelques gouttes dans l'heure qui suit, sans cumul notable. Rien qui empêche de marcher ; une veste suffit.")
      : out("go", "Pas une goutte en vue", "Aucune précipitation prévue dans l'heure qui suit : vous pouvez partir vous promener.");
  }

  const first = wet.indexOf(true), last = wet.lastIndexOf(true);
  const waitMin = minutes(steps[first].t - STEP_MS - now);                       // minutes avant le début
  const endMin = last <= steps.length - 3 ? minutes(steps[last].t - now) : null; // minutes avant la fin, si elle finit dans l'heure
  const runs = wet.reduce((n, w, i) => n + (w && (i === 0 || !wet[i - 1]) ? 1 : 0), 0);
  const snow = kind === "snow";
  const gear = snow ? "des vêtements chauds et imperméables, des chaussures adaptées" : "un imperméable";

  if (maxLvl === 1) {
    const when = first === 0 ? `Une ${W.noun} faible est prévue` : `Une ${W.noun} faible arrive dans environ ${waitMin} min`;
    const end = endMin !== null ? `, jusqu'à environ ${endMin} min` : "";
    return snow
      ? out("light", "Quelques flocons : bien couvert, ça passe", `${when}${end}. Avec ${gear}, la promenade reste agréable.`)
      : out("light", "Petite pluie : l'imper suffit", `${when}${end}. Avec un imperméable ou un parapluie, la promenade reste agréable ; sans, vous serez vite humide.`);
  }
  if (runs >= 2) return out("mixed", snow ? "Des chutes de neige qui se succèdent" : "Des averses qui se succèdent", `${snow ? "Neige" : "Pluie"} ${LEVEL_WORD[maxLvl]} par moments, avec des pauses courtes. ${snow ? "Vous serez sous la neige à un moment ou à un autre" : "Vous serez mouillé à un moment ou à un autre"} : prévoyez ${gear}, ou restez à l'abri.`);
  if (first > 0 && waitMin >= 30) {
    const back = Math.max(5, roundDown5(waitMin / 2));
    return out("short", "Oui, mais restez près de chez vous", `Le sec tient environ ${waitMin} min, puis ${snow ? "de la neige" : "une pluie"} ${LEVEL_WORD[maxLvl]} arrive. Prévoyez une balade courte (aller-retour d'environ ${back} min) ou emportez ${gear}.`);
  }
  if (first === 0 && endMin !== null) return out("wait", "Mieux vaut attendre un peu", `${W.verb} ${later ? "au départ" : "en ce moment"} (${W.noun} ${LEVEL_WORD[maxLvl]}), mais ça se termine dans environ ${endMin} min. Attendez la fin avant de partir.`);
  if (first > 0 && endMin !== null) return out("shower", snow ? "Une chute de neige va passer" : "Une averse va passer", `${snow ? "Une neige" : "Une pluie"} ${LEVEL_WORD[maxLvl]} passe dans environ ${waitMin} à ${endMin} min. Partez après, ou restez à l'abri pendant ce temps.`);
  const start = first === 0 ? W.verb : `${snow ? "La neige commence" : "La pluie commence"} dans environ ${waitMin} min`;
  return out("no", snow ? "Il va neiger toute l'heure" : "Vous allez prendre la sauce", `${start}, et ${snow ? "la neige" : "la pluie"} ${LEVEL_WORD[maxLvl]} dure toute l'heure à venir. Reportez la promenade, ou sortez équipé (${gear}, et un abri en vue).`);
}
