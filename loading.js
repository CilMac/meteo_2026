// Petite fenêtre « chargement en cours » avec barre d'avancement. La barre ne mesure que ce qu'on sait vraiment :
// quelles étapes sont terminées (aucun pourcentage inventé pour une requête dont la durée est inconnue).

export const LOAD_STEPS = [
  { id: "forecast", label: "Prévisions", weight: 60 },
  { id: "ensemble", label: "Scénarios (J+4 à J+14)", weight: 25 },
  { id: "warnings", label: "Vigilance officielle", weight: 15 },
];
const DONE = new Set(["ok", "ko"]); // ko : étape terminée mais indisponible

// états : { forecast: "pending" | "waiting" | "ok" | "ko", … } → pourcentage 0–100 des étapes terminées
export function loadProgress(states) {
  const total = LOAD_STEPS.reduce((s, st) => s + st.weight, 0);
  const done = LOAD_STEPS.reduce((s, st) => s + (DONE.has(states[st.id]) ? st.weight : 0), 0);
  return Math.round((done / total) * 100);
}
export const allDone = (states) => LOAD_STEPS.every((st) => DONE.has(states[st.id]));

const STATE_TEXT = { waiting: "en attente", pending: "en cours…", ok: "prêt", ko: "indisponible" };
const STATE_ICON = { waiting: "○", pending: "◔", ok: "✓", ko: "✕" };

// root : l'élément #loader (voir index.html). La fenêtre n'apparaît qu'après `delayMs`, pour ne pas clignoter sur un chargement rapide.
export function createLoader(root, { delayMs = 400 } = {}) {
  const $ = (sel) => root.querySelector(sel);
  let states = {}, showTimer = null, tickTimer = null, startedAt = 0;

  function paint() {
    const pct = loadProgress(states);
    const bar = $(".loader-bar");
    bar.setAttribute("aria-valuenow", String(pct)); // valeur réelle
    $(".loader-fill").style.width = `${Math.max(pct, 8)}%`; // plancher visuel : la barre reste visible pendant la première requête
    const list = $(".loader-steps");
    list.replaceChildren(...LOAD_STEPS.map((st) => {
      const li = document.createElement("li");
      li.className = `loader-step is-${states[st.id]}`;
      const icon = document.createElement("span"); icon.className = "loader-icon"; icon.setAttribute("aria-hidden", "true"); icon.textContent = STATE_ICON[states[st.id]];
      li.append(icon, `${st.label} : ${STATE_TEXT[states[st.id]]}`);
      return li;
    }));
  }
  const tick = () => { $(".loader-time").textContent = `Depuis ${Math.max(0, Math.round((Date.now() - startedAt) / 1000))} s`; };
  function stop() { clearTimeout(showTimer); clearInterval(tickTimer); showTimer = tickTimer = null; root.hidden = true; }

  return {
    start(placeName) {
      stop();
      states = { forecast: "pending", ensemble: "waiting", warnings: "pending" };
      startedAt = Date.now();
      $(".loader-title").textContent = `Chargement de la météo : ${placeName}`;
      paint(); tick();
      showTimer = setTimeout(() => { root.hidden = false; tickTimer = setInterval(tick, 1000); }, delayMs);
    },
    begin(id) { if (states[id] === "waiting") { states[id] = "pending"; paint(); } },
    done(id, ok = true) {
      if (!(id in states)) return;
      states[id] = ok ? "ok" : "ko";
      paint();
      if (allDone(states)) stop();
    },
    // Échec de la prévision : l'erreur est affichée ailleurs, la fenêtre se ferme tout de suite.
    fail() { stop(); },
  };
}
