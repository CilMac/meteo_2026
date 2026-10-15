// Fenêtre d'information : <dialog> natif (focus, Échap, retour du focus), deux onglets accessibles, date du jour.
const $ = (id) => document.getElementById(id);

export function initInfo() {
  const dlg = $("info"), openBtn = $("info-open");
  const tabs = [...dlg.querySelectorAll(".m-tab")];

  function selectTab(tab, focus = false) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute("aria-controls")).hidden = !on;
    }
    dlg.querySelector(".modal-body").scrollTop = 0;
    if (focus) tab.focus();
  }
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => selectTab(t));
    t.addEventListener("keydown", (e) => {
      const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
      if (next === null) return;
      e.preventDefault();
      selectTab(tabs[(next + tabs.length) % tabs.length], true);
    });
  });

  openBtn.addEventListener("click", () => {
    // Date du jour au moment de l'ouverture (heure locale de l'appareil).
    const now = new Date();
    const time = $("info-date");
    time.textContent = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(now);
    time.dateTime = now.toISOString().slice(0, 10);
    selectTab(tabs[0]);
    dlg.showModal();
  });
  initTheme(dlg);
  $("info-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => openBtn.focus()); // le focus revient toujours au bouton « i »
  // Clic sur le voile : fermeture. Seule la cible « le dialogue lui-même » compte : un bouton activé au clavier envoie
  // un clic de coordonnées (0, 0) qui ne doit surtout pas fermer la fenêtre.
  dlg.addEventListener("click", (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    if (outside) dlg.close();
  });
}

// Jour par défaut ; « Nuit » seulement si choisi. Le choix est mémorisé (localStorage dans un try/catch : il peut être indisponible).
const THEME_KEY = "meteo.theme";
function initTheme(dlg) {
  const buttons = [...dlg.querySelectorAll(".theme-btn")];
  const apply = (value) => {
    if (value === "dark") document.documentElement.dataset.theme = "dark";
    else delete document.documentElement.dataset.theme;
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.themeValue === (value === "dark" ? "dark" : "light")));
  };
  let stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch { /* stockage indisponible : on reste en mode jour */ }
  apply(stored === "dark" ? "dark" : "light");
  for (const b of buttons) {
    b.addEventListener("click", () => {
      apply(b.dataset.themeValue);
      try { localStorage.setItem(THEME_KEY, b.dataset.themeValue); } catch { /* ignoré */ }
    });
  }
}
