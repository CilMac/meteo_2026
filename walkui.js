// Fenêtre « Balade dans l'heure ? » : lit la pluie, la neige et le contexte à 15 minutes à la position de l'appareil (walk.js) et affiche
// le verdict, avec un sélecteur pour avancer le départ d'heure en heure. Tout le texte est écrit par textContent.
import { fetchNextHour, walkAdvice, walkSources, hourlyAt, mmPerHour, MAX_OFFSET_H, STEP_MS, SNOW_CM_PER_MM, WalkError } from "./walk.js?v=68874bb7";
import { stormText } from "./observation.js?v=25a46dff";
import { modelShort } from "./weather-provider.js?v=631084d1";
import { MINI_MM_FULL } from "./weather-render.js?v=6d68c32f";

// Échelle de la frise : la même que la barre de pluie du tableau « Lieu actuel » (pleine à 3 mm dans l'heure),
// soit 0,75 mm par quart d'heure ; au-delà, bâton plein et rouge (choix de l'utilisateur, 22/11/2026).
const FULL_MMH = MINI_MM_FULL;

const ICON = { go: "🚶", caution: "⚠️", short: "⏳", light: "🌂", wait: "⏸️", shower: "🌦️", mixed: "🌧️", no: "☔", storm: "⛈️", ice: "🧊", unknown: "❓" };
const CACHE_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const nf1 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

// Petite frise : un bâton par quart d'heure (hauteur proportionnelle aux mm, plein à 0,75 mm, soit 3 mm/h comme le tableau ; rouge au-delà), le chiffre = mm
// tombés pendant ce quart d'heure (ils s'additionnent : cumul de la fenêtre, lignes du tableau) ; dessous, un axe avec les heures
// placées ENTRE les bâtons : chaque bâton est visiblement compris entre son heure de début et son heure de fin.
function timeline(steps, fmtTime) {
  const n = steps.length;
  const bounds = [steps[0].t - STEP_MS, ...steps.map((s) => s.t)]; // n + 1 limites
  const wrap = el("div", "walk-tl");
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", `Pluie prévue par quart d'heure : ${steps.map((s, i) => `de ${fmtTime(bounds[i])} à ${fmtTime(s.t)}, ${nf1.format(s.mm)} mm`).join(" ; ")}`);
  const cols = el("div", "walk-cols");
  cols.style.setProperty("--n", String(n));
  steps.forEach((s, i) => {
    const mmh = mmPerHour(s.mm), over = mmh > FULL_MMH;
    const col = el("div", "walk-col");
    const box = el("div", "walk-bar-box");
    const bar = el("div", `walk-bar${over ? " is-over" : ""}`);
    bar.style.height = `${mmh > 0 ? Math.max(4, Math.min(100, (mmh / FULL_MMH) * 100)) : 0}%`;
    box.append(bar);
    col.title = `De ${fmtTime(bounds[i])} à ${fmtTime(s.t)} : ${nf1.format(s.mm)} mm`;
    col.append(box, el("div", "walk-val", nf1.format(s.mm)));
    cols.append(col);
  });
  const axis = el("div", "walk-axis");
  axis.setAttribute("aria-hidden", "true");
  bounds.forEach((t, i) => {
    const tick = el("span", "walk-tick", fmtTime(t));
    tick.style.left = `${(i / n) * 100}%`;
    axis.append(tick);
  });
  wrap.append(cols, axis);
  return wrap;
}

// Ouverture : seulement par openAt (toucher une heure du tableau de la vue 🥾) ; le bouton parapluie a été retiré le 23/11/2026.
export function initWalk({ getHere, fmtTime, getStorms = () => null, fallbackFocus = () => null }) {
  const $ = (id) => {
    const e = document.getElementById(id);
    if (!e) throw new Error(`élément « #${id} » introuvable : les fichiers du site ne sont pas tous de la même version (republiez-les tous, puis rechargez avec Cmd+Maj+R)`);
    return e;
  };
  const dlg = $("walk"), body = $("walk-body"), prev = $("walk-prev"), next = $("walk-next"), when = $("walk-when");
  // Départ : « maintenant + offset heures », ou une heure fixe (anchor, ms) choisie en touchant une heure de « Lieu actuel ».
  let cache = null, seq = 0, offset = 0, anchor = null, tlHelpOpen = false, moreOpen = false, stormHelpOpen = false; // l'explication de la frise reste ouverte d'un départ à l'autre
  const startMs = () => anchor ?? Date.now() + offset * HOUR_MS;
  const latestMs = () => Date.now() + MAX_OFFSET_H * HOUR_MS;

  function syncStepper(start) {
    const isNow = anchor === null && offset === 0;
    prev.disabled = isNow; next.disabled = start + HOUR_MS > latestMs() + 60000; // une minute de marge : la dernière heure du tableau reste atteignable
    when.textContent = isNow ? "Dans l'heure" : anchor !== null ? fmtTime(start) : `+${offset} h`;
    when.title = isNow ? "Départ maintenant" : `Départ à ${fmtTime(start)}`;
  }

  // Alerte orage : « i » à côté du titre, qui ouvre une explication sur sa fiabilité. Aucun taux inventé : il n'a pas été mesuré.
  function stormHelp(storm, title) {
    const info = el("button", "mini-info-btn walk-info-btn walk-storm-btn", "i");
    Object.assign(info, { type: "button", title: "Fiabilité de l'alerte orage" });
    info.setAttribute("aria-label", "Fiabilité de l'alerte orage");
    info.setAttribute("aria-controls", "walk-storm-help");
    info.setAttribute("aria-expanded", String(stormHelpOpen));
    title.append(" ", info);
    const help = el("ul", "compact-help walk-storm-help");
    help.id = "walk-storm-help";
    help.hidden = !stormHelpOpen;
    // « vient du choix automatique… », « vient d'ECMWF », « vient de Météo-France » (contraction et élision)
    const fromWho = (x) => (x === "best_match" ? "du choix automatique d'Open-Meteo" : /^[aeiouyéèêAEIOUYÉ]/.test(modelShort(x)) ? `d'${modelShort(x)}` : `de ${modelShort(x)}`);
    const who = storm.by.length ? storm.by.map(fromWho).join(" et ") : "des modèles";
    [
      "Les orages se prévoient mal à l'heure près et au kilomètre près : un modèle peut en annoncer un qui éclate à 20 km, ou en manquer un.",
      `Ici, l'alerte vient ${who}.${storm.onlyOther ? ` Le modèle principal (${modelShort(storm.main)}) n'en prévoit pas : l'alerte est plus incertaine, mais elle est donnée par prudence.` : ""}`,
      "JMA (Japon) et GEM (Canada) ne prévoient jamais d'orage, ECMWF presque jamais : l'appli consulte donc aussi le choix automatique d'Open-Meteo, au prix de quelques fausses alertes.",
      "Taux de fiabilité : non mesuré. Pas de chiffre plutôt qu'un chiffre inventé.",
      "En pratique : ciel qui noircit, tonnerre au loin → mettez-vous à l'abri, quelle que soit la prévision.",
    ].forEach((t) => help.append(el("li", "", t)));
    info.addEventListener("click", () => { stormHelpOpen = help.hidden; help.hidden = !stormHelpOpen; info.setAttribute("aria-expanded", String(stormHelpOpen)); });
    return help;
  }

  function render(advice, at, sources) {
    const snowy = advice.kind === "snow";
    const verdict = el("div", `walk-verdict is-${advice.level}`);
    verdict.append(el("div", "walk-ico", ICON[advice.level] ?? "❓"));
    const txt = el("div", "walk-txt");
    const title = el("h3", "walk-title", advice.title);
    txt.append(title, el("p", "walk-text", advice.text));
    verdict.append(txt);
    const kids = [verdict];
    if (advice.storm) kids.push(stormHelp(advice.storm, title)); // « i » du titre : fiabilité de l'alerte orage
    const observed = stormText(getStorms(), fmtTime); // orage OBSERVÉ par une station d'aéroport proche, en ce moment
    if (observed) kids.push(el("p", "walk-obs-storm", `${observed} C'est une observation, pas une prévision.`));
    if (advice.steps.length >= 3 && advice.level !== "unknown") {
      // légende + « i » à droite : explication courte de la frise, ouverte ou fermée d'un toucher
      const head = el("div", "walk-sub-row");
      const info = el("button", "mini-info-btn walk-info-btn", "i");
      Object.assign(info, { type: "button", title: "Comment lire cette frise ?" });
      info.setAttribute("aria-label", "Comment lire cette frise ?");
      info.setAttribute("aria-controls", "walk-tl-help");
      info.setAttribute("aria-expanded", String(tlHelpOpen));
      head.append(el("p", "walk-sub", snowy ? "Précipitations prévues, en mm d'eau par quart d'heure :" : "Pluie prévue, en mm par quart d'heure :"), info);
      const help = el("ul", "compact-help walk-tl-help");
      help.id = "walk-tl-help";
      help.hidden = !tlHelpOpen;
      const lines = [
        "Un bâton = un quart d'heure, entre les deux heures de l'axe.",
        "Le chiffre = les mm d'eau tombés pendant ce quart d'heure : additionnés, ils donnent le cumul.",
        `Bâton plein = ${nf2.format(FULL_MMH / 4)} mm en 15 min (${FULL_MMH} mm/h, même échelle que le tableau) ; rouge = davantage.`,
      ];
      if (snowy) lines.push(`Neige comptée en eau : 1 mm d'eau ≈ ${nf1.format(SNOW_CM_PER_MM)} cm de neige.`);
      lines.forEach((t) => help.append(el("li", "", t)));
      info.addEventListener("click", () => { tlHelpOpen = help.hidden; help.hidden = !tlHelpOpen; info.setAttribute("aria-expanded", String(tlHelpOpen)); });
      kids.push(head, help, timeline(advice.steps, fmtTime));
    }
    if (advice.remarks?.length) {
      const ul = el("ul", "walk-remarks");
      for (const r of advice.remarks) { const li = el("li", `is-${r.sev}`); li.append(el("span", "walk-r-ico", r.icon), el("span", "", r.text)); ul.append(li); }
      kids.push(el("h4", "walk-h", "À savoir"), ul);
    }
    if (advice.facts.length) { const ul = el("ul", "walk-facts"); advice.facts.forEach((f) => ul.append(el("li", "", f))); kids.push(ul); }
    // Modèles et précautions : repliés (demande de l'utilisateur, 22/11/2026) ; l'état ouvert/fermé est gardé d'un départ à l'autre
    const more = el("details", "howto walk-more");
    more.open = moreOpen;
    more.addEventListener("toggle", () => { moreOpen = more.open; });
    more.append(el("summary", "", "Modèles et précautions"));
    if (sources) more.append(el("p", "small walk-sources", sources));
    more.append(el("p", "muted small walk-note", `Calculé à ${fmtTime(at)} avec les valeurs des modèles d'Open-Meteo (pas un radar), choisies valeur par valeur dans le même ordre que pour le tableau (modèles ci-dessus), pour votre position arrondie à 1 km. Selon la région, les valeurs à 15 minutes sont interpolées à partir de valeurs horaires. Un aperçu à prendre avec prudence : une averse locale peut échapper aux modèles, et plus le départ est lointain, moins la prévision est sûre.`));
    kids.push(more);
    body.replaceChildren(...kids);
  }

  // Affiche le verdict de l'heure qui commence à « maintenant + offset heures », à partir des données en mémoire.
  function show() {
    const start = startMs();
    syncStepper(start);
    const at = hourlyAt(cache.hourly, start);
    const ctx = { ...at, depart: anchor !== null || offset > 0 ? fmtTime(start) : null };
    const advice = walkAdvice(cache.rows, ctx, start);
    // grandeurs de la probabilité / neige au sol / UV : citées seulement si la valeur sert (fait ou remarque)
    const used = { prob: at.prob !== null ? at.src.prob : null, depth: at.depth >= 0.01 ? at.src.depth : null, uv: at.uv >= 6 ? at.src.uv : null };
    render(advice, cache.at, advice.level === "unknown" ? null : walkSources(advice.steps, used));
  }

  async function load() {
    const here = getHere();
    if (!here) { body.replaceChildren(el("p", "walk-msg is-err", "Position indisponible : ouvrez d'abord la vue 🥾 et attendez la position.")); return; }
    const key = `${here.lat.toFixed(2)},${here.lon.toFixed(2)},${(here.models ?? []).join("+")}`;
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
  let returnFocus = null;
  const open = (at, from) => {
    anchor = Number.isFinite(at) && at > Date.now() ? Math.min(at, latestMs()) : null; offset = 0;
    returnFocus = from ?? null;
    dlg.showModal(); load();
  };
  $("walk-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => { seq++; (returnFocus?.isConnected ? returnFocus : fallbackFocus())?.focus(); }); // le curseur revient sur l'heure touchée
  // Comme les autres fenêtres : seul un clic dont la cible est le dialogue lui-même, hors de son cadre, le ferme.
  dlg.addEventListener("click", (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  });
  // Ouvre la fenêtre pour un départ à l'instant `at` (ms) ; passé ou déjà commencé : « Dans l'heure ».
  return { openAt: (at, from) => open(at, from) };
}
