// Rendu des sections (cahier 4 à 8, 13). Les helpers purs sont testables sous Node ; `document` n'est utilisé que dans les builders.
import { ECCC_ATTRIBUTION, ECCC_LICENCE_URL } from "./warnings.js?v=79a17bd6";
import { modelShort, modelLabel, next24h, firstWeek } from "./weather-provider.js?v=9f2e113b";

export const TABS = [
  { id: "precip", label: "Précipitations", tip: "Afficher la pluie : quantité et probabilité" },
  { id: "temp", label: "Température", tip: "Afficher les températures" },
  { id: "wind", label: "Vent", tip: "Afficher le vent et les rafales" },
];

// ---------- helpers purs ----------
const nf1 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
export const isNum = (v) => typeof v === "number" && Number.isFinite(v);
export const num1 = (v) => (isNum(v) ? nf1.format(v) : "—");
export const num0 = (v) => (isNum(v) ? nf0.format(Math.round(v) + 0) : "—"); // +0 évite « -0 »
export const deg = (v) => (isNum(v) ? `${num0(v)}°` : "—");

// Codes WMO → libellé français et pictogramme (jour, nuit). Les pictogrammes sont des emoji colorés.
const WMO = {
  0: ["Ciel dégagé", "☀️", "🌙"], 1: ["Plutôt dégagé", "🌤️", "🌙"], 2: ["Partiellement nuageux", "⛅", "☁️"], 3: ["Couvert", "☁️", "☁️"],
  45: ["Brouillard", "🌫️", "🌫️"], 48: ["Brouillard givrant", "🌫️", "🌫️"],
  51: ["Bruine faible", "🌦️", "🌧️"], 53: ["Bruine", "🌦️", "🌧️"], 55: ["Bruine dense", "🌧️", "🌧️"],
  56: ["Bruine verglaçante", "🌧️", "🌧️"], 57: ["Bruine verglaçante dense", "🌧️", "🌧️"],
  61: ["Pluie faible", "🌦️", "🌧️"], 63: ["Pluie", "🌧️", "🌧️"], 65: ["Pluie forte", "🌧️", "🌧️"],
  66: ["Pluie verglaçante", "🌧️", "🌧️"], 67: ["Pluie verglaçante forte", "🌧️", "🌧️"],
  71: ["Neige faible", "🌨️", "🌨️"], 73: ["Neige", "❄️", "❄️"], 75: ["Neige forte", "❄️", "❄️"], 77: ["Grains de neige", "🌨️", "🌨️"],
  80: ["Averses faibles", "🌦️", "🌧️"], 81: ["Averses", "🌧️", "🌧️"], 82: ["Averses violentes", "🌧️", "🌧️"],
  85: ["Averses de neige", "🌨️", "🌨️"], 86: ["Fortes averses de neige", "❄️", "❄️"],
  95: ["Orage", "⛈️", "⛈️"], 96: ["Orage avec grêle", "⛈️", "⛈️"], 99: ["Orage avec forte grêle", "⛈️", "⛈️"],
};
export function weatherInfo(code, night = false) {
  const e = WMO[code];
  if (!e) return { label: "—", icon: "·" };
  return { label: e[0], icon: night ? e[2] : e[1] };
}

// Nuit d'après le lever/coucher du jour concerné (chaînes ISO locales, comparables telles quelles).
export function isNight(timeISO, daily) {
  const day = daily.find((d) => d.date === timeISO.slice(0, 10));
  const rise = day?.sunrise.value, set = day?.sunset.value;
  if (!rise || !set) return false;
  return timeISO < rise || timeISO > set;
}

// Jour, nuit, ou null si le lever et le coucher du jour ne sont pas fournis (rien n'est deviné).
export function sunState(timeISO, daily) {
  const day = daily.find((d) => d.date === timeISO.slice(0, 10));
  if (!day?.sunrise.value || !day?.sunset.value) return null;
  return isNight(timeISO, daily) ? "night" : "day";
}

// Lever et coucher du soleil d'un jour (YYYY-MM-DD), en heures locales du lieu ; « — » si non fourni.
// Open-Meteo code la nuit polaire par lever = coucher, et le soleil de minuit par minuit → minuit le lendemain.
export function sunTimes(date, daily) {
  const day = daily.find((d) => d.date === date);
  const rise = day?.sunrise.value ?? null, set = day?.sunset.value ?? null;
  if (rise && rise === set) return { polar: "Soleil couché toute la journée" };
  if (rise && set && rise.endsWith("T00:00") && set.endsWith("T00:00") && set > rise) return { polar: "Soleil levé toute la journée" };
  const hm = (iso) => (iso ? iso.slice(11, 16) : "—");
  return { polar: null, rise: hm(rise), set: hm(set) };
}

export const hourLabel = (timeISO) => `${parseInt(timeISO.slice(11, 13), 10)} h`;
// Début de l'heure sur laquelle porte une valeur « heure précédente » (pluie, probabilité) : la ligne « 18:00 » couvre 17 h → 18 h.
export const hourStartLabel = (timeISO) => `${(parseInt(timeISO.slice(11, 13), 10) + 23) % 24} h`;

// Heure (début de l'heure si `start`), précédée de « demain » quand elle tombe après `today` (YYYY-MM-DD local) :
// à 17 h, « entre 10 h et 16 h » se lirait comme une pluie déjà passée.
function outlookHour(timeISO, today, start = false) {
  const iso = start ? new Date(Date.parse(`${timeISO}:00Z`) - 3600000).toISOString().slice(0, 16) : timeISO; // heures locales traitées telles quelles
  return `${today && iso.slice(0, 10) > today ? "demain " : ""}${hourLabel(iso)}`;
}
// « entre 10 h et 16 h », « entre 22 h et demain 3 h », « entre demain 10 h et 16 h » (« demain » une seule fois).
export function outlookSpan(firstTime, lastTime, today) {
  const a = outlookHour(firstTime, today, true), b = outlookHour(lastTime, today);
  return `entre ${a} et ${a.startsWith("demain ") && b.startsWith("demain ") ? b.slice("demain ".length) : b}`;
}

export const RISK_PCT = 30; // 0 mm prévu mais « pluie possible » à partir de cette probabilité (page principale et écran d'accueil)
export const LIKELY_PCT = 70; // « pluie probable » à partir de cette probabilité (28/11/2026, choix de l'utilisateur ; seuils propres à l'application)
export const probWord = (p) => (p >= LIKELY_PCT ? "probable" : "possible");
// Phrase pratique sur les 24 h ; null si aucune donnée de pluie. Pas de conseil de sortie (hors V1).
// `today` : date locale de la situation actuelle ; sans elle, aucun « demain » n'est ajouté.
export function rainOutlook(hours, today = null) {
  if (!hours.length) return null;
  const withPrecip = hours.filter((h) => isNum(h.precip.value));
  const probs = hours.filter((h) => isNum(h.precipProb.value));
  if (!withPrecip.length && !probs.length) return null;
  const wet = withPrecip.filter((h) => h.precip.value >= 0.2);
  if (wet.length) {
    const total = wet.reduce((s, h) => s + h.precip.value, 0);
    // Chaque valeur couvre l'heure qui se termine à l'heure de sa ligne : la pluie commence au plus tôt une heure avant la première.
    return `Pluie attendue ${outlookSpan(wet[0].time, wet[wet.length - 1].time, today)} (environ ${num1(total)} mm au total).`;
  }
  // « Sec » seulement si aucune goutte n'est attendue (0 mm à chaque heure) : 0,1 mm = quelques gouttes (règle de l'utilisateur, 28/11/2026).
  const drops = withPrecip.filter((h) => h.precip.value > 0);
  if (drops.length) {
    const total = drops.reduce((s, h) => s + h.precip.value, 0);
    return `Au plus quelques gouttes ${outlookSpan(drops[0].time, drops[drops.length - 1].time, today)} (${num1(total)} mm au total).`;
  }
  if (withPrecip.length < hours.length) return "Données de pluie incomplètes sur cette période."; // une heure inconnue : jamais « sec »
  const best = probs.reduce((m, h) => (!m || h.precipProb.value > m.precipProb.value ? h : m), null);
  if (best && best.precipProb.value >= RISK_PCT) return `Sec, mais pluie ${probWord(best.precipProb.value)} ${outlookSpan(best.time, best.time, today)} (${num0(best.precipProb.value)} %).`;
  return "Sec sur les 24 prochaines heures.";
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
export const compass = (d) => (isNum(d) ? COMPASS[Math.round((((d % 360) + 360) % 360) / 45) % 8] : null);
// Vent (26/11/2026) : d'où il vient, en 8 directions (« vent d'est »). La girouette, elle, pointe vers où il va, nord en haut.
const FROM8 = ["du nord", "du nord-est", "d'est", "du sud-est", "du sud", "du sud-ouest", "d'ouest", "du nord-ouest"];
export const windFrom = (deg) => (isNum(deg) ? FROM8[Math.round((((deg % 360) + 360) % 360) / 45) % 8] : null);
// Girouette : flèche à empennage dessinée vers le sud, tournée de la direction d'où vient le vent (convention de la carte :
// la pointe va où va le vent ; nord en haut). Sans direction connue, rien n'est dessiné. Écran d'accueil, page, vue 12 h (28/11/2026).
const VANE = "M12 3.5v17M12 20.5l-3.5-4.5M12 20.5l3.5-4.5M12 3.5l-3-2.5M12 6.5l-3-2.5M12 3.5l3-2.5M12 6.5l3-2.5";
export function vane(dir, small = false) {
  if (!isNum(dir)) return null;
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg"), path = document.createElementNS(ns, "path");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", `vane${small ? " is-small" : ""}`); svg.setAttribute("focusable", "false"); svg.setAttribute("aria-hidden", "true");
  path.setAttribute("d", VANE); path.style.transform = `rotate(${Math.round(dir)}deg)`; svg.append(path);
  return svg;
}

// Provenance d'un groupe de valeurs : un seul libellé si tous les champs viennent du même modèle, sinon détail par champ.
// Ligne « Modèles » (28/11/2026, vue unique) : chaque valeur affichée garde son modèle, en une ligne sous son bloc.
// models : modèle de chaque valeur, dans l'ordre (null = valeur absente, ignorée) ; at(i) = « au mar 01/12 », « à 14 h »…
export function modelRun(models, at) {
  const runs = [];
  models.forEach((m, i) => { if (!m) return; const last = runs.at(-1); if (last && last.m === m) last.i = i; else runs.push({ m, i }); });
  if (!runs.length) return "—";
  return runs.map((r, k) => (k < runs.length - 1 ? `${modelShort(r.m)} jusqu'${at(r.i)}` : modelShort(r.m))).join(", puis ");
}
// fields : [[étiquette, texte de modelRun]]. Même texte partout : un seul, sans étiquette.
export function modelsText(fields) {
  const texts = fields.map(([, t]) => t);
  const one = texts.every((t) => t === texts[0]);
  const body = one ? texts[0] : fields.map(([l, t]) => `${l} ${t}`).join(" · ");
  return `${!one || body.includes(", puis ") ? "Modèles" : "Modèle"} : ${body}`;
}
const modelsP = (text) => h("p", { class: "muted small models-line", text });

export const barPct = (v, max) => (isNum(v) && max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : null);
// Une valeur non nulle reste visible (4 % minimum) ; un vrai zéro donne une barre vide.
export const minVisible = (pct) => (pct > 0 ? Math.max(pct, 4) : 0);
export const scaleMax = (values, floor) => Math.max(floor, ...values.filter(isNum));
// Gamme froid → chaud (teinte bleue à orangée), bornée à [-5, 35] °C.
export function tempColor(t) {
  const x = Math.max(-5, Math.min(35, t));
  return `hsl(${Math.round(225 - ((x + 5) / 40) * 195)}, 48%, 58%)`; // teintes adoucies (charte pastel)
}

// Mot d'un jour pour le résumé (28/11/2026) : « pluie probable » dès LIKELY_PCT, « pluie possible » dès RISK_PCT ; en dessous, avec de l'eau :
// « quelques gouttes » sous 1 mm, « pluie peu probable » à partir de 1 mm (ou « pluie » sans probabilité). 0 mm et moins de RISK_PCT : non cité.
export function rainDayWord(mm, p) {
  if (isNum(p) && p >= RISK_PCT) return `pluie ${probWord(p)}`;
  if (!isNum(mm) || mm <= 0) return null;
  if (mm < 1) return "quelques gouttes";
  return isNum(p) ? "pluie peu probable" : "pluie";
}
const joinFr = (a) => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} et ${a[a.length - 1]}`);
// Jours cités d'un groupe, regroupés par mot, chacun avec ses chiffres : « pluie possible mer 02/12 (0,7 mm, 63 %) et jeu 03/12 (4,1 mm, 61 %) ».
// Plus de deux jours : les deux plus marqués (probabilité, puis quantité), suivis de « … ».
function citeRainDays(days) {
  const cited = days.map((d) => ({ d, word: rainDayWord(d.precipSum.value, d.precipProbMax?.value) })).filter((x) => x.word);
  if (!cited.length) return null;
  const mark = (x) => (x.d.precipProbMax?.value ?? 0) * 1000 + (x.d.precipSum.value ?? 0);
  const kept = cited.length > 2 ? [...cited].sort((a, b) => mark(b) - mark(a)).slice(0, 2).sort((a, b) => a.d.dayIndex - b.d.dayIndex) : cited;
  const nums = (d) => [isNum(d.precipSum.value) ? `${num1(d.precipSum.value)}\u00a0mm` : null, isNum(d.precipProbMax?.value) ? `${num0(d.precipProbMax.value)}\u00a0%` : null].filter(Boolean).join(", ");
  const groups = [];
  for (const x of kept) { const g = groups.find((y) => y.word === x.word); if (g) g.items.push(x); else groups.push({ word: x.word, items: [x] }); }
  return groups.map((g) => `${g.word} ${joinFr(g.items.map((x) => `${dayLabel(x.d.date)} (${nums(x.d)})`))}`).join(", ") + (cited.length > 2 ? ", …" : "");
}
const capFirst = (t) => t[0].toUpperCase() + t.slice(1);
// Résumé des 7 jours : températures, puis la pluie jour par jour (aujourd'hui à J+3, puis « Moins fiable : » J+4 à J+6), jamais « sec » avec de l'eau.
export function weekSummary(days) {
  const maxes = days.map((d) => d.tempMax.value).filter(isNum);
  const parts = [];
  if (maxes.length) parts.push(`Maximales de ${num0(Math.min(...maxes))} à ${num0(Math.max(...maxes))} °C sur la période.`);
  const near = days.filter((d) => d.dayIndex <= RAIN_MM_UNTIL), far = days.filter((d) => d.dayIndex > RAIN_MM_UNTIL);
  const allDry = (list) => list.length > 0 && list.every((d) => d.precipSum.value === 0 && !(d.precipProbMax?.value >= RISK_PCT));
  const a = citeRainDays(near), b = citeRainDays(far);
  if (!a && !b && allDry(days)) parts.push(`Sec sur les ${days.length} jours.`);
  else {
    if (a) parts.push(`${capFirst(a)}.`);
    else if (allDry(near)) parts.push(near.length > 1 ? `Sec jusqu'à ${dayLabel(near[near.length - 1].date)}.` : "Sec aujourd'hui.");
    if (b) parts.push(`Moins fiable : ${b}.`);
    if ([...near, ...far].some((d) => !isNum(d.precipSum.value))) parts.push("Pluie inconnue certains jours.");
  }
  return parts.join(" ");
}

// Jours marqués d'une pastille rouge : seuils propres à l'application (pas une vigilance officielle), un sujet par onglet.
// Pluie : jusqu'à J+3 seulement (quantité non fiable au-delà, mesuré) ; température et vent : jusqu'à J+6, dernier jour affiché (page coupée à 7 jours le 28/11/2026).
// La valeur comparée est la valeur AFFICHÉE (arrondie), pour qu'un « 90 km/h » lu soit toujours marqué.
export const EXTREME = { rain: 50, gust: 90, hot: 35, cold: -10 };
export const EXTREME_UNTIL = 6;
export function extremeOf(d, tab) {
  const out = [];
  if (tab === "precip") {
    const v = d.precipSum.value;
    if (d.dayIndex <= RAIN_MM_UNTIL && isNum(v) && Math.round(v * 10) / 10 >= EXTREME.rain) {
      out.push({ name: "fortes précipitations", value: `${num1(v)} mm prévus`, rule: `Jour marqué à partir de ${EXTREME.rain} mm dans la journée.`, model: d.precipSum.model });
    }
  } else if (d.dayIndex <= EXTREME_UNTIL && tab === "wind") {
    const v = d.gustMax.value;
    if (isNum(v) && Math.round(v) >= EXTREME.gust) out.push({ name: "rafales très fortes", value: `Rafales jusqu'à ${num0(v)} km/h`, rule: `Jour marqué à partir de ${EXTREME.gust} km/h.`, model: d.gustMax.model });
  } else if (d.dayIndex <= EXTREME_UNTIL && tab === "temp") {
    const hot = d.tempMax.value, cold = d.tempMin.value;
    if (isNum(hot) && Math.round(hot) >= EXTREME.hot) out.push({ name: "forte chaleur", value: `Maximale de ${num0(hot)} °C`, rule: `Jour marqué à partir de ${EXTREME.hot} °C.`, model: d.tempMax.model });
    if (isNum(cold) && Math.round(cold) <= EXTREME.cold) out.push({ name: "grand froid", value: `Minimale de ${num0(cold)} °C`, rule: `Jour marqué à ${num0(EXTREME.cold)} °C ou moins.`, model: d.tempMin.model });
  }
  return out;
}
const EXTREME_LIMIT = {
  precip: "La quantité exacte à un endroit précis reste incertaine.",
  wind: "Valeur calculée par un modèle : le relief et l'exposition du lieu peuvent changer les rafales.",
  temp: "Température de l'air calculée par un modèle, pas le ressenti.",
};
// Contenu de la fenêtre d'explication (textes simples, testés sans page).
export function extremeText(d, tab) {
  const found = extremeOf(d, tab);
  if (!found.length) return null;
  const date = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${d.date}T12:00:00Z`));
  return {
    title: `${date[0].toUpperCase()}${date.slice(1)}\u00a0: ${found.map((x) => x.name).join(", ")}`,
    lines: found.map((x) => ({ value: `${x.value}${x.model ? ` (${modelShort(x.model)})` : ""}.`, rule: x.rule })),
    note: `Seuil propre à l'application\u00a0: ce n'est pas une vigilance officielle. ${EXTREME_LIMIT[tab]}`,
  };
}
// Nom du jour : simple texte, ou pastille-bouton qui ouvre l'explication.
function dayName(d, tab) {
  const label = d.dayIndex === 0 ? "Auj." : dayLabel(d.date), found = extremeOf(d, tab);
  if (!found.length) return label;
  const what = found.map((x) => x.name).join(", ");
  return h("button", { type: "button", class: "day-alert", "data-date": d.date, "aria-haspopup": "dialog", title: `${what[0].toUpperCase()}${what.slice(1)} : voir l'explication` },
    label, h("span", { class: "sr-only", text: `, ${what}` }));
}

export function dayLabel(dateISO) {
  return new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "numeric", timeZone: "UTC" })
    .format(new Date(`${dateISO}T12:00:00Z`)).replace(".", "");
}
export const formatLocal = (instant, tz, opts) => new Intl.DateTimeFormat("fr-FR", { timeZone: tz, ...opts }).format(instant);
// Ligne de date sous le choix du lieu (28/11/2026) : « Samedi 28 novembre, 14:15 », à l'heure du lieu ; « …, heure de Tokyo »
// seulement si le fuseau du lieu n'est pas celui de l'appareil (le nom du lieu est déjà dans la liste et la barre fixe).
export function whereText(instant, tz, deviceTz, name) {
  const day = formatLocal(instant, tz, { weekday: "long", day: "numeric", month: "long" });
  const time = formatLocal(instant, tz, { hour: "2-digit", minute: "2-digit" });
  const other = tz !== deviceTz;
  return `${day.charAt(0).toUpperCase()}${day.slice(1)}, ${time}${other ? `, heure ${name ? `de ${name}` : "du lieu"}` : ""}`;
}

// Modèles des seules valeurs affichées (le lever/coucher du soleil, non affiché, ne compte pas).
const DAILY_SHOWN = ["weatherCode", "tempMax", "tempMin", "precipSum", "precipProbMax", "windMax", "gustMax", "windDirDominant"];
const HOURLY_SHOWN = ["temp", "apparent", "precip", "precipProb", "wind", "gust", "weatherCode"];
export function modelsOf(items, keys) {
  const set = new Set();
  for (const it of items) for (const k of keys) if (it[k]?.model) set.add(it[k].model);
  return [...set];
}

// Modèles réellement affichés : 24 h + jours J à J+6.
export function displayedModels(data) {
  return [...new Set([...modelsOf(data.daily, DAILY_SHOWN), ...modelsOf(next24h(data), HOURLY_SHOWN)])];
}

// Dernier jour où la quantité de pluie est jugée correcte (mesure sur pluviomètres : au-delà, elle ne bat plus guère « toujours sec »).
// Les mm restent écrits ensuite (demande du 23/11/2026) ; l'aide les dit peu fiables.
export const RAIN_MM_UNTIL = 3;

// ---------- construction DOM ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "style") for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk, sv);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function buildCurrent(data) {
  const c = data.current, d0 = data.daily[0];
  const night = c.time ? isNight(c.time, data.daily) : false;
  const info = weatherInfo(c.weatherCode, night);
  const outlook = rainOutlook(next24h(data), c.time ? c.time.slice(0, 10) : null);
  return h("div", { class: "card current" },
    h("div", { class: "cur-main" },
      h("span", { class: "cur-icon", "aria-hidden": "true", text: info.icon }),
      h("div", {}, h("div", { class: "cur-desc", text: info.label }),
        h("div", { class: "muted", text: `Ressenti ${deg(c.apparent)}` }))),
    // L'origine « modèle » reste signalée ; l'heure locale est sous la pression (whereText).
    h("p", { class: "muted small cur-note-short", text: c.time ? `Valeurs calculées pour ${hourLabel(c.time)} (modèle).` : "Heure de la situation indisponible." }),
    buildSun(sunTimes(c.time ? c.time.slice(0, 10) : d0.date, data.daily)),
    h("div", { class: "cur-grid" },
      // « Probabilité » partout (28/11/2026) ; le chiffre est le maximum horaire du jour, pas celui de l'heure : dit sous la valeur.
      stat("precip", "Probabilité de pluie", "Probabilité", isNum(d0.precipProbMax.value) ? `${num0(d0.precipProbMax.value)} %` : "—", "max horaire du jour"),
      stat("temp", "Min / max du jour", "Min / max", `${deg(d0.tempMin.value)}\u00a0/ ${deg(d0.tempMax.value)}`),
      // Vent écrit comme sur l'écran d'accueil (28/11/2026) : girouette, « 12 km/h », puis « raf. 25 · vent du sud-est ».
      stat("wind", "Vent actuel", "Vent", [vane(c.windDir, true), `${num0(c.wind)}\u00a0km/h`],
        `raf.\u00a0${num0(c.gust)}${windFrom(c.windDir) ? ` · vent ${windFrom(c.windDir)}` : ""}`)),
    modelsP(curModels(d0)),
    outlook ? h("p", { class: "outlook", text: outlook }) : null);
}
// Modèles de la situation : probabilité et min / max du jour (la valeur actuelle elle-même est « calculée (modèle) », sans nom publié).
export function curModels(d0) {
  const at = () => "";
  const mn = modelRun([d0.tempMin.model], at), mx = modelRun([d0.tempMax.model], at);
  const temp = mn === mx ? [["min / max", mn]] : [["min", mn], ["max", mx]];
  return modelsText([["%", modelRun([d0.precipProbMax.model], at)], ...temp]);
}
function buildSun(sun) {
  const one = (kind, name, time) => h("span", { class: `sun sun-${kind}` }, h("span", { class: "sr-only", text: `${name} du soleil : ` }), time);
  return h("p", { class: "muted small cur-sun", title: "Lever et coucher du soleil aujourd'hui, à l'heure du lieu" },
    sun.polar ?? [one("rise", "Lever", sun.rise), " ", one("set", "Coucher", sun.set)]);
}
// value : texte, ou liste de nœuds (girouette + texte) ; sub : précision toujours visible sous la valeur.
function stat(family, label, shortLabel, value, sub = null) {
  return h("div", { class: `stat fam-${family}` },
    h("div", { class: "muted small stat-label" }, h("span", { class: "l-long", text: label }), h("span", { class: "l-short", text: shortLabel })),
    Array.isArray(value) ? h("div", { class: "stat-val" }, ...value) : h("div", { class: "stat-val", text: value }),
    sub ? h("div", { class: "muted small stat-sub", text: sub }) : null);
}

// Épingle rouge = position actuelle de l'appareil, et rien d'autre (page principale et vue 🥾).
export const buildPin = () => h("span", { class: "pin", "aria-hidden": "true", text: "📍" });
// Ligne fixe du haut : lieu (à gauche) et situation calculée (à droite) ; le bouton de vue est entre les deux.
export function buildTopPlace(data, { here = false } = {}) {
  return h("span", { class: "top-place", title: `${data.location.name} (${data.location.country})` },
    here ? buildPin() : null,
    h("span", { class: "top-name", text: data.location.name }));
}
export function buildTopNow(data) {
  const c = data.current;
  const info = weatherInfo(c.weatherCode, c.time ? isNight(c.time, data.daily) : false);
  return h("span", { class: "top-now", title: "Valeurs calculées (modèle)" },
    h("span", { class: "top-icon", "aria-hidden": "true", text: info.icon }),
    h("strong", { text: deg(c.temp) }),
    h("span", { class: "top-desc", text: info.label }));
}

// Pression au niveau de la mer, en hPa entiers, sans séparateur de milliers (« 1013 hPa ») ; absente : « — hPa ».
export const pressureText = (data) => (isNum(data?.current?.pressure) ? `${Math.round(data.current.pressure)} hPa` : "— hPa");

// Vue minimale : une ligne par heure à venir (précipitations, température, vent), sans rien d'autre.
export const MINI_HOURS = 12;
export const MINI_MM_FULL = 3; // barre de pluie (mm) : échelle fixe et proportionnelle de 0 à 3 mm ; au-delà, barre pleine et rouge (≈ 6 % des heures pluvieuses prévues en France, mesuré sur 8 villes)
const hourOf = (timeISO) => parseInt(timeISO.slice(11, 13), 10);
export function miniRows(data, n = MINI_HOURS) {
  const hours = next24h(data).slice(0, n);
  // Petits graphiques : pluie = pourcentage (0 à 100, comme partout) ; température = position entre le min et le max de ces heures ; vent = échelle propre à ces heures.
  const temps = hours.map((x) => x.temp.value).filter(isNum);
  const tmin = Math.min(...temps), tmax = Math.max(...temps);
  const wMax = scaleMax(hours.map((x) => x.gust.value ?? x.wind.value), 10);
  return hours.map((x) => {
    const w = weatherInfo(x.weatherCode.value, isNight(x.time, data.daily));
    return {
    time: x.time,
    sun: sunState(x.time, data.daily),
    afterNoon: hourOf(x.time) === 13, // la ligne de 13 h est précédée d'un trait : matin / après-midi
    icon: w.icon, sky: w.label,
    mmPct: barPct(x.precip.value, MINI_MM_FULL),
    mmOver: isNum(x.precip.value) && x.precip.value > MINI_MM_FULL,
    probPct: isNum(x.precipProb.value) ? Math.max(0, Math.min(100, x.precipProb.value)) : null,
    tempPct: !isNum(x.temp.value) ? null : tmax > tmin ? 15 + ((x.temp.value - tmin) / (tmax - tmin)) * 85 : 50,
    tempColor: isNum(x.temp.value) ? tempColor(x.temp.value) : "transparent",
    windPct: barPct(x.wind.value, wMax),
    gustPct: barPct(x.gust.value, wMax),
    hour: hourLabel(x.time),
    precip: isNum(x.precip.value) ? `${num1(x.precip.value)} mm` : "— mm",
    prob: isNum(x.precipProb.value) ? `${num0(x.precipProb.value)} %` : "— %",
    temp: deg(x.temp.value),
    wind: isNum(x.wind.value) ? `${num0(x.wind.value)} km/h` : "— km/h",
    gust: isNum(x.gust.value) ? `raf. ${num0(x.gust.value)}` : "raf. —",
    dir: isNum(x.windDir?.value) ? x.windDir.value : null,
    };
  });
}
// walk : les heures sont des boutons qui ouvrent « Balade ? » pour un départ à cette heure (position réelle seulement).
export function buildMini(data, n = MINI_HOURS, { walk = false } = {}) {
  const hours = next24h(data).slice(0, n);
  if (!hours.length) return h("p", { class: "muted", text: "Données horaires indisponibles." });
  const rows = miniRows(data, n);
  const table = h("table", { class: "mini-table" },
    h("caption", { class: "sr-only", text: `Prévisions des ${rows.length} prochaines heures à ${data.location.name}` }),
    h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Heure", h("button", { type: "button", class: "mini-info-btn", "aria-expanded": "false", "aria-controls": "mini-hour-help", "aria-label": "Que veut dire l'heure d'une ligne ?", title: "Que veut dire l'heure d'une ligne ?", text: "i" })), h("th", { scope: "col", class: "mini-ico-col" }, h("span", { class: "sr-only", text: "Temps" })), h("th", { scope: "col", text: "Pluie" }), h("th", { scope: "col", text: "Probabilité" }), h("th", { scope: "col", text: "Température" }), h("th", { scope: "col", text: "Vent" }))),
    h("tbody", {}, rows.map((r, i) => h("tr", { class: r.afterNoon ? "mini-noon" : null },
      h("th", { scope: "row" },
        walk
          // première ligne = heure en cours : départ maintenant (« Dans l'heure ») ; les suivantes : départ à l'heure de la ligne
          ? h("button", { type: "button", class: `mini-hour mini-walk${r.sun ? ` is-${r.sun}` : ""}`, "data-time": r.time, "data-now": i === 0 ? "1" : null, title: `Balade ? ${i === 0 ? "Départ maintenant" : `Départ à ${r.hour}`}${r.sun === "night" ? " (soleil couché)" : r.sun === "day" ? " (soleil levé)" : ""}`, "aria-label": `${r.hour} : balade ? ${i === 0 ? "départ maintenant" : "départ à cette heure"}${r.sun === "night" ? ", soleil couché" : r.sun === "day" ? ", soleil levé" : ""}`, text: r.hour })
          : h("span", { class: `mini-hour${r.sun ? ` is-${r.sun}` : ""}`, title: r.sun === "night" ? "Soleil couché" : r.sun === "day" ? "Soleil levé" : null, text: r.hour }),
        r.sun && !walk ? h("span", { class: "sr-only", text: r.sun === "night" ? " (soleil couché)" : " (soleil levé)" }) : null),
      h("td", { class: "mini-ico", title: r.sky }, h("span", { "aria-hidden": "true", text: r.icon }), h("span", { class: "sr-only", text: r.sky })),
      h("td", { class: "mini-mm" },
        h("div", { class: "vbar-box", "aria-hidden": "true" }, isNum(r.mmPct) ? h("div", { class: `vbar${r.mmOver ? " is-over" : ""}`, style: { height: `${minVisible(r.mmPct)}%` } }, r.mmOver ? h("span", { text: "+" }) : null) : null),
        h("strong", { text: r.precip })),
      h("td", {}, h("strong", { text: r.prob }), hbar(r.probPct, "var(--rain)")),
      h("td", {}, h("strong", { text: r.temp }), hbar(r.tempPct, r.tempColor)),
      h("td", {}, h("strong", { text: r.wind }), h("span", { class: "mini-sub" }, vane(r.dir, true), isNum(r.dir) ? h("span", { class: "sr-only", text: `vent ${windFrom(r.dir)}, ` }) : null, r.gust),
        h("div", { class: "hbar-box" },
          isNum(r.gustPct) ? h("div", { class: "hbar", style: { width: `${minVisible(r.gustPct)}%`, background: "var(--wind-2)" } }) : null,
          isNum(r.windPct) ? h("div", { class: "hbar over", style: { width: `${minVisible(r.windPct)}%`, background: "var(--wind)" } }) : null))))));
  const labelOf = (k) => { const ms = new Set(hours.map((x) => x[k].model).filter(Boolean)); return ms.size ? [...ms].map(modelShort).join(" puis ") : "indisponible"; };
  // Explications sous le tableau, en petite liste repliée (« Comment lire ces valeurs », comme sur la page principale).
  // Modèles regroupés : « Météo-France pour la pluie, la température, le vent et les rafales ; ECMWF pour la probabilité. »
  const groups = new Map();
  for (const [k, word] of [["precip", "la pluie"], ["precipProb", "la probabilité"], ["temp", "la température"], ["wind", "le vent"], ["gust", "les rafales"]]) {
    const label = labelOf(k);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(word);
  }
  const andList = (ws) => (ws.length > 1 ? `${ws.slice(0, -1).join(", ")} et ${ws.at(-1)}` : ws[0]);
  const notes = [
    `Modèles : ${[...groups].map(([label, ws]) => (label === "indisponible" ? `aucune valeur pour ${andList(ws)}` : `${label} pour ${andList(ws)}`)).join(" ; ")}.`,
    "Exemple : ligne « 18 h » = pluie, probabilité et rafales de 17 h à 18 h ; température et vent à 18 h.",
    `Pluie : la barre verticale monte avec les mm d'eau, pleine à ${MINI_MM_FULL} mm ; au-delà, rouge avec « + ».`,
    "Probabilité : la barre suit le pourcentage.",
    `Température : la barre va de la plus basse à la plus haute de ces ${rows.length} heures.`,
    "Vent : barre foncée = vent, barre claire = rafales.",
  ];
  // Explication de l'heure d'une ligne, ouverte par le « i » du titre de colonne.
  const help = h("div", { class: "compact-help mini-hour-help", id: "mini-hour-help", hidden: "" },
    h("ul", {},
      h("li", { text: "Exemple : ligne « 22 h » = pluie, probabilité et rafales de 21 h à 22 h ; température et vent à 22 h." }),
      walk ? h("li", { text: "Exemple : toucher « 22 h » ouvre « Balade ? » pour un départ à 22 h ; verdict de 22 h à 23 h, dont la pluie est sur la ligne « 23 h »." }) : null,
      walk ? h("li", { text: "Exemple : toucher la première ligne ouvre « Balade ? » pour un départ maintenant." }) : null,
      h("li", { text: "Pastille bleutée : soleil couché ; pastille jaune : soleil levé." })));
  const infoBtn = table.querySelector(".mini-info-btn");
  infoBtn.addEventListener("click", () => {
    const open = help.hidden; // hidden = fermé : un clic l'ouvre
    help.hidden = !open;
    infoBtn.setAttribute("aria-expanded", String(open));
    if (open) help.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  });
  return h("div", {}, help, h("div", { class: "mini-scroll" }, table), howTo("mini", notes));
}

// Bandeau 24 h piloté par l'onglet actif.
export function buildHourly(data, tab) {
  const hours = next24h(data);
  const wrap = h("div", {});
  if (!hours.length) return h("p", { class: "muted", text: "Données horaires indisponibles." });
  const get = { precip: (x) => x.precip.value, temp: (x) => x.temp.value, wind: (x) => Math.max(x.gust.value ?? -Infinity, x.wind.value ?? -Infinity) };
  const vals = hours.map(get[tab]).filter((v) => isNum(v) && v > -Infinity);
  const tmin = Math.min(...vals), tmax = Math.max(...vals);
  const wMax = scaleMax(hours.map((x) => x.gust.value ?? x.wind.value), 10);

  const strip = h("div", { class: "strip", role: "list", tabindex: "0", "aria-label": "Prévisions horaires, défilement horizontal" });
  for (const x of hours) {
    const info = weatherInfo(x.weatherCode.value, isNight(x.time, data.daily));
    let bars, l1, l2, extra = null;
    if (tab === "precip") {
      // Même convention que la vue 🥾 (23/11/2026) : barre verticale = mm d'eau (pleine à MINI_MM_FULL, rouge et « + » au-delà),
      // petite barre horizontale = probabilité. Probabilité et quantité restent deux informations distinctes.
      const mm = x.precip.value, over = isNum(mm) && mm > MINI_MM_FULL;
      bars = h("div", { class: "vbar-box is-track" }, isNum(mm)
        ? h("div", { class: `vbar${over ? " is-over" : ""}`, style: { height: `${minVisible(barPct(mm, MINI_MM_FULL))}%` } }, over ? h("span", { text: "+" }) : null)
        : null);
      l1 = isNum(mm) ? `${num1(mm)} mm` : "— mm";
      l2 = isNum(x.precipProb.value) ? `${num0(x.precipProb.value)} %` : "— %";
      extra = probBar(x.precipProb.value);
    } else if (tab === "temp") {
      const pct = isNum(x.temp.value) && tmax > tmin ? 15 + ((x.temp.value - tmin) / (tmax - tmin)) * 85 : isNum(x.temp.value) ? 50 : null;
      bars = vbar(pct, isNum(x.temp.value) ? tempColor(x.temp.value) : "transparent");
      l1 = deg(x.temp.value); l2 = `ress. ${deg(x.apparent.value)}`;
    } else {
      bars = h("div", { class: "vbars" }, vbar(barPct(x.gust.value, wMax), "var(--wind-2)"), vbar(barPct(x.wind.value, wMax), "var(--wind)"));
      l1 = isNum(x.wind.value) ? `${num0(x.wind.value)}` : "—"; l2 = isNum(x.gust.value) ? `raf. ${num0(x.gust.value)}` : "raf. —";
    }
    strip.append(h("div", { class: "hcell", role: "listitem" },
      h("div", { class: "hhour", text: hourLabel(x.time) }), h("div", { class: "hicon", "aria-hidden": "true", text: info.icon }),
      bars, h("div", { class: "hv1", text: l1 }), h("div", { class: "hv2", text: l2 }), extra));
  }
  wrap.append(strip);

  const fieldsByTab = {
    precip: [["mm", "precip"], ["%", "precipProb"]], temp: [["température", "temp"], ["ressenti", "apparent"]], wind: [["vent", "wind"], ["rafales", "gust"]],
  }[tab];
  const at = (i) => `à ${hourLabel(hours[i].time)}`;
  wrap.append(modelsP(modelsText(fieldsByTab.map(([l, k]) => [l, modelRun(hours.map((x) => x[k].model), at)]))));
  // Données manquantes : toujours signalées, même en vue compacte.
  const warn = [];
  if (hours.length < 24) warn.push(`Données horaires disponibles seulement jusqu'à ${hourLabel(hours[hours.length - 1].time)}.`);
  const missing = hours.filter((x) => x[{ precip: "precip", temp: "temp", wind: "wind" }[tab]].value === null).length;
  if (missing) warn.push(`${missing} plage(s) sans donnée (affichées « — »).`);
  if (warn.length) wrap.append(h("p", { class: "muted small h-warn", text: warn.join(" ") }));
  return wrap;
}
// Ce que veut dire l'heure d'une colonne (convention d'Open-Meteo).
export const HOUR_NOTE = {
  precip: "Pas de 1 h. « 18 h » : pluie et % de l'heure qui se termine à 18 h (de 17 h à 18 h).",
  temp: "Pas de 1 h. « 18 h » : température et ressenti à 18 h.",
  wind: "Pas de 1 h. « 18 h » : vent à 18 h ; rafales = maximum de 17 h à 18 h.",
};
// « i » des 24 heures (28/11/2026) : ce que disait la note sous le bandeau de la vue détaillée.
export function hourHelpItems(tab) {
  const bars = {
    precip: `Barre verticale = mm d'eau, pleine à ${MINI_MM_FULL} mm (rouge et « + » au-delà) ; petite barre horizontale = probabilité.`,
    temp: "Barre : place de la température entre la plus basse et la plus haute des 24 heures.",
    wind: "Barre foncée = vent ; claire = rafales (même échelle pour les 24 heures).",
  }[tab];
  return [HOUR_NOTE[tab], bars];
}
function vbar(pct, color) {
  return h("div", { class: "vbar-box" }, pct === null ? null : h("div", { class: "vbar", style: { height: `${minVisible(pct)}%`, background: color } }));
}

// Valeurs affichées pour chaque jour : celles du modèle retenu valeur par valeur (plus de scénarios depuis le 28/11/2026 :
// la page s'arrête à 7 jours, choix de l'utilisateur).
export function dayViews(days) {
  return days.map((d) => ({ d, tmin: d.tempMin.value, tmax: d.tempMax.value, mm: d.precipSum.value, pct: d.precipProbMax.value }));
}

// Vue compacte : deux blocs (aujourd'hui à J+3, puis J+4 à J+6), séparés par une phrase.
export const COMPACT_BLOCKS = [[0, 3], [4, 6]];
export function compactBlocks(views) {
  return COMPACT_BLOCKS.map(([a, b]) => views.filter((v) => v.d.dayIndex >= a && v.d.dayIndex <= b)).filter((g) => g.length);
}
// Texte de valeur d'une ligne compacte, sans commentaire (les définitions sont dans le petit « i »).
export function compactValue(v, tab) {
  const { d } = v;
  if (tab === "precip") {
    return `${isNum(v.mm) ? `${num1(v.mm)} mm` : "—"}${isNum(v.pct) ? ` · ${num0(v.pct)} %` : ""}`;
  }
  if (tab === "temp") return `${deg(v.tmin)} / ${deg(v.tmax)}`;
  return `${num0(d.windMax.value)} km/h raf. ${num0(d.gustMax.value)}`; // lexique du 28/11/2026 : comme l'écran d'accueil
}
export const COMPACT_SEP_TEXT = `Dès J+${COMPACT_BLOCKS[1][0]} : fiabilité en baisse.`;
export const DAY_MM_FULL = 10; // jauge de mm du jour : voir dayMmGauge
export const COMPACT_HELP_ITEMS = [
  "7 jours : J à J+3, puis J+4 à J+6. Au-delà, une prévision jour par jour n'est plus fiable.",
  `Pluie : mm et %. Les mm sont peu fiables dès J+${RAIN_MM_UNTIL + 1}, non fiables à 7 jours.`,
  `Barres de pluie : petite verticale = mm du jour (pleine à ${DAY_MM_FULL} mm) ; horizontale = %.`,
  "Le % est la probabilité horaire maximale du jour, pas celle de toute la journée.",
  "mm et % peuvent venir de deux modèles (Météo-France ne publie pas de %) et se contredire : 0 mm avec 60 %.",
  "Températures : minimale / maximale ; barres sur une échelle commune aux 7 jours.",
  "Vent : maxima du jour, jamais des moyennes ; barre foncée = vent max, claire = rafales max.",
  "Girouette : direction dominante du jour ; la pointe va où va le vent.",
  "⚠ sur une ligne : rafales max inférieures au vent max, écart de la source, non corrigé.",
];

// Infobulle d'un bloc repliable : dit ce que fera le clic, selon l'état (« Déplier les explications », « Replier les explications »).
export function foldTip(details, what) {
  const summary = details.querySelector("summary");
  const tip = () => { summary.title = `${details.open ? "Replier" : "Déplier"} ${what}`; };
  tip();
  details.addEventListener("toggle", tip);
  return details;
}
// Explications repliées par défaut ; l'état choisi est conservé quand la section est reconstruite (changement d'onglet).
const howToOpen = {};
function howTo(key, items) {
  const d = h("details", { class: "howto" }, h("summary", { text: "Comment lire ces valeurs" }),
    h("ul", { class: "howto-list muted small" }, items.map((t) => h("li", { text: t }))));
  d.open = Boolean(howToOpen[key]);
  d.addEventListener("toggle", () => { howToOpen[key] = d.open; });
  return foldTip(d, "les explications");
}

// Vue compacte : les 7 jours en deux blocs, séparateur expliqué, puis le même résumé que la vue détaillée.
export function buildCompact(data, tab) {
  const views = dayViews(firstWeek(data));
  const tMins = views.map((v) => v.tmin).filter(isNum), tMaxs = views.map((v) => v.tmax).filter(isNum);
  const gmin = Math.min(...tMins, ...tMaxs), gmax = Math.max(...tMins, ...tMaxs);
  const wMax = scaleMax(views.map((v) => v.d.gustMax.value ?? v.d.windMax.value), 20);
  const list = h("ol", { class: "compact-list" });
  compactBlocks(views).forEach((block, i) => {
    if (i > 0) list.append(h("li", { class: "compact-sep", text: COMPACT_SEP_TEXT }));
    for (const v of block) {
      const { d } = v;
      const info = weatherInfo(d.weatherCode.value, false);
      let bar;
      if (tab === "precip") bar = rainBars(v.mm, v.pct);
      else if (tab === "temp") bar = rangeBar(v.tmin, v.tmax, gmin, gmax);
      else bar = h("div", { class: "hbar-box" },
        isNum(d.gustMax.value) ? h("div", { class: "hbar", style: { width: `${minVisible(barPct(d.gustMax.value, wMax))}%`, background: "var(--wind-2)" } }) : null,
        isNum(d.windMax.value) ? h("div", { class: "hbar over", style: { width: `${minVisible(barPct(d.windMax.value, wMax))}%`, background: "var(--wind)" } }) : null);
      list.append(h("li", { class: "compact-day" },
        h("span", { class: "c-name" }, dayName(d, tab)),
        h("span", { class: "c-icon", "aria-hidden": "true", title: info.label, text: info.icon }),
        bar, tab === "wind"
          // girouette de la direction dominante (sa direction en mots, pour le lecteur d'écran ; trop longue pour la ligne)
          ? h("span", { class: "c-val c-wind" }, vane(d.windDirDominant.value, true), windFrom(d.windDirDominant.value) ? h("span", { class: "sr-only", text: `vent ${windFrom(d.windDirDominant.value)}, ` }) : null, compactValue(v, tab),
            gustBelowWind(d) ? h("span", { class: "gust-warn", title: "Rafales max inférieures au vent max : écart de la source, non corrigé", text: "\u00a0⚠" }) : null)
          : h("span", { class: "c-val", text: compactValue(v, tab) })));
    }
  });
  const days = firstWeek(data);
  const at = (i) => `au ${dayLabel(days[i].date)}`;
  const fields = { precip: [["mm", "precipSum"], ["%", "precipProbMax"]], temp: [["min", "tempMin"], ["max", "tempMax"]], wind: [["vent", "windMax"], ["rafales", "gustMax"]] }[tab];
  const models = modelsP(modelsText(fields.map(([l, k]) => [l, modelRun(days.map((d) => d[k].model), at)])));
  // Règle du cahier : l'écart est signalé sur la ligne (⚠) et expliqué ici, jamais corrigé.
  const odd = tab === "wind" ? days.filter(gustBelowWind) : [];
  const warn = odd.length ? h("p", { class: "muted small gust-note", text: `⚠ ${odd.map((d) => dayLabel(d.date)).join(", ")} : rafales max inférieures au vent max (écart de la source, non corrigé).` }) : null;
  const text = weekSummary(days);
  return h("div", {}, list, models, warn, text ? h("p", { class: "summary", text }) : null);
}

// Cas observé à Montréal (GEM) : rafales max inférieures au vent max. Signalé, jamais retouché.
export const gustBelowWind = (d) => isNum(d.windMax.value) && isNum(d.gustMax.value) && d.gustMax.value < d.windMax.value;

function hbar(pct, color) {
  return h("div", { class: "hbar-box" }, pct === null ? null : h("div", { class: "hbar", style: { width: `${minVisible(pct)}%`, background: color } }));
}
// Jauge de mm du jour (lignes de jours, onglet Précipitations, 23/11/2026) : verticale comme partout pour les mm, pleine à
// DAY_MM_FULL (limite « modéré » / « fort » de rainClass), rouge et « + » au-delà. Donnée absente : fond gris vide.
// (DAY_MM_FULL est déclarée plus haut, avant l'aide des 7 jours qui la cite.)
function dayMmGauge(mm) {
  const over = isNum(mm) && mm > DAY_MM_FULL;
  return h("div", { class: "dmm", "aria-hidden": "true" }, isNum(mm)
    ? h("div", { class: `vbar${over ? " is-over" : ""}`, style: { height: `${minVisible(barPct(mm, DAY_MM_FULL))}%` } }, over ? h("span", { text: "+" }) : null)
    : null);
}
const rainBars = (mm, pct) => h("div", { class: "dbars" }, dayMmGauge(mm), probBar(pct));

// Barre de probabilité : la longueur suit toujours le % (0 à 100), jamais une quantité.
function probBar(pct) {
  return h("div", { class: "hbar-box prob" }, isNum(pct) ? h("div", { class: "hbar", style: { width: `${minVisible(Math.max(0, Math.min(100, pct)))}%`, background: "var(--rain)" } }) : null);
}
function rangeBar(lo, hi, gmin, gmax) {
  const span = gmax - gmin || 1;
  if (!isNum(lo) || !isNum(hi)) return h("div", { class: "hbar-box" });
  return h("div", { class: "hbar-box" }, h("div", { class: "hbar range", style: {
    left: `${((lo - gmin) / span) * 100}%`, width: `${Math.max(3, ((hi - lo) / span) * 100)}%`,
    background: `linear-gradient(90deg, ${tempColor(lo)}, ${tempColor(hi)})` } }));
}

// Bloc de transparence (cahier 13).
export function buildSources(data, warnings = null) {
  const tz = data.location.timezone, m = data.metadata;
  const models = displayedModels(data);
  const week = data.daily; // J à J+6
  const items = [];
  items.push(h("li", { text: `Consulté le ${formatLocal(new Date(m.fetchedAt), tz, { dateStyle: "full", timeStyle: "short" })} (heure de ${data.location.name}, ${tz}).` }));
  items.push(h("li", { text: "Mise à jour de la source : non publiée par l'API (aucune heure inventée)." }));
  for (const mod of models) {
    const dates = week.filter((d) => d.tempMax.model === mod).map((d) => d.date);
    const range = dates.length ? `températures du ${dates[0].slice(8)}/${dates[0].slice(5, 7)} au ${dates[dates.length - 1].slice(8)}/${dates[dates.length - 1].slice(5, 7)}` : "certaines valeurs seulement";
    items.push(h("li", { text: `${modelLabel(mod)} : ${range}.` }));
  }
  const gaps = [["probabilité de pluie", "precipProbMax"], ["rafales max", "gustMax"], ["vent max", "windMax"], ["pluie (mm)", "precipSum"]]
    .map(([l, k]) => [l, week.filter((d) => d[k].value === null).length]).filter(([, n]) => n > 0);
  items.push(h("li", { text: gaps.length ? `Données manquantes sur les 7 jours : ${gaps.map(([l, n]) => `${l} (${n} j)`).join(", ")}.` : "Aucune donnée manquante sur les 7 jours." }));
  items.push(h("li", { text: "Le modèle est choisi pour chaque valeur : le premier de la liste de priorité qui fournit une donnée, sans moyenne de modèles." }));
  items.push(h("li", { text: "La résolution du modèle (1,5 à 25 km selon les cas) ne rend pas compte des microclimats locaux, notamment sur le littoral." }));

  return h("div", { class: "sources" }, h("ul", {}, items));
}

// Attributions obligatoires : toujours visibles, même quand « Sources et limites » est replié.
export function buildAttribution(data, warnings = null) {
  const models = displayedModels(data);
  const attribution = h("p", { class: "attrib muted small" }, h("a", { href: "https://open-meteo.com/", rel: "noopener", text: "Weather data by Open-Meteo.com" }), " · ",
    h("a", { href: "https://open-meteo.com/en/terms", rel: "noopener", text: "conditions d'utilisation" }));
  if (models.includes("meteofrance_seamless")) attribution.append(" · Source : Météo-France");
  if (warnings?.status === "confirmed") {
    attribution.append(` · ${ECCC_ATTRIBUTION} `, h("a", { href: ECCC_LICENCE_URL, rel: "noopener", text: "(licence)" }));
  }
  return attribution;
}

// Ligne d'état visible même quand « Vigilances » est replié : une alerte en vigueur ne doit jamais se cacher.
export function warningsStatus(data, warnings) {
  if (!warnings) return { text: "Vérification de la vigilance officielle en cours…", alert: false };
  if (warnings.status !== "confirmed") return { text: "Vigilance officielle : non confirmée", alert: false };
  const n = warnings.alerts.length;
  if (n) return { text: `⚠ ${n} alerte${n > 1 ? "s" : ""} en vigueur publiée${n > 1 ? "s" : ""} par ECCC : déplier pour le détail`, alert: true };
  const when = formatLocal(new Date(warnings.checkedAt), data.location.timezone, { hour: "2-digit", minute: "2-digit" });
  return { text: `Aucune alerte publiée par ECCC à ${when} (heure locale)`, alert: false };
}

// G. Vigilances : officielle seulement si vérifiée ; sinon « non confirmée » + lien. `warnings` null = vérification en cours.
export function buildWarnings(data, warnings) {
  const tz = data.location.timezone;
  const card = h("div", { class: "warnings" });
  if (!warnings) {
    card.append(h("p", { class: "muted", text: "Vérification de la vigilance officielle en cours…" }));
    return card;
  }
  const link = (href, text) => h("a", { href, rel: "noopener", text, class: "official" });

  if (warnings.status !== "confirmed") {
    card.append(h("p", { class: "w-status", text: "Vigilance officielle : non confirmée" }),
      h("p", { class: "muted small", text: warnings.reason }),
      h("p", {}, link(warnings.link, `${warnings.linkName} ↗`), warnings.extra ? [" · ", link(warnings.extra.url, `${warnings.extra.name} ↗`)] : null),
      h("p", { class: "muted small", text: "Le beau temps prévu ne permet pas de conclure à l'absence de vigilance." }));
    return card;
  }
  const when = formatLocal(new Date(warnings.checkedAt), tz, { hour: "2-digit", minute: "2-digit" });
  if (!warnings.alerts.length) {
    card.append(h("p", { class: "w-status", text: `Aucune alerte publiée par ECCC pour ce lieu à ${when} (heure locale).` }),
      h("p", { class: "muted small", text: "Ceci ne remplace pas la consultation du site officiel." }));
  } else {
    card.append(h("p", { class: "w-status", text: `${warnings.alerts.length} alerte(s) en vigueur publiée(s) par ECCC (vérifié à ${when}, heure locale)` }));
    const list = h("ul", { class: "alerts" });
    for (const a of warnings.alerts) {
      const until = a.expiresAt ? formatLocal(new Date(a.expiresAt), tz, { dateStyle: "short", timeStyle: "short" }) : null;
      list.append(h("li", { class: `alert alert-${(a.colour ?? "").toLowerCase()}` },
        h("div", { class: "alert-head" }, h("strong", { text: a.name ?? "alerte" }), h("span", { class: "alert-colour", text: a.colour ? `niveau ${a.colour}` : "niveau non précisé" }),
          a.status ? h("span", { class: "tag", text: a.status }) : null),
        a.area ? h("div", { class: "muted small", text: a.area }) : null,
        until ? h("div", { class: "muted small", text: `Valable jusqu'au ${until} (heure locale)` }) : null,
        a.text ? foldTip(h("details", {}, h("summary", { text: "Texte officiel" }), h("p", { class: "alert-text", text: a.text })), "le texte officiel de l'alerte") : null));
    }
    card.append(list, h("p", { class: "muted small", text: "Alertes reproduites sans modification, telles que publiées par Environnement et Changement climatique Canada." }));
  }
  card.append(h("p", {}, link(warnings.link, `${warnings.linkName} ↗`)));
  return card;
}
