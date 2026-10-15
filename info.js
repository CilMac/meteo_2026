// Fenêtre d'information : <dialog> natif (focus, Échap, retour du focus), deux onglets accessibles, date du jour.
const $ = (id) => {
  const el = document.getElementById(id);
  // Un élément absent signale presque toujours des fichiers publiés de versions différentes (index.html ancien avec app.js récent, par exemple).
  if (!el) throw new Error(`élément « #${id} » introuvable : les fichiers du site ne sont pas tous de la même version (republiez-les tous, puis rechargez avec Cmd+Maj+R)`);
  return el;
};

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
