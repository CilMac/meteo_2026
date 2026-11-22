// Rendu des sections (cahier 4 à 8, 13). Les helpers purs sont testables sous Node ; `document` n'est utilisé que dans les builders.
import { ECCC_ATTRIBUTION, ECCC_LICENCE_URL } from "./warnings.js";
import { ENSEMBLE_FIRST_DAY, ENSEMBLE_MEDIAN_FROM, WET_MM } from "./ensemble.js";
import { modelShort, modelLabel, next24h, firstWeek, secondWeek } from "./weather-provider.js";

export const TABS = [
  { id: "precip", label: "Précipitations" },
  { id: "temp", label: "Température" },
  { id: "wind", label: "Vent" },
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
function outlookSpan(firstTime, lastTime, today) {
  const a = outlookHour(firstTime, today, true), b = outlookHour(lastTime, today);
  return `entre ${a} et ${a.startsWith("demain ") && b.startsWith("demain ") ? b.slice("demain ".length) : b}`;
}

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
  const best = probs.reduce((m, h) => (!m || h.precipProb.value > m.precipProb.value ? h : m), null);
  if (best && best.precipProb.value >= 30) return `Pas de pluie prévue en quantité, mais risque le plus marqué ${outlookSpan(best.time, best.time, today)} (${num0(best.precipProb.value)} %).`;
  if (withPrecip.length < hours.length * 0.9) return "Données de pluie incomplètes sur cette période.";
  return "Pas de pluie attendue dans les 24 prochaines heures.";
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
export const compass = (d) => (isNum(d) ? COMPASS[Math.round((((d % 360) + 360) % 360) / 45) % 8] : null);

// Provenance d'un groupe de valeurs : un seul libellé si tous les champs viennent du même modèle, sinon détail par champ.
export function modelsLine(item, fields) {
  const parts = fields.map(([label, key]) => [label, item[key]?.model]).filter(([, m]) => m);
  if (!parts.length) return "";
  const set = new Set(parts.map((p) => p[1]));
  if (set.size === 1) return modelShort([...set][0]);
  return parts.map(([l, m]) => `${l} : ${modelShort(m)}`).join(" · ");
}

export const barPct = (v, max) => (isNum(v) && max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : null);
// Une valeur non nulle reste visible (4 % minimum) ; un vrai zéro donne une barre vide.
export const minVisible = (pct) => (pct > 0 ? Math.max(pct, 4) : 0);
export const scaleMax = (values, floor) => Math.max(floor, ...values.filter(isNum));
// Gamme froid → chaud (teinte bleue à orangée), bornée à [-5, 35] °C.
export function tempColor(t) {
  const x = Math.max(-5, Math.min(35, t));
  return `hsl(${Math.round(225 - ((x + 5) / 40) * 195)}, 48%, 58%)`; // teintes adoucies (charte pastel)
}

export function weekSummary(days) {
  const solid = days.filter((d) => !d.trend);
  const maxes = days.map((d) => d.tempMax.value).filter(isNum);
  const parts = [];
  if (maxes.length) parts.push(`Maximales de ${num0(Math.min(...maxes))} à ${num0(Math.max(...maxes))} °C sur la période.`);
  const wet = solid.filter((d) => d.dayIndex <= RAIN_MM_UNTIL && d.precipSum.value >= 2);
  if (wet.length) parts.push(`Pluie la plus notable : ${wet.map((d) => dayLabel(d.date)).join(", ")}.`);
  else if (solid.some((d) => isNum(d.precipSum.value))) parts.push("Pas de pluie notable sur les jours les plus fiables.");
  if (days.some((d) => d.trend)) parts.push("Les derniers jours sont une tendance : à confirmer.");
  return parts.join(" ");
}

export function dayLabel(dateISO) {
  return new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "numeric", timeZone: "UTC" })
    .format(new Date(`${dateISO}T12:00:00Z`)).replace(".", "");
}
export const formatLocal = (instant, tz, opts) => new Intl.DateTimeFormat("fr-FR", { timeZone: tz, ...opts }).format(instant);

// Modèles des seules valeurs affichées (le lever/coucher du soleil, non affiché, ne compte pas).
const DAILY_SHOWN = ["weatherCode", "tempMax", "tempMin", "precipSum", "precipProbMax", "windMax", "gustMax", "windDirDominant"];
const HOURLY_SHOWN = ["temp", "apparent", "precip", "precipProb", "wind", "gust", "weatherCode"];
export function modelsOf(items, keys) {
  const set = new Set();
  for (const it of items) for (const k of keys) if (it[k]?.model) set.add(it[k].model);
  return [...set];
}

// Modèles réellement affichés : 24 h + jours J à J+14.
export function displayedModels(data) {
  return [...new Set([...modelsOf(data.daily, DAILY_SHOWN), ...modelsOf(next24h(data), HOURLY_SHOWN)])];
}

// Quantité de pluie du jour affichée jusqu'à ce jour inclus (mesure sur pluviomètres : au-delà, la quantité ne bat plus « toujours sec »).
export const RAIN_MM_UNTIL = 3;
export const RAIN_LEGEND = "sec < 0,2 mm · faible 0,2 à 2 mm · modéré 2 à 10 mm · fort > 10 mm";

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

export function buildCurrent(data, now = new Date()) {
  const c = data.current, d0 = data.daily[0], tz = data.location.timezone;
  const night = c.time ? isNight(c.time, data.daily) : false;
  const info = weatherInfo(c.weatherCode, night);
  const outlook = rainOutlook(next24h(data), c.time ? c.time.slice(0, 10) : null);
  return h("div", { class: "card current" },
    h("div", { class: "cur-main" },
      h("span", { class: "cur-icon", "aria-hidden": "true", text: info.icon }),
      h("span", { class: "cur-temp", text: deg(c.temp) }),
      h("div", {}, h("div", { class: "cur-desc", text: info.label }),
        h("div", { class: "muted", text: `Ressenti ${deg(c.apparent)}` }))),
    h("p", { class: "muted small cur-note", text: c.time ? `Valeurs calculées pour ${hourLabel(c.time)} (modèle). Heure locale : ${formatLocal(now, tz, { hour: "2-digit", minute: "2-digit" })}.` : "Heure de la situation indisponible." }),
    // Version courte (vue compacte) : l'origine « modèle » reste signalée.
    h("p", { class: "muted small cur-note-short", text: c.time ? `Valeurs calculées pour ${hourLabel(c.time)} (modèle).` : "Heure de la situation indisponible." }),
    h("div", { class: "cur-grid" },
      stat("precip", "Risque de pluie (max horaire du jour)", "Risque de pluie", isNum(d0.precipProbMax.value) ? `${num0(d0.precipProbMax.value)} %` : "—", modelsLine(d0, [["", "precipProbMax"]])),
      stat("temp", "Min / max du jour", "Min / max", `${deg(d0.tempMin.value)} / ${deg(d0.tempMax.value)}`, modelsLine(d0, [["min", "tempMin"], ["max", "tempMax"]])),
      stat("wind", "Vent actuel · rafales", "Vent · raf.", `${num0(c.wind)} · ${num0(c.gust)} km/h`, "")),
    outlook ? h("p", { class: "outlook", text: outlook }) : null);
}
function stat(family, label, shortLabel, value, model) {
  return h("div", { class: `stat fam-${family}` },
    h("div", { class: "muted small stat-label" }, h("span", { class: "l-long", text: label }), h("span", { class: "l-short", text: shortLabel })), h("div", { class: "stat-val", text: value }), model ? h("div", { class: "tag", text: model }) : null);
}

// Ligne fixe du haut : lieu (à gauche) et situation calculée (à droite) ; le bouton de vue est entre les deux.
export function buildTopPlace(data) {
  return h("span", { class: "top-place", title: `${data.location.name} (${data.location.country})` },
    h("span", { class: "pin", "aria-hidden": "true", text: "📍" }),
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
      h("td", {}, h("strong", { text: r.wind }), h("span", { class: "mini-sub", text: r.gust }),
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
      h("li", { text: "Pastille foncée : soleil couché ; pastille claire : soleil levé." })));
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
    let bars, l1, l2;
    if (tab === "precip") {
      bars = vbar(isNum(x.precipProb.value) ? Math.max(0, Math.min(100, x.precipProb.value)) : null, "var(--rain)");
      l1 = isNum(x.precipProb.value) ? `${num0(x.precipProb.value)} %` : "— %";
      l2 = isNum(x.precip.value) ? `${num1(x.precip.value)} mm` : "— mm";
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
      bars, h("div", { class: "hv1", text: l1 }), h("div", { class: "hv2", text: l2 })));
  }
  wrap.append(strip);

  const fieldsByTab = {
    precip: [["mm", "precip"], ["%", "precipProb"]], temp: [["T", "temp"], ["ressenti", "apparent"]], wind: [["vent", "wind"], ["rafales", "gust"]],
  }[tab];
  const labelOf = (k) => { const ms = new Set(hours.map((x) => x[k].model).filter(Boolean)); return ms.size ? [...ms].map(modelShort).join(" puis ") : null; };
  const modelNotes = fieldsByTab.map(([l, k]) => `${l} : ${labelOf(k) ?? "indisponible"}`).join(" · ");
  const notes = [`Pas de 1 h · ${modelNotes}.`, HOUR_NOTE[tab]];
  if (tab === "precip") notes.push("Barres proportionnelles au pourcentage (risque de pluie), pas à la quantité.");
  wrap.append(h("p", { class: "muted small h-note", text: notes.join(" ") }));
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
  precip: "« 18 h » : pluie et % de l'heure qui se termine à 18 h (17 h → 18 h).",
  temp: "« 18 h » : température à 18 h.",
  wind: "« 18 h » : vent à 18 h ; rafales = maximum de 17 h à 18 h.",
};
function vbar(pct, color) {
  return h("div", { class: "vbar-box" }, pct === null ? null : h("div", { class: "vbar", style: { height: `${minVisible(pct)}%`, background: color } }));
}

// Valeurs effectivement affichées pour chaque jour : la médiane des scénarios à partir de J+8, sinon la valeur d'un seul scénario.
export function dayViews(days, ensemble) {
  const ensDays = ensemble?.status === "ok" ? ensemble.days : {};
  return days.map((d) => {
    const ens = ensDays[d.date] ?? null;
    const median = Boolean(ens) && d.dayIndex >= ENSEMBLE_MEDIAN_FROM;
    const range = Boolean(ens) && d.dayIndex >= ENSEMBLE_FIRST_DAY && !median;
    const showMm = d.dayIndex <= RAIN_MM_UNTIL;
    return {
      d, ens, median, range, showMm,
      cls: !showMm && !median ? d.precipClass ?? null : null,
      tmin: median ? ens.tmin?.median ?? null : d.tempMin.value,
      tmax: median ? ens.tmax?.median ?? null : d.tempMax.value,
      mm: !showMm ? null : median ? ens.precip?.mean ?? null : d.precipSum.value,
      pct: median ? (isNum(ens.precip?.probWet) ? ens.precip.probWet * 100 : null) : d.precipProbMax.value,
    };
  });
}

// Vue compacte : trois blocs (4 premiers jours, 3 suivants, le reste jusqu'à J+14), séparés par un simple trait.
export const COMPACT_BLOCKS = [[0, 3], [4, 6], [7, 14]];
export function compactBlocks(views) {
  return COMPACT_BLOCKS.map(([a, b]) => views.filter((v) => v.d.dayIndex >= a && v.d.dayIndex <= b)).filter((g) => g.length);
}
// Texte de valeur d'une ligne compacte, sans commentaire (les définitions sont dans le petit « i »).
export function compactValue(v, tab) {
  const { d } = v;
  if (tab === "precip") {
    if (!v.showMm) return [v.cls, isNum(v.pct) ? `${num0(v.pct)} %` : null].filter(Boolean).join(" · ") || "—";
    return `${isNum(v.mm) ? `${num1(v.mm)} mm` : "—"}${isNum(v.pct) ? ` · ${num0(v.pct)} %` : ""}`;
  }
  if (tab === "temp") return `${deg(v.tmin)} / ${deg(v.tmax)}`;
  return `vent ${num0(d.windMax.value)} · raf. ${num0(d.gustMax.value)} km/h`;
}
// Texte des deux séparateurs de la vue compacte (avant J+4, avant J+7).
export function compactSepTexts(ensemble) {
  const sample = ensemble?.status === "ok" ? Object.values(ensemble.days).find((d) => d.nMembers) : null;
  const second = sample
    ? "Dès J+7 : tendance · J+8 : médiane"
    : "Dès J+7 : tendance · J+8 : 1 scénario";
  return ["Dès J+4 : fiabilité en baisse.", second];
}
export const COMPACT_HELP_ITEMS = [
  "3 blocs : J à J+3, J+4 à J+6, J+7 à J+14.",
  `Pluie : mm et % jusqu'à J+${RAIN_MM_UNTIL} ; ensuite classe (sec, faible, modéré, fort) et %, sans mm.`,
  "Jusqu'à J+7, le % est la probabilité horaire maximale du jour.",
  `Dès J+${ENSEMBLE_MEDIAN_FROM}, le % est la part des scénarios à ${WET_MM} mm ou plus.`,
  `Températures : minimale / maximale (médiane des scénarios dès J+${ENSEMBLE_MEDIAN_FROM}).`,
  "Vent : maxima du jour.",
  "Détails et modèles : vue détaillée.",
];

// Lignes de jours (7 jours ou 8-15 jours) : même construction, échelles propres à la section.
// `ensemble` : undefined = scénarios en cours de chargement ; { status: "unavailable" } ; { status: "ok", days, models }.
//  - J+4 à J+7 : la valeur d'un seul scénario (ECMWF) reste, avec la fourchette des scénarios à côté ;
//  - à partir de J+8 : la médiane des scénarios remplace la valeur d'un seul scénario (températures et pluie).
function buildPeriod(days, tab, { sectionLabel, summary, ensemble }) {
  const wrap = h("div", {});
  const views = dayViews(days, ensemble);
  const tMins = views.map((v) => v.tmin).filter(isNum), tMaxs = views.map((v) => v.tmax).filter(isNum);
  const gmin = Math.min(...tMins, ...tMaxs), gmax = Math.max(...tMins, ...tMaxs);
  const wMax = scaleMax(days.map((d) => d.gustMax.value ?? d.windMax.value), 20);

  const list = h("ol", { class: "week" });
  let sep = false;
  for (const v of views) {
    const { d, ens } = v;
    if (d.trend && !sep && d.dayIndex < 7) { list.append(h("li", { class: "trend-sep", text: "Tendance — fiabilité moindre" })); sep = true; }
    const info = weatherInfo(d.weatherCode.value, false);
    let bar, value, tag = [], keepConfidence = true;
    if (tab === "precip") {
      if (v.median) {
        const p = ens.precip?.probWet;
        bar = probBar(isNum(p) ? p * 100 : null);
        value = isNum(p) ? `${num0(p * 100)} % des scénarios ≥ ${WET_MM} mm` : "—";
        tag.push(ensembleTag(ens));
        keepConfidence = false;
      } else if (!v.showMm) {
        // Au-delà de RAIN_MM_UNTIL : classe et pourcentage, pas de quantité.
        bar = probBar(d.precipProbMax.value);
        value = compactValue(v, "precip");
        tag.push(modelsLine(d, [["%", "precipProbMax"]]));
        if (v.range && isNum(ens.precip?.probWet)) tag.push(`scénarios : ${num0(ens.precip.probWet * 100)} % ≥ ${WET_MM} mm`);
      } else {
        bar = probBar(d.precipProbMax.value);
        const prob = isNum(d.precipProbMax.value) ? `${num0(d.precipProbMax.value)} %` : null;
        // Tendance courte (≤ J+3) : la quantité reste affichée ; la classe qualitative l'accompagne.
        const mm = isNum(d.precipSum.value) ? `${num1(d.precipSum.value)} mm` : "—";
        value = [d.trend && d.precipClass ? `${mm} (${d.precipClass})` : mm, prob].filter(Boolean).join(" · ");
        tag.push(modelsLine(d, [["mm", "precipSum"], ["%", "precipProbMax"]]));
        if (v.range && isNum(ens.precip?.probWet)) tag.push(`scénarios : ${num0(ens.precip.probWet * 100)} % ≥ ${WET_MM} mm`);
      }
    } else if (tab === "temp") {
      bar = rangeBar(v.tmin, v.tmax, gmin, gmax);
      value = `${deg(v.tmin)} / ${deg(v.tmax)}`;
      if (v.median) {
        tag.push(ensembleTag(ens), tmaxRange(ens));
        keepConfidence = false;
      } else {
        tag.push(modelsLine(d, [["min", "tempMin"], ["max", "tempMax"]]));
        if (v.range) tag.push(`scénarios : ${tmaxRange(ens)}`);
      }
    } else {
      bar = h("div", { class: "hbar-box" },
        isNum(d.gustMax.value) ? h("div", { class: "hbar", style: { width: `${minVisible(barPct(d.gustMax.value, wMax))}%`, background: "var(--wind-2)" } }) : null,
        isNum(d.windMax.value) ? h("div", { class: "hbar over", style: { width: `${minVisible(barPct(d.windMax.value, wMax))}%`, background: "var(--wind)" } }) : null);
      const dir = compass(d.windDirDominant.value);
      value = `vent max ${num0(d.windMax.value)} · rafales max ${num0(d.gustMax.value)} km/h${dir ? ` · secteur ${dir}` : ""}`;
      tag.push(modelsLine(d, [["vent", "windMax"], ["rafales", "gustMax"]]));
      if (gustBelowWind(d)) tag.push("⚠ rafales max < vent max : écart de la source, non corrigé");
      if (d.dayIndex >= ENSEMBLE_MEDIAN_FROM) tag.push("valeur d'un seul scénario (pas de dispersion pour le vent)");
    }
    // Scénarios attendus mais absents : dit clairement pourquoi la valeur reste celle d'un seul scénario.
    if (tab !== "wind" && d.dayIndex >= ENSEMBLE_MEDIAN_FROM && !v.median) {
      tag.push(ensemble === undefined ? "scénarios en cours de chargement…" : "dispersion indisponible : valeur d'un seul scénario");
    }
    if (keepConfidence) tag.push(confidenceText(d));
    list.append(h("li", { class: `day${d.trend ? " is-trend" : ""}` },
      h("div", { class: "dname", text: d.dayIndex === 0 ? "Auj." : dayLabel(d.date) }),
      h("div", { class: "dicon", "aria-hidden": "true", title: info.label, text: info.icon }),
      bar, h("div", { class: "dval", text: value }), h("div", { class: "tag dmodel", text: tag.filter(Boolean).join(" · ") })));
  }
  wrap.append(list);
  wrap.append(howTo(sectionLabel, howToItems(tab, {
    sectionLabel,
    hasMedian: views.some((v) => v.median),
    hasEns: views.some((v) => v.ens),
    hasSingleTrend: views.some((v) => v.d.trend && !v.median),
    hasLateDays: days.some((d) => d.dayIndex >= ENSEMBLE_MEDIAN_FROM),
    hasMm: views.some((v) => v.showMm),
    hasNoMm: views.some((v) => !v.showMm),
    mixedRain: views.some((v) => v.showMm && mixedRainModels(v.d)),
  })));
  const text = summary(days, ensemble);
  if (text) wrap.append(h("p", { class: "summary", text }));
  return wrap;
}

// mm et % du même jour venus de deux modèles différents (en France : mm de Météo-France, % d'ECMWF).
export const mixedRainModels = (d) => Boolean(d.precipSum.model && d.precipProbMax.model && d.precipSum.model !== d.precipProbMax.model);

// « Comment lire ces valeurs » : une idée par ligne, adaptée à l'onglet et à ce qui est réellement affiché.
export function howToItems(tab, { sectionLabel = "cette liste", hasMedian = false, hasEns = false, hasSingleTrend = false, hasLateDays = false, hasMm = true, hasNoMm = false, mixedRain = false } = {}) {
  const items = [];
  if (tab === "precip") {
    items.push("Barres : le pourcentage de risque de pluie, sur tous les jours (0 % à 100 %).");
    if (hasMm && hasNoMm) items.push(`Les mm sont écrits jusqu'à J+${RAIN_MM_UNTIL} ; dès J+${RAIN_MM_UNTIL + 1}, classe et % (mm non fiables). ${RAIN_LEGEND}.`);
    else if (hasNoMm) items.push(`Pas de mm à cette échéance (non fiables) : classe et %. ${RAIN_LEGEND}.`);
    else if (hasMm) items.push("Les mm sont écrits en texte, sans barre.");
    if (hasMedian) {
      items.push(`Le % : probabilité horaire maximale du jour jusqu'à J+7 ; dès J+${ENSEMBLE_MEDIAN_FROM}, part des scénarios à ${WET_MM} mm ou plus.`);
    } else items.push("Le % est la probabilité horaire maximale du jour, pas celle de toute la journée.");
    if (mixedRain) items.push("mm et % de deux modèles (Météo-France ne publie pas de %) : ils peuvent se contredire, par exemple 0 mm avec 60 %.");
    if (hasSingleTrend && hasMm) items.push("Jours en tendance : mm moins fiables.");
    if (hasEns) items.push("Scénarios : plusieurs modèles à poids égal, bruts, non calibrés.");
  } else if (tab === "temp") {
    items.push(`Barres : de la minimale à la maximale du jour (échelle propre à ${sectionLabel}).`);
    if (hasEns) {
      items.push("« T max 11–18 °C » : 80 % des scénarios tombent dans cet intervalle.");
      items.push(`Dès J+${ENSEMBLE_MEDIAN_FROM} : médiane de plusieurs modèles, brute, non calibrée.`);
      items.push("Dispersion : faible sous 4 °C d'écart sur la maximale, forte au-delà de 8 °C.");
    }
  } else {
    items.push("Valeurs : maxima du jour, jamais des moyennes.");
    items.push(`Barre foncée : vent max ; claire : rafales max (échelle propre à ${sectionLabel}).`);
    items.push("Secteur : d'où vient le vent (direction dominante du jour).");
    if (hasLateDays) items.push(`Dès J+${ENSEMBLE_MEDIAN_FROM} : valeur d'un seul scénario, sans dispersion.`);
  }
  return items;
}

// Explications repliées par défaut ; l'état choisi est conservé quand la section est reconstruite (onglet, scénarios chargés).
const howToOpen = {};
function howTo(key, items) {
  const d = h("details", { class: "howto" }, h("summary", { text: "Comment lire ces valeurs" }),
    h("ul", { class: "howto-list muted small" }, items.map((t) => h("li", { text: t }))));
  d.open = Boolean(howToOpen[key]);
  d.addEventListener("toggle", () => { howToOpen[key] = d.open; });
  return d;
}

const tmaxRange = (ens) => (ens?.tmax ? `T max ${num0(ens.tmax.p10)}–${num0(ens.tmax.p90)} °C (80 % des cas)${ens.spread ? ` · dispersion ${ens.spread}` : ""}` : null);
const ensembleTag = (ens) => `médiane de ${ens.nMembers} scénarios (${ens.nModels} modèle${ens.nModels > 1 ? "s" : ""})`;

// Pavé compact : 15 jours, un seul bloc ; une courte explication sur chacun des deux séparateurs entre les trois groupes de jours.
export function buildCompact(data, tab, ensemble) {
  const views = dayViews(data.daily, ensemble);
  const tMins = views.map((v) => v.tmin).filter(isNum), tMaxs = views.map((v) => v.tmax).filter(isNum);
  const gmin = Math.min(...tMins, ...tMaxs), gmax = Math.max(...tMins, ...tMaxs);
  const wMax = scaleMax(views.map((v) => v.d.gustMax.value ?? v.d.windMax.value), 20);
  const list = h("ol", { class: "compact-list" });
  const seps = compactSepTexts(ensemble);
  compactBlocks(views).forEach((block, i) => {
    if (i > 0) list.append(h("li", { class: `compact-sep compact-sep-${i}`, text: seps[i - 1] }));
    for (const v of block) {
      const { d } = v;
      const info = weatherInfo(d.weatherCode.value, false);
      let bar;
      if (tab === "precip") bar = probBar(v.pct);
      else if (tab === "temp") bar = rangeBar(v.tmin, v.tmax, gmin, gmax);
      else bar = h("div", { class: "hbar-box" },
        isNum(d.gustMax.value) ? h("div", { class: "hbar", style: { width: `${minVisible(barPct(d.gustMax.value, wMax))}%`, background: "var(--wind-2)" } }) : null,
        isNum(d.windMax.value) ? h("div", { class: "hbar over", style: { width: `${minVisible(barPct(d.windMax.value, wMax))}%`, background: "var(--wind)" } }) : null);
      list.append(h("li", { class: "compact-day" },
        h("span", { class: "c-name", text: d.dayIndex === 0 ? "Auj." : dayLabel(d.date) }),
        h("span", { class: "c-icon", "aria-hidden": "true", title: info.label, text: info.icon }),
        bar, h("span", { class: "c-val", text: compactValue(v, tab) })));
    }
  });
  return list;
}

// Cas observé à Montréal (GEM) : rafales max inférieures au vent max. Signalé, jamais retouché.
export const gustBelowWind = (d) => isNum(d.windMax.value) && isNum(d.gustMax.value) && d.gustMax.value < d.windMax.value;

// Étiquette d'horizon fixe, non calibrée (cahier 9).
export const confidenceText = (d) => (d.confidence ? `confiance ${d.confidence} (selon l'horizon, non calibrée)` : "");

// 7 lignes (J à J+6) avec séparateur « tendance » à la frontière calculée.
export const buildWeek = (data, tab, ensemble) => buildPeriod(firstWeek(data), tab, { sectionLabel: "ces 7 jours", summary: weekSummary, ensemble });
// 8 lignes (J+7 à J+14), toutes en tendance.
export const buildTrend = (data, tab, ensemble) => buildPeriod(secondWeek(data), tab, { sectionLabel: "ces 8 jours", summary: trendSummary, ensemble });

// 2 ou 3 phrases sur les jours 8 à 15 : températures, sec/humide, incertitudes. N'invente rien.
export function trendSummary(days, ensemble) {
  const ens = ensemble?.status === "ok" ? ensemble.days : {};
  const med = (d) => (ens[d.date] && d.dayIndex >= ENSEMBLE_MEDIAN_FROM ? ens[d.date] : null);
  const maxes = days.map((d) => (med(d) ? med(d).tmax?.median : d.tempMax.value)).filter(isNum);
  const mins = days.map((d) => (med(d) ? med(d).tmin?.median : d.tempMin.value)).filter(isNum);
  const parts = [];
  if (maxes.length && mins.length) parts.push(`Maximales de ${num0(Math.min(...maxes))} à ${num0(Math.max(...maxes))} °C, minimales de ${num0(Math.min(...mins))} à ${num0(Math.max(...mins))} °C.`);
  const withEns = days.filter((d) => med(d) && isNum(med(d).precip?.probWet));
  const single = days.filter((d) => !med(d) && d.precipClass);
  const wetSingle = single.filter((d) => d.precipClass === "fort" || d.precipClass === "modéré");
  const likely = withEns.filter((d) => med(d).precip.probWet >= 0.5);
  if (!withEns.length && !single.length) parts.push("Aucune donnée de pluie disponible sur cette période.");
  else if (!withEns.length) {
    // Sans scénarios : seulement la valeur d'un seul scénario, classée.
    if (wetSingle.length) parts.push(`Épisodes de pluie possibles : ${wetSingle.map((d) => `${dayLabel(d.date)} (${d.precipClass})`).join(", ")} ; ${single.filter((d) => d.precipClass === "sec").length} jour(s) sur ${single.length} plutôt secs.`);
    else parts.push(`Plutôt sec : ${single.filter((d) => d.precipClass === "sec").length} jour(s) sur ${single.length} sans pluie notable.`);
  } else {
    const bits = [];
    if (likely.length) bits.push(`pluie plus probable que non (au moins la moitié des scénarios) : ${likely.map((d) => dayLabel(d.date)).join(", ")}`);
    else if (withEns.length) {
      const top = withEns.reduce((m, d) => (med(d).precip.probWet > med(m).precip.probWet ? d : m));
      bits.push(`aucun jour où la pluie domine dans les scénarios (au plus ${num0(med(top).precip.probWet * 100)} % des scénarios ≥ ${WET_MM} mm, le ${dayLabel(top.date)})`);
    }
    if (wetSingle.length) bits.push(`épisodes de pluie possibles selon un seul scénario : ${wetSingle.map((d) => `${dayLabel(d.date)} (${d.precipClass})`).join(", ")}`);
    parts.push(`${bits.join(" ; ").replace(/^./, (c) => c.toUpperCase())}.`);
  }
  const sample = withEns.length ? med(withEns[0]) : null;
  if (sample) {
    parts.push(`Médiane de ${sample.nMembers} scénarios environ (${sample.nModels} modèles), bruts et non calibrés : tendance à prendre avec prudence.`);
  } else {
    const missing = days.length - single.length;
    const models = modelsOf(days, DAILY_SHOWN).map(modelShort).join(", ");
    parts.push(`${models ? `Valeurs issues de ${models}` : "Aucune valeur disponible"}, sans mesure de dispersion : tendances à prendre avec prudence${missing ? `, ${missing} jour(s) sans donnée` : ""}.`);
  }
  return parts.join(" ");
}

function hbar(pct, color) {
  return h("div", { class: "hbar-box" }, pct === null ? null : h("div", { class: "hbar", style: { width: `${minVisible(pct)}%`, background: color } }));
}
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
export function buildSources(data, warnings = null, ensemble = null, now = new Date()) {
  const tz = data.location.timezone, m = data.metadata;
  const models = displayedModels(data);
  const week = data.daily; // J à J+14
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
  items.push(h("li", { text: gaps.length ? `Données manquantes sur les 15 jours : ${gaps.map(([l, n]) => `${l} (${n} j)`).join(", ")}.` : "Aucune donnée manquante sur les 15 jours." }));
  items.push(h("li", { text: "Jusqu'à J+7, le modèle est choisi pour chaque valeur : le premier de la liste de priorité qui fournit une donnée, sans moyenne de modèles." }));
  if (ensemble?.status === "ok") {
    const sample = Object.values(ensemble.days)[0];
    items.push(h("li", { text: `Scénarios (J+${ENSEMBLE_FIRST_DAY} à J+14) : ${ensemble.models.map((m) => m.label).join(", ")}, environ ${sample?.nMembers ?? "?"} scénarios par jour, via Open-Meteo (API d'ensemble). À partir de J+${ENSEMBLE_MEDIAN_FROM}, les températures et la pluie sont la médiane de ces scénarios : ce n'est pas la prévision d'un modèle précis, et ils ne sont pas calibrés.` }));
  } else if (ensemble?.status === "unavailable") {
    items.push(h("li", { text: `Scénarios indisponibles : ${ensemble.reason} Les jours à partir de J+${ENSEMBLE_MEDIAN_FROM} montrent la valeur d'un seul scénario (ECMWF).` }));
  }
  items.push(h("li", { text: "La résolution du modèle (1,5 à 25 km selon les cas) ne rend pas compte des microclimats locaux, notamment sur le littoral." }));

  return h("div", { class: "sources" }, h("ul", {}, items));
}

// Attributions obligatoires : toujours visibles, même quand « Sources et limites » est replié.
export function buildAttribution(data, warnings = null, ensemble = null) {
  const models = displayedModels(data);
  const attribution = h("p", { class: "attrib muted small" }, h("a", { href: "https://open-meteo.com/", rel: "noopener", text: "Weather data by Open-Meteo.com" }), " · ",
    h("a", { href: "https://open-meteo.com/en/terms", rel: "noopener", text: "conditions d'utilisation" }));
  if (models.includes("meteofrance_seamless")) attribution.append(" · Source : Météo-France");
  if (ensemble?.status === "ok") attribution.append(" · Scénarios : ECMWF, NOAA, Environnement et Changement climatique Canada (via Open-Meteo)");
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
        a.text ? h("details", {}, h("summary", { text: "Texte officiel" }), h("p", { class: "alert-text", text: a.text })) : null));
    }
    card.append(list, h("p", { class: "muted small", text: "Alertes reproduites sans modification, telles que publiées par Environnement et Changement climatique Canada." }));
  }
  card.append(h("p", {}, link(warnings.link, `${warnings.linkName} ↗`)));
  return card;
}
