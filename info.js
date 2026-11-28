// Fenêtre d'information : <dialog> natif (focus, Échap, retour du focus), onglets accessibles (la date de dernière modification est écrite dans index.html par npm run version).
const $ = (id) => {
  const el = document.getElementById(id);
  // Un élément absent signale presque toujours des fichiers publiés de versions différentes (index.html ancien avec app.js récent, par exemple).
  if (!el) throw new Error(`élément « #${id} » introuvable : les fichiers du site ne sont pas tous de la même version (republiez-les tous, puis rechargez avec Cmd+Maj+R)`);
  return el;
};

// homeTab : afficher l'onglet « Accueil » (légende de l'écran d'accueil), seulement là où cet écran existe ;
// fillHome : remplit cet onglet (appelé à chaque fois qu'il est montré). Renvoie openHome(bouton) : ouvrir l'aide sur cet onglet.
export function initInfo({ homeTab = false, fillHome = () => {} } = {}) {
  const dlg = $("info"), openBtn = $("info-open"), homeT = $("m-tab-home");
  homeT.hidden = !homeTab;
  const tabs = [...dlg.querySelectorAll(".m-tab")].filter((t) => !t.hidden);
  let returnTo = openBtn; // le focus revient au bouton « i » qui a ouvert la fenêtre

  function selectTab(tab, focus = false) {
    if (tab === homeT) fillHome();
    for (const t of [...dlg.querySelectorAll(".m-tab")]) {
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
  // Les relevés de test (repliés en bas de « Sous le capot ») se referment à chaque ouverture.
  const open = (tab, from) => { returnTo = from; $("log-more").open = false; selectTab(tab); dlg.showModal(); };

  openBtn.addEventListener("click", () => open($("m-tab-how"), openBtn)); // page principale : « Mode d'emploi »
  $("info-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => returnTo.focus());
  // Clic sur le voile : fermeture. Seule la cible « le dialogue lui-même » compte : un bouton activé au clavier envoie
  // un clic de coordonnées (0, 0) qui ne doit surtout pas fermer la fenêtre.
  dlg.addEventListener("click", (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    if (outside) dlg.close();
  });
  return { openHome: (from) => { $("home-more").open = false; open(homeT, from); } }; // « Modèles et sources » toujours replié à l'ouverture
}
