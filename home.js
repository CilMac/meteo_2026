// Écran d'accueil (25/11/2026) : l'essentiel des 4 heures à venir à la position de l'appareil. Calculs (testés) puis construction de l'écran.
// Tout le texte est écrit par textContent ; une donnée absente est « — », jamais 0.
import { STEP_MS, stepKind, mmPerHour, GUST_WARN, LEVEL_WORD } from "./walk.js?v=dbfc9474";
import { trendSign } from "./barometer.js?v=f58dbfb8";
import { next24h, modelShort } from "./weather-provider.js?v=afd8726c";
import { EXTREME, MINI_MM_FULL, RISK_PCT, minVisible, outlookSpan, isNum, num0, num1, deg, weatherInfo, isNight, sunTimes, hourLabel, extremeOf, modelsOf } from "./weather-render.js?v=8a4c0223";

export const HOME_HOURS = 4;
export const HOME_STEPS = HOME_HOURS * 4; // pas de 15 minutes
// 12 heures en 3 pages de 4 heures (27/11/2026) : la pluie et les heures glissent ensemble, une page à la fois.
export const HOME_PAGES = 3;

// Au lancement : « go » (écran, position cherchée aussitôt), « ask » (écran d'invitation : la demande de position ne surgit qu'au toucher
// d'un bouton, pour qui n'a jamais donné sa position), « none » (page habituelle : ordinateur, tablette autre qu'iPad, ou position refusée ou déclinée sur cet appareil).
// mobile : téléphone (PHONE_QUERY) ou appareil iOS, iPad compris (device.js). flag : « ok » | « no » | null (meteo.home) ; used : la position a déjà servi ici (relevés, « Ma position ») ; forced : adresse « ?accueil ».
export const HOME_KEY = "meteo.home", PHONE_QUERY = "(max-width: 500px) and (pointer: coarse)";
export function homeMode({ forced = false, mobile = false, flag = null, used = false } = {}) {
  if (forced) return "go";
  if (!mobile || flag === "no") return "none";
  return flag === "ok" || used ? "go" : "ask";
}

// Les quarts d'heure à partir de celui en cours (16 par page). Une case manquante reste (mm inconnu) : rien n'est décalé ni deviné.
export function homeSteps(rows, now, count = HOME_STEPS) {
  const first = (Math.floor(now / STEP_MS) + 1) * STEP_MS; // fin du quart d'heure en cours
  const byT = new Map((rows ?? []).map((r) => [r.t, r]));
  return Array.from({ length: count }, (_, i) => byT.get(first + i * STEP_MS) ?? { t: first + i * STEP_MS, mm: null });
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
  if (total === null) return { tone: "unknown", title: "Pluie inconnue sur ces 4 heures", detail: "Données incomplètes." };
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

// Glissement des pages : page d'arrivée après un geste de dx px (négatif = vers la gauche, donc page suivante) en ms millisecondes,
// sur une tuile de w px. Plus d'un quart de la largeur, ou un geste vif d'au moins 20 px : page voisine ; sinon, retour à la page de départ.
export function swipeTarget(cur, dx, w, ms, pages) {
  const fast = ms > 0 && Math.abs(dx) / ms > 0.4;
  const move = Math.abs(dx) > w * 0.25 || (fast && Math.abs(dx) > 20) ? -Math.sign(dx) : 0;
  return Math.max(0, Math.min(pages - 1, cur + move));
}

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

// « Risque le plus marqué entre 14 h et 15 h (57 %). » si l'une des 4 heures de la page atteint RISK_PCT (même seuil et mêmes mots que la page principale).
export function homeRisk(data, page = 0) {
  const best = next24h(data).slice(page * HOME_HOURS, (page + 1) * HOME_HOURS).filter((x) => isNum(x.precipProb?.value)).reduce((m, x) => (!m || x.precipProb.value > m.precipProb.value ? x : m), null);
  if (!best || best.precipProb.value < RISK_PCT) return null;
  return `Risque le plus marqué ${outlookSpan(best.time, best.time, data.current.time ? data.current.time.slice(0, 10) : null)} (${num0(best.precipProb.value)}\u00a0%).`;
}

// Valeur hors du commun (en rouge) : mêmes seuils que la pastille rouge des jours, comparés à la valeur affichée (arrondie).
export const isExtremeTemp = (v) => isNum(v) && (Math.round(v) >= EXTREME.hot || Math.round(v) <= EXTREME.cold);
export const isExtremeGust = (v) => isNum(v) && Math.round(v) >= EXTREME.gust;

// Les prochaines heures, 4 par défaut (mêmes valeurs et même convention que la vue 🥾 : « 11 h » = pluie et rafales de 10 h à 11 h).
export function homeHours(data, count = HOME_HOURS) {
  return next24h(data).slice(0, count).map((x) => {
    const w = weatherInfo(x.weatherCode.value, isNight(x.time, data.daily));
    return {
      time: x.time, hour: hourLabel(x.time), icon: w.icon, sky: w.label, temp: deg(x.temp.value),
      mm: isNum(x.precip.value) ? `${num1(x.precip.value)} mm` : "— mm", wet: isNum(x.precip.value) && x.precip.value > 0,
      pct: isNum(x.precipProb?.value) ? x.precipProb.value : null, prob: isNum(x.precipProb?.value) ? `${num0(x.precipProb.value)}\u00a0%` : "—\u00a0%",
      gust: isNum(x.gust.value) ? num0(x.gust.value) : "—", dir: isNum(x.windDir?.value) ? x.windDir.value : null,
      tempRed: isExtremeTemp(x.temp.value), gustRed: isExtremeGust(x.gust.value), sun: hourSun(x.time, data.daily),
    };
  });
}

// Vent (26/11/2026) : d'où il vient, en 8 directions (« vent d'est »). La girouette, elle, pointe vers où il va, nord en haut.
const FROM8 = ["du nord", "du nord-est", "d'est", "du sud-est", "du sud", "du sud-ouest", "d'ouest", "du nord-ouest"];
export const windFrom = (deg) => (isNum(deg) ? FROM8[Math.round((((deg % 360) + 360) % 360) / 45) % 8] : null);

// Lever ou coucher du soleil compris dans l'heure qui s'achève à `time` (même convention que la pluie : la colonne « 17 h » couvre
// 16 h → 17 h, donc un coucher à 16:48 y tombe). Heures locales du lieu, comparées comme textes « AAAA-MM-JJTHH:MM ».
// Nuit polaire et soleil de minuit (lever = coucher à 00:00, ou coucher le lendemain à 00:00) : pas d'événement.
export function hourSun(time, daily) {
  if (!time || !daily) return null;
  const prev = new Date(Date.parse(`${time}:00Z`) - 3600000).toISOString().slice(0, 16);
  for (const d of daily) { // tous les jours : hors du fuseau du lieu, un lever peut être rangé sous la date voisine (vérifié : Sydney vu depuis Paris)
    if (sunTimes(d.date, daily).polar) continue;
    for (const [kind, t] of [["rise", d.sunrise?.value], ["set", d.sunset?.value]]) if (t && t > prev && t <= time) return { kind, time: t.slice(11, 16) };
  }
  return null;
}

// Soleil de la carte du bas, selon l'heure de la prévision (date et heure locales) : avant le lever « à 08:05 » et « à 16:48 » ;
// dans la journée « depuis 08:05 » et « à 16:48 » ; après le coucher, prochain lever « demain 08:06 » (« à » s'il tombe le même jour) et « depuis 16:48 ».
// Heure absente = « — » sans mot ; nuit polaire / soleil de minuit en toutes lettres.
export function sunNow(data) {
  const now = data.current.time, today = now ? now.slice(0, 10) : data.daily[0]?.date, i = data.daily.findIndex((x) => x.date === today);
  if (i < 0) return null;
  const d = data.daily[i], sun = sunTimes(d.date, data.daily);
  if (sun.polar) return { polar: sun.polar };
  const r = d.sunrise?.value, s = d.sunset?.value, item = (word, time) => (time && time !== "—" ? { word, time } : { word: "", time: "—" });
  if (now && s && now >= s) { // prochain lever : le premier après maintenant (hors du fuseau du lieu, Open-Meteo le range parfois sous un autre jour : vérifié, Sydney vu de Paris)
    const next = data.daily.filter((x) => !sunTimes(x.date, data.daily).polar).map((x) => x.sunrise?.value).filter((t) => t && t > now).sort()[0];
    return { polar: null, rise: next ? item(next.slice(0, 10) > today ? "demain" : "à", next.slice(11, 16)) : item("", null), set: item("depuis", sun.set) };
  }
  return { polar: null, rise: item(now && r && now >= r ? "depuis" : "à", sun.rise), set: item("à", sun.set) };
}

// « Heures : Météo-France. Probabilité : ECMWF. Quarts d'heure : Météo-France. » (les 12 heures des 3 pages)
export function homeSources(data, steps) {
  const names = (ms) => [...new Set(ms.filter(Boolean).map(modelShort))].join(", ") || "modèle indisponible", hours = next24h(data).slice(0, HOME_HOURS * HOME_PAGES);
  return `Heures\u00a0: ${names(modelsOf(hours, ["weatherCode", "temp", "precip", "gust"]))}. Probabilité\u00a0: ${names(modelsOf(hours, ["precipProb"]))}. Quarts d'heure\u00a0: ${names(steps.map((s) => s.src?.mm))}.`;
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

// Girouette : flèche à empennage dessinée vers le sud, tournée de la direction d'où vient le vent (convention de la carte :
// la pointe va où va le vent ; nord en haut). Sans direction connue, rien n'est dessiné.
const VANE = "M12 3.5v17M12 20.5l-3.5-4.5M12 20.5l3.5-4.5M12 3.5l-3-2.5M12 6.5l-3-2.5M12 3.5l3-2.5M12 6.5l3-2.5";
function vane(dir, small = false) {
  if (!isNum(dir)) return null;
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg"), path = document.createElementNS(ns, "path");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", `vane${small ? " is-small" : ""}`); svg.setAttribute("focusable", "false");
  path.setAttribute("d", VANE); path.style.transform = `rotate(${Math.round(dir)}deg)`; svg.append(path);
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
const RED = () => said("Hors du commun : "); // le rouge ne se voit pas à l'oreille
const said = (text) => el("span", "sr-only", text); // lu par les lecteurs d'écran, à la place du dessin

// Haut de l'écran : la situation à l'instant T, à la position de l'appareil.
// Dessous : pression (bouton du baromètre) et vent (girouette, vitesse, rafales, d'où il vient).
export function buildHomeNow(data, pressureEl) {
  const c = data.current, info = weatherInfo(c.weatherCode, c.time ? isNight(c.time, data.daily) : false), from = windFrom(c.windDir);
  const out = document.createDocumentFragment();
  out.append(el("div", "home-now",
    hidden(el("span", "home-icon", info.icon)),
    el("span", `home-temp${isExtremeTemp(c.temp) ? " is-extreme" : ""}`, isExtremeTemp(c.temp) ? RED() : null, deg(c.temp)),
    el("div", "home-desc", el("strong", "", info.label), el("span", "", `Ressenti ${deg(c.apparent)}`))));
  const wind = el("div", "home-wind", vane(c.windDir),
    el("span", "", said("Vent : "), el("b", "", isNum(c.wind) ? `${num0(c.wind)}\u00a0km/h` : "—\u00a0km/h"), " ",
      el("small", isExtremeGust(c.gust) ? "is-extreme" : "", isExtremeGust(c.gust) ? RED() : null, "raf.\u00a0", isNum(c.gust) ? num0(c.gust) : "—"),
      el("br"), el("small", "", from ? `vent ${from}` : "direction —")));
  wind.title = "Vent actuel : vitesse, rafales et direction d'où il vient (la flèche pointe vers où il va, nord en haut)";
  out.append(el("div", "home-chips", pressureEl, wind));
  return out;
}

// Carte du bas : lever et coucher, précédés de « à », « depuis » ou « demain » (sunNow).
function sunBand(data) {
  const sun = sunNow(data);
  if (!sun) return null;
  const part = (kind, word, x) => el("span", `sun sun-${kind}`, said(`${word} : `), x.word ? el("span", "home-sun-w", x.word) : null, x.time);
  return el("section", "home-zone home-today",
    el("div", "home-tm-row", ...(sun.polar ? [el("span", "home-tm-val", sun.polar)]
      : [part("rise", "Lever du soleil", sun.rise), part("set", "Coucher du soleil", sun.set)])));
}

// Pastille de la colonne où tombe le lever (fond jaune paille) ou le coucher (fond bleu ciel), à la place de l'heure de la colonne ; sans icône (27/11/2026).
function sunPill(sun, hour) {
  const word = sun.kind === "rise" ? "Lever" : "Coucher", p = el("span", `home-h-hour home-sun-pill is-${sun.kind}`, said(`${hour}, `), said(`${word} du soleil à `), sun.time);
  p.title = `${word} du soleil à ${sun.time}`;
  return p;
}

// L'heure en tête de colonne, bouton souligné d'un trait fin (27/11/2026) : même action que dans la vue 🥾, « Balade ? » pour un départ
// à cette heure-là ; la toute première colonne (heure en cours) = « Dans l'heure ». Le clic est traité dans app.js (data-time, data-now).
function hourBtn(x, first) {
  const label = first ? "Départ maintenant" : `Départ à ${x.hour}`;
  const b = el("button", "home-h-walk", x.sun ? sunPill(x.sun, x.hour) : el("span", "home-h-hour", x.hour));
  b.type = "button"; b.dataset.time = x.time; if (first) b.dataset.now = "1";
  b.title = `Balade ? ${label}${x.sun ? ` (${x.sun.kind === "rise" ? "lever" : "coucher"} du soleil à ${x.sun.time})` : ""}`;
  b.setAttribute("aria-label", `${x.hour} : balade ? ${label.toLowerCase()}${x.sun ? `, ${x.sun.kind === "rise" ? "lever" : "coucher"} du soleil à ${x.sun.time}` : ""}`);
  return b;
}
// Une heure du tableau (colonne).
const hourCol = (x, first) => el("div", "home-hour",
  hourBtn(x, first), hidden(el("span", "home-h-icon", x.icon)), el("span", "sr-only", x.sky), el("span", `home-h-temp${x.tempRed ? " is-extreme" : ""}`, x.tempRed ? RED() : null, x.temp),
  el("span", `home-h-mm${x.wet ? " is-wet" : ""}`, x.mm),
  el("span", "home-h-prob", said("Probabilité de pluie : "), x.prob), probBar(x.pct), el("span", `home-h-gust${x.gustRed ? " is-extreme" : ""}`, vane(x.dir, true), x.dir === null ? null : said(`vent ${windFrom(x.dir)}, `), x.gustRed ? RED() : null, "raf. ", x.gust));
// Chevron < ou > au bord de la tuile des heures (dessin, pas un caractère) : simple repère, pas un bouton
// (27/11/2026, demandé : pas de conflit avec le toucher des heures).
function chevron(dir) {
  const b = hidden(el("span", `home-chev is-${dir}`));
  b.dataset.dir = dir;
  b.innerHTML = `<svg viewBox="0 0 10 18" aria-hidden="true" focusable="false"><path d="${dir === "prev" ? "M8 2 2 9l6 7" : "M2 2l6 7-6 7"}"/></svg>`;
  return b;
}
const pageMark = (page, pages) => el("span", "home-page-n", said("Page "), `${page + 1}/${pages}`);
// Pages côte à côte dans une piste ; seule la page affichée est lisible et atteignable (les autres sont inertes).
function pager(pages, page) {
  const slide = el("div", "home-slide", ...pages.map((p, n) => { const box = el("div", "home-page", ...p); if (n !== page) box.inert = true; return box; }));
  slide.style.width = `${pages.length * 100}%`;
  slide.style.transform = `translateX(${(-page * 100) / pages.length}%)`;
  return el("div", "home-pager", slide);
}

// Zones : avertissements s'il y en a, pluie, heures (3 pages de 4 heures qui glissent ensemble), soleil du jour.
// steps : undefined = en cours de lecture, null = illisibles. page : page affichée (0 à 2).
export function buildHome({ data, steps, alerts, fmtTime, page = 0 }) {
  const hours = homeHours(data, HOME_HOURS * HOME_PAGES), out = document.createDocumentFragment();
  const pages = Math.max(1, Math.min(HOME_PAGES, Math.ceil(hours.length / HOME_HOURS)));
  page = Math.max(0, Math.min(pages - 1, page));
  if (alerts.length) out.append(el("section", "home-zone home-alerts", ...alerts.map((t) => el("p", "", t))));
  const rainPage = (n) => {
    const st = steps ? steps.slice(n * HOME_STEPS, (n + 1) * HOME_STEPS) : steps;
    const phrase = st ? rainPhrase(st, fmtTime, n === 0 ? data.current.weatherCode : null, homeRisk(data, n)) : { tone: "unknown", title: st === undefined ? "Lecture de la pluie…" : "Pluie par quart d'heure indisponible", detail: st === undefined ? "Par quart d'heure, sur 4 heures." : "Les heures ci-dessous restent valables." };
    return [el("h2", `is-${phrase.tone}`, phrase.title), el("p", "", phrase.detail),
      st === null ? null : barsCaption(st), st === null ? null : st ? bars(st, fmtTime) : el("div", "home-bars is-wait")]; // pendant la lecture, la place est gardée : rien ne saute
  };
  const range = Array.from({ length: pages }, (_, n) => n);
  // Numéro de page en haut à droite de la tuile de pluie (27/11/2026, demandé) ; il ne glisse pas, il change au calage.
  const rain = pager(range.map(rainPage), page);
  if (pages > 1) rain.append(pageMark(page, pages)); // dans la fenêtre des pages (coin haut droit du contenu, quels que soient les retraits de la tuile)
  out.append(el("section", "home-zone home-rain home-swipe", rain));
  if (hours.length) {
    const zone = el("section", "home-zone home-hours home-swipe", pager(range.map((n) => [el("div", "home-hgrid", ...hours.slice(n * HOME_HOURS, (n + 1) * HOME_HOURS).map((x, i) => hourCol(x, n === 0 && i === 0)))]), page));
    if (pages > 1) { const prev = chevron("prev"), next = chevron("next"); prev.hidden = page === 0; next.hidden = page === pages - 1; zone.append(prev, next); }
    out.append(zone);
  } else out.append(el("p", "home-zone muted", "Données horaires indisponibles."));
  const band = sunBand(data);
  if (band) out.append(band);
  return out;
}

// Glissement (27/11/2026) : un seul numéro de page pour les deux tuiles. Pendant le geste, les deux pistes suivent le doigt ensemble ;
// au lâcher, elles se calent sur une page entière (swipeTarget). Trackpad : glisser à deux doigts. onPage(n) : page affichée.
export function wireHomePages(root, page, onPage) {
  const slides = [...root.querySelectorAll(".home-slide")], boxes = slides.map((s) => s.parentElement);
  const pages = slides[0]?.children.length ?? 1;
  if (pages < 2) return;
  let cur = page, drag = null, wheelSum = 0, wheelLock = 0, dragEnd = 0;
  const place = (frac, snap) => slides.forEach((s) => { s.classList.toggle("is-snapping", snap); s.style.transform = `translateX(${(-(cur + frac) * 100) / pages}%)`; });
  const go = (n) => {
    cur = Math.max(0, Math.min(pages - 1, n)); place(0, true);
    slides.forEach((s) => [...s.children].forEach((p, i) => { p.inert = i !== cur; }));
    root.querySelectorAll(".home-chev").forEach((b) => { b.hidden = b.dataset.dir === "prev" ? cur === 0 : cur === pages - 1; });
    root.querySelector(".home-page-n")?.replaceWith(pageMark(cur, pages));
    onPage(cur);
  };
  boxes.forEach((b) => {
    b.addEventListener("pointerdown", (e) => { if (e.button) return; drag = { x: e.clientX, y: e.clientY, w: b.clientWidth, t: performance.now(), dx: 0, on: false, id: e.pointerId }; });
    b.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag.dx = e.clientX - drag.x;
      if (!drag.on) {
        if (Math.abs(e.clientY - drag.y) > 10 && Math.abs(e.clientY - drag.y) > Math.abs(drag.dx)) { drag = null; return; } // geste vertical : pas un glissement
        if (Math.abs(drag.dx) <= 6) return;
        drag.on = true; b.setPointerCapture(e.pointerId);
      }
      let f = -drag.dx / drag.w;
      if (cur + f < 0 || cur + f > pages - 1) f *= 0.3; // résistance aux deux bouts
      place(f, false);
    });
    const end = () => {
      if (!drag) return;
      const { dx, w, t, on } = drag; drag = null;
      if (on) { dragEnd = performance.now(); go(swipeTarget(cur, dx, w, performance.now() - t, pages)); }
    };
    b.addEventListener("pointerup", end); b.addEventListener("pointercancel", end);
    b.addEventListener("click", (e) => { if (performance.now() - dragEnd < 400) { e.stopPropagation(); e.preventDefault(); } }, true); // un glissement n'ouvre pas « Balade ? »
    b.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      if (performance.now() < wheelLock) return;
      wheelSum += e.deltaX;
      if (Math.abs(wheelSum) > 40) { go(cur + Math.sign(wheelSum)); wheelSum = 0; wheelLock = performance.now() + 600; }
    }, { passive: false });
  });
  // Chevrons à la hauteur de la ligne des heures (mesurée : elle dépend des paliers d'écran ; 27/11/2026, demandé, avant : température).
  const zone = root.querySelector(".home-hours.home-swipe"), ref = zone?.querySelector(".home-page:not([inert]) .home-h-hour");
  if (ref) zone.style.setProperty("--chev-y", `${ref.getBoundingClientRect().top + ref.offsetHeight / 2 - zone.getBoundingClientRect().top}px`);
}

// Fenêtre « i » : légende technique. Rubriques { title, note, rows: [{ sym, text, sub }] } (sym : clé de SYMBOLS), puis notes [sujet, texte] de l'accordéon.
export function homeLegend(data, steps) {
  const time = data?.current?.time?.slice(11, 16), full = `${num2(MINI_MM_FULL / 4)}\u00a0mm`;
  return {
    sections: [
      { title: "Situation actuelle", note: `valeurs de modèle${time ? `, ${time}` : ""}`, rows: [
        { sym: "temp", text: "Température de l'air et ressenti, à votre position" },
        { sym: "baro", text: "Pression au niveau de la mer, station la plus proche", sub: "«\u00a0≈\u00a0»\u00a0: valeur de modèle. Ouvre le baromètre." },
        { sym: "trend", text: "Tendance sur 3\u00a0h environ\u00a0: hausse, stabilité, baisse" },
        { sym: "wind", text: "Vent actuel\u00a0: vitesse, rafales, direction d'où il vient", sub: "Girouette\u00a0: pointe vers où va le vent, nord en haut. Petite girouette des heures\u00a0: direction à l'heure dite." } ] },
      { title: "Pluie par quart d'heure", note: "12 heures, 4 par page, en mm", rows: [
        { sym: "bars", text: `Échelle fixe\u00a0: barre pleine = ${full}, soit ${MINI_MM_FULL}\u00a0mm/h`, sub: "Grise\u00a0: 0\u00a0mm. Rouge\u00a0: échelle dépassée. «\u00a0—\u00a0»\u00a0: donnée absente." },
        { sym: "risk", text: `«\u00a0Sec, mais pluie possible\u00a0»\u00a0: cumul prévu nul, probabilité d'au moins ${RISK_PCT}\u00a0% dans l'une des 4\u00a0heures de la page` }] },
      { title: "Prévision horaire", note: "12 prochaines heures, 4 par page", rows: [
        { sym: "swipe", text: "Glisser la pluie ou les heures vers la gauche\u00a0: 4 heures suivantes (3 pages)", sub: "Les deux tuiles glissent ensemble. Chevrons\u00a0: il y a une page de ce côté. «\u00a01/3\u00a0», en haut à droite de la pluie\u00a0: numéro de la page." },
        { sym: "hour", text: "Température et ciel à 16\u00a0h\u00a0; précipitations et rafales de 15\u00a0h à\u00a016\u00a0h", sub: "Heure soulignée\u00a0: la toucher ouvre «\u00a0Balade\u00a0?\u00a0» pour un départ à cette heure-là (première colonne\u00a0: dans l'heure)." },
        { sym: "mm", text: "Cumul de précipitations" },
        { sym: "prob", text: "Probabilité de précipitations", sub: "Seuil\u00a0: plus de 0,1\u00a0mm dans l'heure" },
        { sym: "gust", text: "Rafale maximale, en km/h" },
        { sym: "sun", text: "Heure du lever (fond jaune paille) ou du coucher du soleil (fond bleu ciel), à la place de l'heure de la colonne", sub: "Seulement s'il tombe dans les heures affichées\u00a0: un coucher à 16:48 va dans la colonne «\u00a017\u00a0h\u00a0» (de 16\u00a0h à 17\u00a0h)." }] },
      { title: "Soleil", rows: [
        { sym: "sunday", text: "Lever et coucher du soleil", sub: "«\u00a0à\u00a0»\u00a0: à venir\u00a0; «\u00a0depuis\u00a0»\u00a0: déjà passé\u00a0; après le coucher, lever de «\u00a0demain\u00a0». Mis à jour à chaque actualisation de l'écran." }] },
      { title: "Boutons", rows: [
        { sym: "map", text: "Carte plein écran", sub: "Point bleu\u00a0: position\u00a0; disque\u00a0: précision. «\u00a0Nuages\u00a0» et «\u00a0Pluie\u00a0»\u00a0: valeurs de modèles à l'instant ou heure par heure (réglette), interpolées. Cible\u00a0: recentrer. Montagne\u00a0: fond relief (OpenTopoMap). Manche à air\u00a0: stations d'aéroport (pression mesurée, éclair si orage observé ; toucher une station : son dernier relevé décodé). Radar\u00a0: pluie observée des 2 dernières heures (RainViewer)." }] },
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
  hour: () => { const s = text("16\u00a0h"); s.classList.add("is-walk"); return s; }, mm: () => text("1,1\u00a0mm"), gust: () => text("raf.\u00a035"),
  prob: () => { const s = text("88\u00a0%"); s.append(probBar(88)); return s; },
  sun: () => { const s = draw(sunPill({ kind: "rise", time: "08:05" }, "9\u00a0h"), sunPill({ kind: "set", time: "16:48" }, "17\u00a0h")); s.classList.add("is-stack"); return s; },
  baro: () => { const s = draw(); s.innerHTML = '<svg class="mini-svg hl-baro" viewBox="0 0 24 24" focusable="false"><use href="#ico-baro"/></svg>'; return s; },
  trend: () => draw(trendSign("up"), trendSign("steady"), trendSign("down")),
  wind: () => draw(vane(250)),
  swipe: () => { const s = draw(); s.innerHTML = '<svg class="hl-chev" viewBox="0 0 10 18" focusable="false"><path d="M8 2 2 9l6 7"/></svg><svg class="hl-chev" viewBox="0 0 10 18" focusable="false"><path d="M2 2l6 7-6 7"/></svg>'; return s; },
  sunday: () => draw(el("span", "sun sun-rise"), el("span", "sun sun-set")),
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
