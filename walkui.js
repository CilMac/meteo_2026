// Fenêtre « Balade dans l'heure ? » : lit la pluie, la neige et le contexte à 15 minutes à la position de l'appareil (walk.js) et affiche
// le verdict, avec un sélecteur pour avancer le départ d'heure en heure. Tout le texte est écrit par textContent.
import { fetchNextHour, walkAdvice, hourlyAt, mmPerHour, MODERATE_MMH, MAX_OFFSET_H, WalkError } from "./walk.js";

const ICON = { go: "🚶", caution: "⚠️", short: "⏳", light: "🌂", wait: "⏸️", shower: "🌦️", mixed: "🌧️", no: "☔", storm: "⛈️", ice: "🧊", unknown: "❓" };
const CACHE_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const nf1 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

// Petite frise : un bâton par pas de 15 minutes (hauteur = mm/h, pleine à 4 mm/h, rouge si plus), avec l'heure de fin du pas.
function timeline(steps, fmtTime) {
  const wrap = el("div", "walk-tl");
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", `Pluie par pas de 15 minutes : ${steps.map((s) => `${fmtTime(s.t)} ${nf1.format(mmPerHour(s.mm))} mm/h`).join(", ")}`);
  for (const s of steps) {
    const mmh = mmPerHour(s.mm), over = mmh > MODERATE_MMH;
    const col = el("div", "walk-col");
    const box = el("div", "walk-bar-box");
    const bar = el("div", `walk-bar${over ? " is-over" : ""}`);
    bar.style.height = `${mmh > 0 ? Math.max(4, Math.min(100, (mmh / MODERATE_MMH) * 100)) : 0}%`;
    box.append(bar);
    col.append(box, el("div", "walk-val", `${nf1.format(mmh)}`), el("div", "walk-time", fmtTime(s.t)));
    wrap.append(col);
  }
  return wrap;
}

export function initWalk({ openBtn, getHere, fmtTime }) {
  const $ = (id) => {
    const e = document.getElementById(id);
    if (!e) throw new Error(`élément « #${id} » introuvable : les fichiers du site ne sont pas tous de la même version (republiez-les tous, puis rechargez avec Cmd+Maj+R)`);
    return e;
  };
  const dlg = $("walk"), body = $("walk-body"), prev = $("walk-prev"), next = $("walk-next"), when = $("walk-when");
  // Départ : « maintenant + offset heures », ou une heure fixe (anchor, ms) choisie en touchant une heure de « Lieu actuel ».
  let cache = null, seq = 0, offset = 0, anchor = null;
  const startMs = () => anchor ?? Date.now() + offset * HOUR_MS;
  const latestMs = () => Date.now() + MAX_OFFSET_H * HOUR_MS;

  function syncStepper(start) {
    const isNow = anchor === null && offset === 0;
    prev.disabled = isNow; next.disabled = start + HOUR_MS > latestMs() + 60000; // une minute de marge : la dernière heure du tableau reste atteignable
    when.textContent = isNow ? "Dans l'heure" : anchor !== null ? fmtTime(start) : `+${offset} h`;
    when.title = isNow ? "Départ maintenant" : `Départ à ${fmtTime(start)}`;
  }

  function render(advice, at) {
    const snowy = advice.kind === "snow";
    const verdict = el("div", `walk-verdict is-${advice.level}`);
    verdict.append(el("div", "walk-ico", ICON[advice.level] ?? "❓"));
    const txt = el("div", "walk-txt");
    txt.append(el("h3", "walk-title", advice.title), el("p", "walk-text", advice.text));
    verdict.append(txt);
    const kids = [verdict];
    if (advice.steps.length >= 3 && advice.level !== "unknown") {
      kids.push(el("p", "walk-sub", `Précipitations prévues (mm d'eau par heure${snowy ? ", la neige est comptée en eau" : ""}), pas de 15 minutes, heure de fin de chaque pas :`), timeline(advice.steps, fmtTime));
    }
    if (advice.remarks?.length) {
      const ul = el("ul", "walk-remarks");
      for (const r of advice.remarks) { const li = el("li", `is-${r.sev}`); li.append(el("span", "walk-r-ico", r.icon), el("span", "", r.text)); ul.append(li); }
      kids.push(el("h4", "walk-h", "À savoir"), ul);
    }
    if (advice.facts.length) { const ul = el("ul", "walk-facts"); advice.facts.forEach((f) => ul.append(el("li", "", f))); kids.push(ul); }
    kids.push(el("p", "muted small walk-note", `Calculé à ${fmtTime(at)} avec les valeurs des modèles d'Open-Meteo (pas un radar), pour votre position arrondie à 1 km. Selon la région, les valeurs à 15 minutes sont interpolées à partir de valeurs horaires. Un aperçu à prendre avec prudence : une averse locale peut échapper aux modèles, et plus le départ est lointain, moins la prévision est sûre.`));
    body.replaceChildren(...kids);
  }

  // Affiche le verdict de l'heure qui commence à « maintenant + offset heures », à partir des données en mémoire.
  function show() {
    const start = startMs();
    syncStepper(start);
    const ctx = { ...hourlyAt(cache.hourly, start), depart: anchor !== null || offset > 0 ? fmtTime(start) : null };
    render(walkAdvice(cache.rows, ctx, start), cache.at);
  }

  async function load() {
    const here = getHere();
    if (!here) { body.replaceChildren(el("p", "walk-msg is-err", "Position indisponible : ouvrez d'abord « Lieu actuel » et attendez la position.")); return; }
    const key = `${here.lat.toFixed(2)},${here.lon.toFixed(2)}`;
    if (cache && Date.now() - cache.at < CACHE_MS && cache.key === key) { show(); return; }
    const id = ++seq;
    syncStepper(startMs());
    body.replaceChildren(el("p", "walk-msg", "Lecture des prévisions à 15 minutes…"));
    try {
      const now = Date.now();
      const { rows, hourly } = await fetchNextHour(here, { now });
      if (id !== seq || !dlg.open) return;
      cache = { at: now, key, rows, hourly };
      show();
    } catch (e) {
      if (id !== seq) return;
      body.replaceChildren(el("p", "walk-msg is-err", `Prévisions à 15 minutes indisponibles : ${e instanceof WalkError ? e.message : "erreur inattendue"}. Réessayez dans un moment.`));
    }
  }

  const step = (d) => {
    if (anchor === null) offset = Math.min(MAX_OFFSET_H, Math.max(0, offset + d));
    else {
      const t = anchor + d * HOUR_MS;
      if (t <= Date.now()) { anchor = null; offset = 0; } // l'heure est déjà commencée : on part « maintenant »
      else if (t <= latestMs() + 60000) anchor = t;
    }
    load();
  };
  prev.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  let returnFocus = openBtn;
  const open = (at, from) => {
    anchor = Number.isFinite(at) && at > Date.now() ? Math.min(at, latestMs()) : null; offset = 0;
    returnFocus = from ?? openBtn;
    dlg.showModal(); load();
  };
  openBtn.addEventListener("click", () => open(null, openBtn)); // on repart toujours de « maintenant »
  $("walk-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => { seq++; (returnFocus?.isConnected ? returnFocus : openBtn).focus(); });
  // Comme les autres fenêtres : seul un clic dont la cible est le dialogue lui-même, hors de son cadre, le ferme.
  dlg.addEventListener("click", (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  });
  // Ouvre la fenêtre pour un départ à l'instant `at` (ms) ; passé ou déjà commencé : « Dans l'heure ».
  return { openAt: (at, from) => open(at, from) };
}
