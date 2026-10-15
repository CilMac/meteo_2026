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

export const hourLabel = (timeISO) => `${parseInt(timeISO.slice(11, 13), 10)} h`;

// Phrase pratique sur les 24 h ; null si aucune donnée de pluie. Pas de conseil de sortie (hors V1).
export function rainOutlook(hours) {
  if (!hours.length) return null;
  const withPrecip = hours.filter((h) => isNum(h.precip.value));
  const probs = hours.filter((h) => isNum(h.precipProb.value));
  if (!withPrecip.length && !probs.length) return null;
  const wet = withPrecip.filter((h) => h.precip.value >= 0.2);
  if (wet.length) {
    const total = wet.reduce((s, h) => s + h.precip.value, 0);
    const a = hourLabel(wet[0].time), b = hourLabel(wet[wet.length - 1].time);
    return a === b ? `Pluie attendue vers ${a} (environ ${num1(total)} mm).` : `Pluie attendue entre ${a} et ${b} (environ ${num1(total)} mm au total).`;
  }
  const best = probs.reduce((m, h) => (!m || h.precipProb.value > m.precipProb.value ? h : m), null);
  if (best && best.precipProb.value >= 30) return `Pas de pluie prévue en quantité, mais risque le plus marqué vers ${hourLabel(best.time)} (${num0(best.precipProb.value)} %).`;
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
  const wet = solid.filter((d) => d.precipSum.value >= 2);
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
  const outlook = rainOutlook(next24h(data));
  return h("div", { class: "card current" },
    h("div", { class: "cur-main" },
      h("span", { class: "cur-icon", "aria-hidden": "true", text: info.icon }),
      h("span", { class: "cur-temp", text: deg(c.temp) }),
      h("div", {}, h("div", { class: "cur-desc", text: info.label }),
        h("div", { class: "muted", text: `Ressenti ${deg(c.apparent)}` }))),
    h("p", { class: "muted small", text: c.time ? `Conditions estimées à ${hourLabel(c.time)} par un modèle (pas une mesure). Heure locale : ${formatLocal(now, tz, { hour: "2-digit", minute: "2-digit" })}.` : "Heure de la situation indisponible." }),
    h("div", { class: "cur-grid" },
      stat("precip", "Risque de pluie (max horaire du jour)", isNum(d0.precipProbMax.value) ? `${num0(d0.precipProbMax.value)} %` : "—", modelsLine(d0, [["", "precipProbMax"]])),
      stat("temp", "Min / max du jour", `${deg(d0.tempMin.value)} / ${deg(d0.tempMax.value)}`, modelsLine(d0, [["min", "tempMin"], ["max", "tempMax"]])),
      stat("wind", "Vent actuel · rafales", `${num0(c.wind)} · ${num0(c.gust)} km/h`, "")),
    outlook ? h("p", { class: "outlook", text: outlook }) : null);
}
function stat(family, label, value, model) {
  return h("div", { class: `stat fam-${family}` }, h("div", { class: "muted small", text: label }), h("div", { class: "stat-val", text: value }), model ? h("div", { class: "tag", text: model }) : null);
}

// Ligne fixe du haut : lieu + situation estimée (icône, température, ciel).
export function buildTopLine(data) {
  const c = data.current;
  const info = weatherInfo(c.weatherCode, c.time ? isNight(c.time, data.daily) : false);
  return h("div", { class: "top-inner" },
    h("span", { class: "top-place", title: `${data.location.name} (${data.location.country})` },
      h("span", { class: "pin", "aria-hidden": "true", text: "📍" }),
      h("span", { class: "top-name", text: data.location.name })),
    h("span", { class: "top-now", title: "Estimation de modèle, pas une mesure" },
      h("span", { class: "top-icon", "aria-hidden": "true", text: info.icon }),
      h("strong", { text: deg(c.temp) }),
      h("span", { class: "top-desc", text: info.label })));
}

// Bandeau 24 h piloté par l'onglet actif.
export function buildHourly(data, tab) {
  const hours = next24h(data);
  const wrap = h("div", {});
  if (!hours.length) return h("p", { class: "muted", text: "Données horaires indisponibles." });
  const get = { precip: (x) => x.precip.value, temp: (x) => x.temp.value, wind: (x) => Math.max(x.gust.value ?? -Infinity, x.wind.value ?? -Infinity) };
  const vals = hours.map(get[tab]).filter((v) => isNum(v) && v > -Infinity);
  const tmin = Math.min(...vals), tmax = Math.max(...vals);
  const pMax = scaleMax(hours.map((x) => x.precip.value), 1), wMax = scaleMax(hours.map((x) => x.gust.value ?? x.wind.value), 10);

  const strip = h("div", { class: "strip", role: "list", tabindex: "0", "aria-label": "Prévisions horaires, défilement horizontal" });
  for (const x of hours) {
    const info = weatherInfo(x.weatherCode.value, isNight(x.time, data.daily));
    let bars, l1, l2;
    if (tab === "precip") {
      bars = vbar(barPct(x.precip.value, pMax), "var(--rain)");
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
  const notes = [`Pas de 1 h · ${modelNotes}.`];
  if (hours.length < 24) notes.push(`Données horaires disponibles seulement jusqu'à ${hourLabel(hours[hours.length - 1].time)}.`);
  const missing = hours.filter((x) => x[{ precip: "precip", temp: "temp", wind: "wind" }[tab]].value === null).length;
  if (missing) notes.push(`${missing} plage(s) sans donnée (affichées « — »).`);
  if (tab === "precip") notes.push("Barres proportionnelles à la quantité (mm), pas au pourcentage.");
  wrap.append(h("p", { class: "muted small", text: notes.join(" ") }));
  return wrap;
}
function vbar(pct, color) {
  return h("div", { class: "vbar-box" }, pct === null ? null : h("div", { class: "vbar", style: { height: `${minVisible(pct)}%`, background: color } }));
}

// Lignes de jours (7 jours ou 8-15 jours) : même construction, échelles propres à la section.
// `ensemble` : undefined = scénarios en cours de chargement ; { status: "unavailable" } ; { status: "ok", days, models }.
//  - J+4 à J+7 : la valeur d'un seul scénario (ECMWF) reste, avec la fourchette des scénarios à côté ;
//  - à partir de J+8 : la médiane des scénarios remplace la valeur d'un seul scénario (températures et pluie).
function buildPeriod(days, tab, { sectionLabel, summary, ensemble }) {
  const wrap = h("div", {});
  const ensDays = ensemble?.status === "ok" ? ensemble.days : {};
  const views = days.map((d) => {
    const ens = ensDays[d.date] ?? null;
    const median = ens && d.dayIndex >= ENSEMBLE_MEDIAN_FROM;
    const range = ens && d.dayIndex >= ENSEMBLE_FIRST_DAY && !median;
    return {
      d, ens, median, range,
      tmin: median ? ens.tmin?.median ?? null : d.tempMin.value,
      tmax: median ? ens.tmax?.median ?? null : d.tempMax.value,
      mm: median ? ens.precip?.mean ?? null : d.precipSum.value,
    };
  });
  const pMax = scaleMax(views.map((v) => v.mm), 5);
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
        bar = hbar(barPct(v.mm, pMax), "var(--rain)");
        const p = ens.precip?.probWet;
        value = [isNum(p) ? `${num0(p * 100)} % des scénarios ≥ ${WET_MM} mm` : null, isNum(v.mm) ? `moy. ${num1(v.mm)} mm` : null].filter(Boolean).join(" · ") || "—";
        tag.push(ensembleTag(ens), isNum(ens.precip?.p90) ? `1 cas sur 10 : ${num1(ens.precip.p90)} mm ou plus` : null);
        keepConfidence = false;
      } else {
        bar = hbar(barPct(d.precipSum.value, pMax), "var(--rain)");
        const prob = isNum(d.precipProbMax.value) ? `${num0(d.precipProbMax.value)} %` : null;
        // Tendance : la quantité reste affichée (moins fiable) ; la classe qualitative l'accompagne.
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
  const hasMedian = views.some((v) => v.median);
  const notes = [];
  if (tab === "precip") {
    notes.push(hasMedian
      ? `À partir de J+${ENSEMBLE_MEDIAN_FROM}, le pourcentage est la part des scénarios donnant au moins ${WET_MM} mm sur le jour ; « moy. » est la moyenne des scénarios (la médiane vaut souvent 0 mm).`
      : "Le pourcentage est la probabilité horaire maximale du jour, pas la probabilité de pluie sur toute la journée.");
    if (hasMedian) notes.push("Avant J+8, le pourcentage est la probabilité horaire maximale du jour.");
    if (views.some((v) => v.d.trend && !v.median)) notes.push(`Jours en tendance : la quantité est moins fiable ; la classe entre parenthèses aide à la lire : ${RAIN_LEGEND}.`);
  }
  if (tab === "wind") notes.push("Valeurs quotidiennes = maxima (vent max, rafales max), jamais des moyennes. Barre foncée : vent max ; claire : rafales max. Secteur = direction dominante d'où vient le vent.");
  if (tab === "temp") notes.push("Barres : de la minimale à la maximale du jour.");
  if (tab !== "wind" && views.some((v) => v.ens)) {
    notes.push(`Scénarios : médiane et fourchette (80 % des cas) de plusieurs modèles, chacun pesant autant ; scénarios bruts, non calibrés. Dispersion : faible si l'écart des maximales est de moins de 4 °C, forte au-delà de 8 °C.`);
  }
  notes.push(`Échelle des barres propre à ${sectionLabel}.`);
  wrap.append(h("p", { class: "muted small", text: notes.join(" ") }));
  const text = summary(days, ensemble);
  if (text) wrap.append(h("p", { class: "summary", text }));
  return wrap;
}

const tmaxRange = (ens) => (ens?.tmax ? `T max ${num0(ens.tmax.p10)}–${num0(ens.tmax.p90)} °C (80 % des cas)${ens.spread ? ` · dispersion ${ens.spread}` : ""}` : null);
const ensembleTag = (ens) => `médiane de ${ens.nMembers} scénarios (${ens.nModels} modèle${ens.nModels > 1 ? "s" : ""})`;

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

  const attribution = h("p", {}, h("a", { href: "https://open-meteo.com/", rel: "noopener", text: "Weather data by Open-Meteo.com" }), " · ",
    h("a", { href: "https://open-meteo.com/en/terms", rel: "noopener", text: "conditions d'utilisation" }));
  if (models.includes("meteofrance_seamless")) attribution.append(" · Source : Météo-France");
  if (ensemble?.status === "ok") attribution.append(" · Scénarios : ECMWF, NOAA, Environnement et Changement climatique Canada (via Open-Meteo)");
  if (warnings?.status === "confirmed") {
    attribution.append(` · ${ECCC_ATTRIBUTION} `, h("a", { href: ECCC_LICENCE_URL, rel: "noopener", text: "(licence)" }));
  }
  return h("div", { class: "card sources" }, h("h2", { text: "Sources et limites" }), attribution, h("ul", {}, items));
}

// G. Vigilances : officielle seulement si vérifiée ; sinon « non confirmée » + lien. `warnings` null = vérification en cours.
export function buildWarnings(data, warnings) {
  const tz = data.location.timezone;
  const card = h("div", { class: "card warnings" }, h("h2", { text: "Vigilances et informations utiles" }));
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
