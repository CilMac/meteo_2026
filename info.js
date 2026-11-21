// Fenêtre d'information : <dialog> natif (focus, Échap, retour du focus), onglets accessibles, date de dernière modification du site.
const $ = (id) => {
  const el = document.getElementById(id);
  // Un élément absent signale presque toujours des fichiers publiés de versions différentes (index.html ancien avec app.js récent, par exemple).
  if (!el) throw new Error(`élément « #${id} » introuvable : les fichiers du site ne sont pas tous de la même version (republiez-les tous, puis rechargez avec Cmd+Maj+R)`);
  return el;
};

// Date de dernière modification : la plus récente des en-têtes « Last-Modified » de la page et des fichiers du site
// qu'elle a chargés (même origine). Sur GitHub Pages, tous les fichiers portent l'heure de la dernière publication.
export function latestModified(headers) {
  const ms = headers.map((x) => Date.parse(x ?? "")).filter(Number.isFinite);
  return ms.length ? new Date(Math.max(...ms)) : null;
}
export function siteFiles(pageUrl, resourceUrls) {
  const origin = new URL(pageUrl).origin;
  const files = [pageUrl.split("#")[0].split("?")[0], ...resourceUrls.filter((u) => {
    try { const x = new URL(u); return x.origin === origin && /\.(js|css|html)$/.test(x.pathname); } catch { return false; }
  })];
  return [...new Set(files)];
}
export const formatUpdated = (d) => new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" }).format(d); // « 21 novembre 2026 à 18:14 »
let updatedPromise = null;
function lastUpdate() {
  updatedPromise ??= (async () => {
    const urls = siteFiles(location.href, performance.getEntriesByType?.("resource").map((e) => e.name) ?? []);
    const heads = await Promise.all(urls.map((u) => fetch(u, { method: "HEAD", cache: "no-cache" }).then((r) => r.headers.get("last-modified")).catch(() => null)));
    return latestModified(heads);
  })();
  return updatedPromise;
}

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
    // Dernière modification du site, à l'heure de l'appareil ; inconnue (en-tête absent ou hors ligne) : « — ».
    const time = $("info-date");
    lastUpdate().then((d) => {
      time.textContent = d ? formatUpdated(d) : "—";
      if (d) time.dateTime = d.toISOString(); else time.removeAttribute("datetime");
    });
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
