// Écran d'accueil (25/11/2026) : l'essentiel des 4 heures à venir à la position de l'appareil. Calculs (testés) puis construction de l'écran.
// Tout le texte est écrit par textContent ; une donnée absente est « — », jamais 0.
import { STEP_MS, stepKind, mmPerHour, GUST_WARN, LEVEL_WORD } from "./walk.js?v=68874bb7";
import { trendSign } from "./barometer.js?v=f58dbfb8";
import { next24h, modelShort } from "./weather-provider.js?v=631084d1";
import { EXTREME, MINI_MM_FULL, RISK_PCT, minVisible, outlookSpan, isNum, num0, num1, deg, weatherInfo, isNight, sunTimes, hourLabel, extremeOf, modelsOf } from "./weather-render.js?v=38232aca";

export const HOME_HOURS = 4;
export const HOME_STEPS = HOME_HOURS * 4; // pas de 15 minutes

// Au lancement : « go » (écran, position cherchée aussitôt), « ask » (écran d'invitation : la demande de position ne surgit qu'au toucher
// d'un bouton, pour qui n'a jamais donné sa position), « none » (page habituelle : ordinateur, tablette autre qu'iPad, ou position refusée ou déclinée sur cet appareil).
// mobile : téléphone (PHONE_QUERY) ou appareil iOS, iPad compris (device.js). flag : « ok » | « no » | null (meteo.home) ; used : la position a déjà servi ici (relevés, « Ma position ») ; forced : adresse « ?accueil ».
export const HOME_KEY = "meteo.home", PHONE_QUERY = "(max-width: 500px) and (pointer: coarse)";
export function homeMode({ forced = false, mobile = false, flag = null, used = false } = {}) {
  if (forced) return "go";
  if (!mobile || flag === "no") return "none";
  return flag === "ok" || used ? "go" : "ask";
}

// Les 16 quarts d'heure à partir de celui en cours. Une case manquante reste (mm inconnu) : rien n'est décalé ni deviné.
export function homeSteps(rows, now) {
  const first = (Math.floor(now / STEP_MS) + 1) * STEP_MS; // fin du quart d'heure en cours
  const byT = new Map((rows ?? []).map((r) => [r.t, r]));
  return Array.from({ length: HOME_STEPS }, (_, i) => byT.get(first + i * STEP_MS) ?? { t: first + i * STEP_MS, mm: null });
}

// Épisodes de pluie ou de neige : [début, fin[ en numéros de pas ; un seul quart d'heure sec entre deux n'en fait pas deux épisodes.
export function wetRuns(steps) {
  const runs = [];
  steps.forEach((s, i) => {
    if (stepKind(s).level === 0) return;
    const last = runs[runs.length - 1];
    if (last && i - last[1] < 2) last[1] = i + 1; else runs.push([i, i + 1]);
  });
  return runs;
}

const WET_CODE = 51; // types de temps OMM à partir de 51 : bruine, pluie, neige… (le modèle peut annoncer de la bruine avec 0 mm : ne pas dire « sec »)
const cap = (t) => t[0].toUpperCase() + t.slice(1);
// « pluie faible », « neige modérée à forte », « pluie verglaçante », « pluie et neige ».
function wetWords(steps) {
  const wet = steps.map(stepKind).filter((k) => k.level > 0);
  const kinds = new Set(wet.map((k) => k.kind));
  if (kinds.has("freezing")) return "pluie verglaçante";
  if (kinds.size > 1) return "pluie et neige";
  const levels = wet.map((k) => k.level), lo = Math.min(...levels), hi = Math.max(...levels);
  return `${kinds.has("snow") ? "neige" : "pluie"} ${LEVEL_WORD[lo]}${hi > lo ? ` à ${LEVEL_WORD[hi]}` : ""}`;
}

// La phrase de l'écran : un titre et une précision. Les heures sont celles d'un modèle par quart d'heure, pas d'un radar : « vers ».
// Jamais « avant 15:45 » ni « jusqu'à 15:45 » pour la fin des 4 heures : on lirait que la pluie commence à ce moment-là.
// nowCode : type de temps affiché en haut ; s'il annonce de la bruine, la phrase ne dit pas « sec » juste dessous.
// risk : texte de homeRisk, ou null ; 0 mm mais une probabilité notable : la phrase ne dit plus « sec » sans réserve.
export function rainPhrase(steps, fmtTime, nowCode = null, risk = null) {
  const total = rainTotal(steps);
  if (total === null) return { tone: "unknown", title: "Pluie des 4 prochaines heures inconnue", detail: "Données incomplètes." };
  const runs = wetRuns(steps), n = steps.length;
  const at = (i) => fmtTime(steps[i].t - STEP_MS), end4 = fmtTime(steps[n - 1].t), mm = `${num1(total)}\u00a0mm`, s = Math.round(total * 10) / 10 >= 2 ? "s" : ""; // at : début du pas i
  if (!runs.length) {
    return nowCode >= WET_CODE || steps.some((x) => x.mm > 0 || x.code >= WET_CODE)
      ? { tone: "dry", title: "Au plus quelques gouttes", detail: `${mm} prévu${s} en 4 heures.` }
      : risk ? { tone: "dry", title: "Sec, mais pluie possible", detail: `0\u00a0mm prévu de ${at(0)} à ${end4}. ${risk}` }
      : { tone: "dry", title: "Sec pendant 4 heures", detail: `Aucune pluie prévue de ${at(0)} à ${end4}.` };
  }
  const what = wetWords(steps), start = runs[0][0], end = runs[runs.length - 1][1], until = end < n ? at(end) : null;
  const sum = `${mm} prévu${s} en 4 heures`;
  if (runs.length > 1) { // fin non vue dans les 4 heures : on ne dit pas quand cela s'arrête
    const when = start && until ? `De ${at(start)} à ${until} environ` : start ? `À partir de ${at(start)} environ` : until ? `Jusque vers ${until}` : null;
    return { tone: "wet", title: `${cap(what)} par moments`, detail: when ? `${when}, ${sum}.` : `${cap(sum)}.` };
  }
  if (!start && !until) return { tone: "wet", title: `${cap(what)} pendant 4 heures`, detail: `${cap(sum)}.` };
  if (!start) return { tone: "wet", title: `Sec vers ${until}`, detail: `${cap(what)} d'ici là (${mm}), puis sec le reste des 4 heures.` };
  if (!until) return { tone: "wet", title: `${cap(what)} vers ${at(start)}`, detail: `Sec d'ici là, ${sum}.` };
  return { tone: "wet", title: `${cap(what)} vers ${at(start)}`, detail: `Jusque vers ${until}, ${sum}.` };
}

const num2 = (v) => v.toLocaleString("fr-FR"); // 0,75

// Cumul des pas ; un seul pas inconnu : pas de total.
export const rainTotal = (steps) => (steps.length && steps.every((s) => isNum(s.mm)) ? steps.reduce((a, s) => a + s.mm, 0) : null);

// Avertissements, seulement s'il y a lieu : orage prévu, fortes rafales, jour à pastille rouge (l'orage observé s'ajoute en tête à l'affichage).
export function homeAlerts(data, steps, fmtTime) {
  const out = [];
  const storm = steps.find((s) => s.storm);
  if (storm) out.push(`Orage possible vers ${fmtTime(storm.t - STEP_MS)}${storm.storm.hail ? ", avec grêle" : ""} (${storm.storm.by.map(modelShort).join(", ")}).`);
  const day = data.daily[0], extremes = day ? ["precip", "wind", "temp"].flatMap((tab) => extremeOf(day, tab)) : [];
  const gusts = next24h(data).slice(0, HOME_HOURS).map((x) => x.gust.value).filter(isNum), gust = Math.max(...gusts);
  if (gusts.length && Math.round(gust) >= GUST_WARN) out.push(`Vent fort : rafales jusqu'à ${num0(gust)} km/h dans les 4 heures.`);
  for (const x of extremes) out.push(`Aujourd'hui : ${x.name}. ${x.value}${x.model ? ` (${modelShort(x.model)})` : ""}, ce n'est pas une vigilance officielle.`);
  return out;
}

// « Risque le plus marqué entre 14 h et 15 h (57 %). » si l'une des 4 heures atteint RISK_PCT (même seuil et mêmes mots que la page principale).
export function homeRisk(data) {
  const best = next24h(data).slice(0, HOME_HOURS).filter((x) => isNum(x.precipProb?.value)).reduce((m, x) => (!m || x.precipProb.value > m.precipProb.value ? x : m), null);
  if (!best || best.precipProb.value < RISK_PCT) return null;
  return `Risque le plus marqué ${outlookSpan(best.time, best.time, data.current.time ? data.current.time.slice(0, 10) : null)} (${num0(best.precipProb.value)}\u00a0%).`;
}

// Valeur hors du commun (en rouge) : mêmes seuils que la pastille rouge des jours, comparés à la valeur affichée (arrondie).
export const isExtremeTemp = (v) => isNum(v) && (Math.round(v) >= EXTREME.hot || Math.round(v) <= EXTREME.cold);
export const isExtremeGust = (v) => isNum(v) && Math.round(v) >= EXTREME.gust;

// Les 4 prochaines heures (mêmes valeurs et même convention que la vue 🥾 : « 11 h » = pluie et rafales de 10 h à 11 h).
export function homeHours(data) {
  return next24h(data).slice(0, HOME_HOURS).map((x) => {
    const w = weatherInfo(x.weatherCode.value, isNight(x.time, data.daily));
    return {
      hour: hourLabel(x.time), icon: w.icon, sky: w.label, temp: deg(x.temp.value),
      mm: isNum(x.precip.value) ? `${num1(x.precip.value)} mm` : "— mm", wet: isNum(x.precip.value) && x.precip.value > 0,
      pct: isNum(x.precipProb?.value) ? x.precipProb.value : null, prob: isNum(x.precipProb?.value) ? `${num0(x.precipProb.value)}\u00a0%` : "—\u00a0%",
      gust: isNum(x.gust.value) ? num0(x.gust.value) : "—",
      tempRed: isExtremeTemp(x.temp.value), gustRed: isExtremeGust(x.gust.value),
    };
  });
}

// « Heures : Météo-France. Probabilité : ECMWF. Quarts d'heure : Météo-France. »
export function homeSources(data, steps) {
  const names = (ms) => [...new Set(ms.filter(Boolean).map(modelShort))].join(", ") || "modèle indisponible";
  return `Heures\u00a0: ${names(modelsOf(next24h(data).slice(0, HOME_HOURS), ["weatherCode", "temp", "precip", "gust"]))}. Probabilité\u00a0: ${names(modelsOf(next24h(data).slice(0, HOME_HOURS), ["precipProb"]))}. Quarts d'heure\u00a0: ${names(steps.map((s) => s.src?.mm))}.`;
}

// ── Construction ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const el = (tag, cls, ...children) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
};
const hidden = (e) => { e.setAttribute("aria-hidden", "true"); return e; };
const link = (href, text) => { const a = el("a", "", text); a.href = href; a.rel = "noopener"; return a; };

// Dessin au trait du vent (icône Tabler, licence MIT).
const SVG = {
  wind: "M5 8h8.5a2.5 2.5 0 1 0-2.34-3.24M3 12h15.5a2.5 2.5 0 1 1-2.34 3.24M4 16h5.5a2.5 2.5 0 1 1-2.34 3.24",
};
function icon(name) {
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg"), path = document.createElementNS(ns, "path");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", `mini-svg home-ico is-${name}`); svg.setAttribute("focusable", "false");
  path.setAttribute("d", SVG[name]); svg.append(path);
  return hidden(svg);
}

// Légende des bâtons : ce qu'ils mesurent, et ce que vaut un bâton plein (ou le rouge, dès qu'il y en a un).
function barsCaption(steps) {
  const full = `${num2(MINI_MM_FULL / 4)}\u00a0mm`, over = steps?.some((s) => isNum(s.mm) && mmPerHour(s.mm) > MINI_MM_FULL);
  return el("div", "home-cap", el("span", "", "Pluie en mm par quart d'heure"), el("span", "", hidden(el("i", over ? "is-over" : "")), over ? `plus de ${full}` : `plein\u00a0: ${full}`));
}
// Bâtons sur fond gris (le maximum dessiné) : même échelle que « Balade ? » et le tableau 🥾 (plein à 3 mm dans l'heure, rouge au-delà).
function bars(steps, fmtTime) {
  const wrap = el("div", "home-bars"), cols = el("div", "home-cols"), axis = hidden(el("div", "home-axis"));
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", `Pluie par quart d'heure : ${steps.map((s) => `${fmtTime(s.t - STEP_MS)}, ${isNum(s.mm) ? `${num1(s.mm)} mm` : "inconnu"}`).join(" ; ")}`);
  steps.forEach((s, i) => {
    const mmh = isNum(s.mm) ? mmPerHour(s.mm) : null;
    const b = el("div", `home-track${mmh === null ? " is-missing" : ""}`, mmh === null ? "—" : null);
    if (mmh > 0) {
      const fill = el("div", `home-bar${mmh > MINI_MM_FULL ? " is-over" : ""}`);
      fill.style.height = `${Math.max(8, Math.min(100, (mmh / MINI_MM_FULL) * 100))}%`;
      b.append(fill);
    }
    b.title = `De ${fmtTime(s.t - STEP_MS)} à ${fmtTime(s.t)} : ${isNum(s.mm) ? `${num1(s.mm)} mm` : "inconnu"}`;
    cols.append(b);
    if (i % 4 === 0) axis.append(el("span", "", fmtTime(s.t - STEP_MS)));
  });
  axis.append(el("span", "", fmtTime(steps[steps.length - 1].t)));
  wrap.append(cols, axis);
  return wrap;
}
// Barre horizontale = probabilité (convention de toute l'appli : verticale = mm).
function probBar(pct) {
  const box = hidden(el("div", "hbar-box home-h-bar"));
  if (isNum(pct)) { const b = el("div", "hbar"); b.style.width = `${minVisible(Math.max(0, Math.min(100, pct)))}%`; box.append(b); }
  return box;
}
// Repère sur deux lignes : haut, bas.
const fact = (top, bottom) => el("div", "home-fact", el("div", "", top), el("div", "", bottom));
const RED = () => said("Hors du commun : "); // le rouge ne se voit pas à l'oreille
const said = (text) => el("span", "sr-only", text); // lu par les lecteurs d'écran, à la place du dessin

// Haut de l'écran : la situation à l'instant T, à la position de l'appareil.
export function buildHomeNow(data) {
  const c = data.current, info = weatherInfo(c.weatherCode, c.time ? isNight(c.time, data.daily) : false);
  return el("div", "home-now",
    hidden(el("span", "home-icon", info.icon)),
    el("span", `home-temp${isExtremeTemp(c.temp) ? " is-extreme" : ""}`, isExtremeTemp(c.temp) ? RED() : null, deg(c.temp)),
    el("div", "home-desc", el("strong", "", info.label), el("span", "", `Ressenti ${deg(c.apparent)}`)));
}

// Zones : avertissements s'il y en a, pluie, quatre heures, repères. steps : undefined = en cours de lecture, null = illisibles.
export function buildHome({ data, steps, alerts, fmtTime, pressureEl }) {
  const phrase = steps ? rainPhrase(steps, fmtTime, data.current.weatherCode, homeRisk(data)) : { tone: "unknown", title: steps === undefined ? "Lecture de la pluie…" : "Pluie par quart d'heure indisponible", detail: steps === undefined ? "Par quart d'heure, sur 4 heures." : "Les heures ci-dessous restent valables." };
  const sun = sunTimes(data.current.time ? data.current.time.slice(0, 10) : data.daily[0].date, data.daily), hours = homeHours(data), out = document.createDocumentFragment();
  if (alerts.length) out.append(el("section", "home-zone home-alerts", ...alerts.map((t) => el("p", "", t))));
  out.append(el("section", "home-zone home-rain",
    el("h2", `is-${phrase.tone}`, phrase.title), el("p", "", phrase.detail),
    steps === null ? null : barsCaption(steps), steps === null ? null : steps ? bars(steps, fmtTime) : el("div", "home-bars is-wait"))); // pendant la lecture, la place est gardée : rien ne saute
  out.append(hours.length ? el("section", "home-zone home-hours", ...hours.map((x) => el("div", "home-hour",
    el("span", "home-h-hour", x.hour), hidden(el("span", "home-h-icon", x.icon)), el("span", "sr-only", x.sky), el("span", `home-h-temp${x.tempRed ? " is-extreme" : ""}`, x.tempRed ? RED() : null, x.temp),
    el("span", `home-h-mm${x.wet ? " is-wet" : ""}`, x.mm),
    el("span", "home-h-prob", said("Probabilité de pluie : "), x.prob), probBar(x.pct), el("span", `home-h-gust${x.gustRed ? " is-extreme" : ""}`, x.gustRed ? RED() : null, "raf. ", x.gust)))) : el("p", "home-zone muted", "Données horaires indisponibles."));
  out.append(el("section", "home-zone home-facts",
    sun.polar ? fact("Soleil", sun.polar.replace("Soleil ", ""))
      : fact(el("span", "sun sun-rise", said("Lever du soleil : "), sun.rise), el("span", "sun sun-set", said("Coucher du soleil : "), sun.set)),
    pressureEl, // bouton « icône, valeur, tendance » : ouvre le baromètre
    fact(el("span", "", said("Vent"), icon("wind")), isNum(data.current.wind) ? `${num0(data.current.wind)} km/h` : "— km/h")));
  return out;
}

// Fenêtre « i » : légende technique. Rubriques { title, note, rows: [{ sym, text, sub }] } (sym : clé de SYMBOLS), puis notes [sujet, texte] de l'accordéon.
export function homeLegend(data, steps) {
  const time = data?.current?.time?.slice(11, 16), full = `${num2(MINI_MM_FULL / 4)}\u00a0mm`;
  return {
    sections: [
      { title: "Situation actuelle", note: `valeurs de modèle${time ? `, ${time}` : ""}`, rows: [
        { sym: "temp", text: "Température de l'air et ressenti, à votre position" }] },
      { title: "Pluie par quart d'heure", note: "4 heures, en mm", rows: [
        { sym: "bars", text: `Échelle fixe\u00a0: barre pleine = ${full}, soit ${MINI_MM_FULL}\u00a0mm/h`, sub: "Grise\u00a0: 0\u00a0mm. Rouge\u00a0: échelle dépassée. «\u00a0—\u00a0»\u00a0: donnée absente." },
        { sym: "risk", text: `«\u00a0Sec, mais pluie possible\u00a0»\u00a0: cumul prévu nul, probabilité d'au moins ${RISK_PCT}\u00a0% dans l'une des 4\u00a0heures` }] },
      { title: "Prévision horaire", note: "4 prochaines heures", rows: [
        { sym: "hour", text: "Température et ciel à 16\u00a0h\u00a0; précipitations et rafales de 15\u00a0h à\u00a016\u00a0h" },
        { sym: "mm", text: "Cumul de précipitations" },
        { sym: "prob", text: "Probabilité de précipitations", sub: "Seuil\u00a0: plus de 0,1\u00a0mm dans l'heure" },
        { sym: "gust", text: "Rafale maximale, en km/h" }] },
      { title: "Repères", rows: [
        { sym: "sun", text: "Lever et coucher du soleil" },
        { sym: "baro", text: "Pression au niveau de la mer, station la plus proche", sub: "«\u00a0≈\u00a0»\u00a0: valeur de modèle. Ouvre le baromètre." },
        { sym: "trend", text: "Tendance sur 3\u00a0h environ\u00a0: hausse, stabilité, baisse" },
        { sym: "wind", text: "Vent actuel" },
        { sym: "map", text: "Carte plein écran", sub: "Point bleu\u00a0: position\u00a0; disque\u00a0: précision. «\u00a0Nuages · pluie\u00a0»\u00a0: valeurs de modèles à l'instant, interpolées." }] },
      { title: "Valeurs signalées", note: "hors vigilance officielle", rows: [
        { sym: "red", text: `Hors du commun\u00a0: ≥\u00a0${EXTREME.hot}\u00a0°C, ≤\u00a0−${num0(-EXTREME.cold)}\u00a0°C, rafales ≥\u00a0${EXTREME.gust}\u00a0km/h` },
        { sym: "alert", text: `Orage, rafales ≥\u00a0${GUST_WARN}\u00a0km/h ou jour hors du commun` }] },
    ],
    notes: [
      ...(data ? [["Modèles", homeSources(data, steps ?? [])]] : []),
      ["Quarts d'heure", "heures issues d'un modèle, non d'un radar, d'où «\u00a0vers\u00a0»."],
      ["«\u00a0Au plus quelques gouttes\u00a0»", "bruine ou gouttes prévues, cumul négligeable."],
      ["Probabilité", "maille d'environ 27\u00a0km\u00a0; une bruine fine peut lui échapper. Indépendante du cumul, souvent issue d'un autre modèle."],
    ],
  };
}

// Symboles de la légende, tels qu'ils apparaissent à l'écran. Un dessin est masqué aux lecteurs d'écran (la définition suffit).
const draw = (...parts) => hidden(el("span", "hl-sym", ...parts)), text = (t) => el("span", "hl-sym is-text", t);
const track = (pct, over) => { const b = el("i", `home-bar${over ? " is-over" : ""}`), t = el("span", "home-track", pct ? b : null); b.style.height = `${pct}%`; return t; };
const SYMBOLS = {
  temp: () => { const s = text("4°"); s.classList.add("is-big"); return s; },
  bars: () => draw(track(0), track(45), track(100, true)),
  risk: () => { const s = draw("?"); s.classList.add("is-big"); return s; },
  hour: () => text("16\u00a0h"), mm: () => text("1,1\u00a0mm"), gust: () => text("raf.\u00a035"),
  prob: () => { const s = text("88\u00a0%"); s.append(probBar(88)); return s; },
  sun: () => draw(el("span", "sun sun-rise"), el("span", "sun sun-set")),
  baro: () => { const s = draw(); s.innerHTML = '<svg class="mini-svg hl-baro" viewBox="0 0 24 24" focusable="false"><use href="#ico-baro"/></svg>'; return s; },
  trend: () => draw(trendSign("up"), trendSign("steady"), trendSign("down")),
  wind: () => draw(icon("wind")),
  map: () => { const s = draw(); s.innerHTML = '<svg class="mini-svg hl-baro" viewBox="0 0 24 24" focusable="false"><path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4zM9 4v14M15 6v14"/></svg>'; return s; },
  red: () => { const s = text("105"); s.classList.add("is-red"); s.prepend(said("En rouge, comme ")); return s; },
  alert: () => { const s = el("span", "hl-sym", el("span", "hl-frame", said("Encadré jaune"))); return s; },
};
export function buildLegend(sections) {
  const out = document.createDocumentFragment();
  for (const s of sections) out.append(
    el("h3", "hl-title", s.title, s.note ? el("span", "", s.note) : null),
    el("ul", "hl-rows", ...s.rows.map((r) => el("li", "", SYMBOLS[r.sym](), el("span", "hl-text", r.text, r.sub ? el("span", "hl-sub", r.sub) : null)))));
  return out;
}
