// Commandes Leaflet des calques « Nuages » et « Pluie » : deux interrupteurs ON/OFF indépendants (26/11/2026), légende, et flèche du vent toujours affichée. Le calcul est dans weathermap.js.
// Tout le texte affiché est écrit par textContent ; seules des valeurs numériques calculées ici sont injectées dans les styles.
import { fetchSky, fetchHere, gridDims, skyImageUrl, windFromText, arrowAngle, cloudGradientCss, rainGradientCss, MAX_LAT, RAIN_STOPS, RAIN_MIN, isTap, isDoubleTap } from "./weathermap.js?v=7a40d11c";

const SKY_ZOOM = 8;      // à l'échelle d'un village, la grille des modèles n'a aucun sens : le calque s'ouvre sur une zone d'environ 200 km
const REFETCH_MS = 700;
const TIMELINE_HOURS = 12; // curseur de la carte plein écran : maintenant, puis les 12 heures suivantes (comme la vue des 12 heures)
const PLAY_MS = 1000;      // durée d'une heure pendant la lecture  // délai après un déplacement de la carte avant de relire la grille
const nf0 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const SVGNS = "http://www.w3.org/2000/svg";

function windArrow() {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 48 48"); svg.setAttribute("width", "44"); svg.setAttribute("height", "44"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
  svg.innerHTML = `<circle cx="24" cy="24" r="22" class="sky-dial"/><text x="24" y="9" text-anchor="middle" class="sky-n">N</text>
    <g class="sky-arrow"><path d="M24 12 L31 30 L24 26 L17 30 Z"/><path d="M24 26 L24 40" class="sky-tail"/></g>`; // contenu statique, sans donnée externe
  return svg;
}

// getHere() → {lat, lon} de l'appareil ; fmtTime(ms) → « 16:15 » dans le fuseau du lieu.
// show : calques allumés au départ ({ clouds, rain }) ; onShow(show) : appelé à chaque changement (pour le retenir).
// timeline : curseur « Maintenant · +1 h … +12 h » et lecture ▶ sous la carte (carte plein écran seulement), même appel enrichi.
export function createSkyLayer(L, map, { getHere, fmtTime, show: start = { clouds: false, rain: false }, onShow = () => {}, timeline = false }) {
  const pane = map.createPane("skypane");
  pane.style.zIndex = 250; pane.style.pointerEvents = "none"; // au-dessus des tuiles, sous le point de position
  const show = { clouds: Boolean(start.clouds), rain: Boolean(start.rain) };
  let on = false, overlay = null, last = null, timer = 0, seq = 0, restoreZoom = null, sky = null, step = 0, playing = 0;

  // ---- deux interrupteurs (nuages, pluie) + vent (en haut à droite)
  const panel = el("div", "sky-panel"), switches = el("div", "sky-switches");
  const makeSwitch = (key, label, title) => {
    const b = el("button", "sky-switch");
    b.type = "button"; b.setAttribute("role", "switch"); b.title = title; b.dataset.layer = key;
    b.append(el("span", "sky-switch-label", label), el("span", "sky-switch-state", "OFF"));
    b.addEventListener("click", () => setShow({ ...show, [key]: !show[key] }));
    switches.append(b);
    return b;
  };
  const swCloud = makeSwitch("clouds", "Nuages", "Afficher ou masquer la couverture nuageuse à cet instant (valeurs des modèles)");
  const swRain = makeSwitch("rain", "Pluie", "Afficher ou masquer la pluie à cet instant (valeurs des modèles)");
  const wind = el("div", "sky-wind"); wind.hidden = true;
  const arrow = windArrow(), windText = el("div", "sky-wind-text");
  const windMain = el("strong", "sky-wind-main"), windSub = el("span", "sky-wind-sub");
  windText.append(windMain, windSub);
  wind.append(arrow, windText);
  panel.append(switches, wind);

  // ---- légende (en bas à gauche)
  const legend = el("div", "sky-legend"); legend.hidden = true;
  const status = el("p", "sky-status muted small"); status.hidden = true; // sous la carte, pour ne pas la recouvrir
  map.getContainer().insertAdjacentElement("afterend", status);
  const cloudBar = el("div", "sky-bar"); cloudBar.style.background = `${cloudGradientCss()}, #fff`; // fond blanc : la légende montre le gris tel qu'il apparaît sur la carte
  const rainBar = el("div", "sky-bar"); rainBar.style.background = rainGradientCss();
  const ticks = (labels) => { const d = el("div", "sky-ticks"); labels.forEach((t) => d.append(el("span", "", t))); return d; };
  const legCloud = el("div", "sky-leg-part"), legRain = el("div", "sky-leg-part");
  legCloud.append(el("p", "sky-leg-title", "Nuages (couverture)"), cloudBar, ticks(["0 %", "50 %", "100 %"]));
  legRain.append(el("p", "sky-leg-title", "Pluie (mm par heure)"), rainBar, ticks(RAIN_STOPS.map(([v], i, a) => (i === a.length - 1 ? `${nf0.format(v)}+` : nf1.format(v)))));
  legend.append(legCloud, legRain);

  const mkControl = (position, node) => {
    const c = L.control({ position });
    c.onAdd = () => { L.DomEvent.disableClickPropagation(node); L.DomEvent.disableScrollPropagation(node); return node; };
    return c.addTo(map);
  };
  mkControl("topright", panel);
  mkControl("bottomleft", legend);

  // ---- curseur dans le temps (sous la carte, au-dessus de la ligne d'état)
  const bar = el("div", "sky-time"); bar.hidden = true;
  const play = el("button", "sky-play"); play.type = "button";
  const range = el("input", "sky-range"); range.type = "range"; range.min = "0"; range.max = String(TIMELINE_HOURS); range.step = "1"; range.value = "0";
  range.setAttribute("aria-label", "Heure affichée sur la carte");
  range.title = "Faire glisser pour voir la pluie et les nuages prévus heure par heure";
  const when = el("output", "sky-when");
  bar.append(play, range, when);
  if (timeline) map.getContainer().insertAdjacentElement("afterend", bar);
  const setPlayButton = () => {
    play.textContent = playing ? "⏸\uFE0E" : "▶\uFE0E"; // \uFE0E : symbole texte, pas d'emoji (iOS)
    const t = playing ? "Arrêter la lecture" : "Faire défiler les 12 prochaines heures";
    play.title = t; play.setAttribute("aria-label", t);
  };
  setPlayButton();
  const stop = () => { clearInterval(playing); playing = 0; setPlayButton(); };
  const steps = () => sky?.data?.steps ?? [];
  function goTo(k) {
    step = Math.max(0, Math.min(k, steps().length));
    range.value = String(step);
    const s = step ? steps()[step - 1] : null;
    const txt = s ? fmtTime(s.at) : "Maintenant"; // l'heure exacte seulement : « +3 h » serait faux de quelques minutes à presque une heure
    when.textContent = txt; range.setAttribute("aria-valuetext", txt);
    if (sky) { paint(); showWind(s ? s.here : sky.data.here, s ? `à ${fmtTime(s.at)}` : "à l'instant"); }
  }
  range.addEventListener("input", () => { stop(); goTo(Number(range.value)); });
  play.addEventListener("click", () => {
    if (playing) { stop(); return; }
    if (step >= steps().length) goTo(0);
    playing = setInterval(() => { if (step >= steps().length) stop(); else goTo(step + 1); }, PLAY_MS);
    setPlayButton();
  });

  const setStatus = (t, err = false) => { status.hidden = !t; status.textContent = t; status.classList.toggle("is-err", err); };

  function showWind(h, label = "à l'instant") {
    const a = arrowAngle(h.dir);
    wind.hidden = false;
    arrow.style.visibility = a === null ? "hidden" : "visible";
    if (a !== null) arrow.querySelector(".sky-arrow").style.transform = `rotate(${a}deg)`;
    windMain.textContent = windFromText(h.dir);
    windSub.textContent = h.wind === null ? "" : `${nf0.format(h.wind)} km/h${h.gust === null ? "" : `, rafales ${nf0.format(h.gust)} km/h`} · ${label}`;
  }

  // La flèche du vent est toujours affichée (calque ON ou OFF) ; hors calque, un appel d'un seul point.
  let windSeq = 0;
  async function loadWind() {
    const id = ++windSeq;
    try { const h = await fetchHere(getHere()); if (id === windSeq && !on) showWind(h); } catch { if (id === windSeq && !on) wind.hidden = true; }
  }

  async function refresh() {
    const id = ++seq;
    const z = map.getZoom(), padded = map.getBounds().pad(0.25);
    const bounds = { south: Math.max(-MAX_LAT, padded.getSouth()), north: Math.min(MAX_LAT, padded.getNorth()), west: Math.max(-180, padded.getWest()), east: Math.min(180, padded.getEast()) };
    const sw0 = map.project([bounds.south, bounds.west], z), ne0 = map.project([bounds.north, bounds.east], z);
    const pw = Math.abs(ne0.x - sw0.x), ph = Math.abs(sw0.y - ne0.y);
    const { nx, ny } = gridDims(pw / ph);
    setStatus("Chargement…");
    try {
      const got = await fetchSky({ here: getHere(), bounds, nx, ny, hours: timeline ? TIMELINE_HOURS : 0 });
      if (id !== seq || !on) return;
      const w = 160, h = Math.max(24, Math.round((w * ph) / pw));
      sky = { data: got, bounds: [[bounds.south, bounds.west], [bounds.north, bounds.east]], w, h, urls: new Map() };
      last = { bounds: L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]), zoom: z };
      bar.hidden = !timeline || got.steps.length === 0;
      range.max = String(got.steps.length);
      goTo(step); // garde l'heure choisie après un déplacement de la carte (dessine, vent, texte)
    } catch (e) {
      if (id !== seq) return;
      setStatus(`Indisponible : ${e.message}`, true);
      stop(); bar.hidden = true;
      overlay?.remove(); overlay = null; last = null;
    }
  }

  // Image redessinée sans nouvel appel quand on change seulement de calque.
  // Pluie seule et rien à dessiner : on le dit, pour qu'une carte vide ne passe pas pour une panne.
  // Image de l'étape affichée : 0 = à l'instant (« current »), k = k-ième heure suivante. Images gardées par étape et calques.
  function frame() {
    const d = sky.data, s = step ? d.steps[step - 1] : null;
    return s ? { cloud: s.cloud, rain: s.rain, nx: d.nx, ny: d.ny, at: s.at, hour: true } : { cloud: d.cloud, rain: d.rain, nx: d.nx, ny: d.ny, at: d.at, hour: false };
  }
  function tell() {
    if (!sky) return;
    const f = frame();
    const dry = f.rain.length > 0 && f.rain.every((v) => typeof v === "number" && v < RAIN_MIN); // tous les points connus et secs ; un seul inconnu : rien n'est affirmé
    const head = f.hour
      ? `Prévision pour ${fmtTime(f.at)} (pluie tombée de ${fmtTime(f.at - 3600e3)} à ${fmtTime(f.at)}).`
      : `Modèles à l'instant${f.at ? ` (${fmtTime(f.at)})` : ""}.`;
    setStatus(`${show.rain && dry ? `Pas de pluie sur la zone ${f.hour ? "pendant cette heure" : "à cet instant"}. ` : ""}${head} Open-Meteo, valeurs interpolées entre points : indicatif.`);
  }
  function paint() {
    if (!sky) return;
    tell();
    const key = `${step}|${show.clouds}|${show.rain}`;
    let url = sky.urls.get(key);
    if (!url) { url = skyImageUrl(frame(), sky.w, sky.h, show); sky.urls.set(key, url); }
    if (overlay && overlay.getBounds().equals(L.latLngBounds(sky.bounds))) { overlay.setUrl(url); return; } // même zone : on change l'image seulement (pas de clignotement)
    const next = L.imageOverlay(url, sky.bounds, { pane: "skypane", interactive: false, className: "sky-img" }).addTo(map);
    overlay?.remove(); overlay = next;
  }
  function setShow(next, { first = false } = {}) {
    const was = on;
    show.clouds = next.clouds; show.rain = next.rain; on = show.clouds || show.rain;
    for (const [b, v] of [[swCloud, show.clouds], [swRain, show.rain]]) { b.setAttribute("aria-checked", String(v)); b.lastElementChild.textContent = v ? "ON" : "OFF"; b.classList.toggle("is-on", v); }
    legend.hidden = !on; legCloud.hidden = !show.clouds; legRain.hidden = !show.rain;
    if (!first) onShow({ ...show });
    clearTimeout(timer);
    if (on && was) { paint(); return; } // déjà lu : on redessine seulement
    if (on) {
      const here = getHere();
      // À l'allumage, la grille n'a pas de sens à l'échelle d'un village : zone d'environ 200 km (sauf au départ : le zoom retenu est gardé).
      if (!first && map.getZoom() > SKY_ZOOM + 1) { restoreZoom = map.getZoom(); map.setView([here.lat, here.lon], SKY_ZOOM, { animate: false }); } else restoreZoom = null;
      refresh();
    } else {
      stop(); step = 0; bar.hidden = true;
      setStatus(""); seq++; overlay?.remove(); overlay = null; last = null; sky = null;
      if (map.getContainer().offsetParent) loadWind(); // carte fermée : pas d'appel ; update() relira le vent à la réouverture
      if (restoreZoom !== null) { const here = getHere(); map.setView([here.lat, here.lon], restoreZoom, { animate: false }); restoreZoom = null; }
    }
  }
  map.on("moveend", () => {
    if (!on) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (!last || map.getZoom() !== last.zoom || !last.bounds.contains(map.getBounds())) refresh(); }, REFETCH_MS);
  });
  setShow(show, { first: true });
  if (!on) loadWind();
  return {
    isOn: () => on,
    update: () => { if (on) refresh(); else loadWind(); }, // nouvelle position : on relit
    off: () => { if (on) setShow({ clouds: false, rain: false }); },
    pause: () => { stop(); if (step) goTo(0); }, // fermeture de la carte : la lecture s'arrête, on rouvrira sur « Maintenant »
  };
}

// Zoom avant par double toucher (doigt ou stylet) et par double-clic (souris ; Maj = zoom arrière), autour du point touché.
// À utiliser avec L.map(…, { doubleClickZoom: false }). Un seul zoom par geste : si le navigateur envoie aussi un « dblclick »
// après notre détection, il est ignoré. Les touchers sur les commandes et les gestes à deux doigts (pincer) ne comptent pas.
export function addDoubleTapZoom(L, map) {
  const box = map.getContainer(), downs = new Map();
  let prev = null, multi = false, lastZoom = 0;
  const zoomAt = (latlng, delta) => {
    const now = Date.now();
    if (now - lastZoom < 500) return;
    lastZoom = now;
    map.setZoomAround(latlng, map.getZoom() + delta);
  };
  const pt = (e) => ({ x: e.clientX, y: e.clientY, t: Date.now() });
  box.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    downs.set(e.pointerId, pt(e));
    if (downs.size > 1) { multi = true; prev = null; }
  }, true);
  const end = (e) => {
    const down = downs.get(e.pointerId);
    downs.delete(e.pointerId);
    if (!down) return;
    const wasMulti = multi;
    if (!downs.size) multi = false;
    const up = pt(e);
    if (e.type !== "pointerup" || wasMulti || e.target.closest?.(".leaflet-control") || !isTap(down, up)) { prev = null; return; }
    if (isDoubleTap(prev, up)) {
      prev = null;
      const r = box.getBoundingClientRect();
      zoomAt(map.containerPointToLatLng(L.point(up.x - r.left, up.y - r.top)), 1);
    } else prev = up;
  };
  box.addEventListener("pointerup", end, true);
  box.addEventListener("pointercancel", end, true);
  map.on("dblclick", (e) => zoomAt(e.latlng, e.originalEvent?.shiftKey ? -1 : 1));
}
