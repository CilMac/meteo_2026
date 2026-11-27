// Commandes Leaflet des calques « Nuages », « Pluie », « Vent » (barbules) et « Radar » : interrupteurs ON/OFF (26-27/11/2026), légendes, et flèche du vent (masquée quand le calque Vent est allumé). Le calcul est dans weathermap.js.
// Tout le texte affiché est écrit par textContent ; seules des valeurs numériques calculées ici sont injectées dans les styles.
import { fetchSky, fetchHere, gridDims, skyImageUrl, windFromText, arrowAngle, cloudGradientCss, rainGradientCss, MAX_LAT, RAIN_STOPS, RAIN_MIN, isTap, isDoubleTap, fetchRadarFrames, RADAR, RADAR_COVERAGE_URL, RADAR_RAIN, radarTicks, radarGradientCss, snowGradientCss, filterRadarPixels, barbSvg, WIND_GRID } from "./weathermap.js?v=c631804d";

const REFETCH_MS = 700;
const TIMELINE_HOURS = 12; // curseur de la carte plein écran : maintenant, puis les 12 heures suivantes (comme la vue des 12 heures)
const RADAR_INDEX_MAX_AGE_MS = 5 * 60 * 1000; // liste des images radar relue au-delà (une nouvelle image toutes les 10 min)
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
// onSwitch(on) : appelé quand le calque passe d'éteint à allumé ou l'inverse, AVANT la lecture de la grille : l'application y règle
// l'échelle (zoom « météo » ou « lieu », voir MAP_ZOOM) ; le centre n'est pas touché ici.
// radar : interrupteur « Radar » (pluie OBSERVÉE, RainViewer, 26/11/2026), seul à l'écran : l'allumer éteint Nuages et Pluie, et
// l'inverse (passé observé et futur prévu ne se mélangent pas). Sa propre réglette : de −2 h à la dernière image, par pas de 20 min.
// Vent (27/11/2026) : interrupteur « Vent », barbules en km/h sur une grille plus serrée (WIND_GRID), qui suivent la réglette des heures ;
// se combine avec Nuages et Pluie, pas avec le Radar (même règle). Tant qu'il est allumé, la grande flèche du vent est masquée
// (elle pointe vers où va le vent, la hampe des barbules vers d'où il vient : les deux ensemble se contrediraient à l'œil).
export function createSkyLayer(L, map, { getHere, fmtTime, show: start = { clouds: false, rain: false }, onShow = () => {}, onSwitch = () => {}, timeline = false, radar = false }) {
  const pane = map.createPane("skypane");
  pane.style.zIndex = 250; pane.style.pointerEvents = "none"; // au-dessus des tuiles, sous le point de position
  const show = { clouds: Boolean(start.clouds), rain: Boolean(start.rain), wind: false, radar: false };
  let radarOn = false;
  let on = false, overlay = null, last = null, timer = 0, seq = 0, sky = null, step = 0, playing = 0;

  // ---- deux interrupteurs (nuages, pluie) + vent (en haut à droite)
  const panel = el("div", "sky-panel"), switches = el("div", "sky-switches");
  const makeSwitch = (key, label, title) => {
    const b = el("button", "sky-switch");
    b.type = "button"; b.setAttribute("role", "switch"); b.title = title; b.dataset.layer = key;
    b.append(el("span", "sky-switch-label", label), el("span", "sky-switch-state", "OFF"));
    b.addEventListener("click", () => {
      const v = !show[key];
      setShow(key === "radar" ? { clouds: false, rain: false, wind: false, radar: v } : { ...show, [key]: v, radar: v ? false : show.radar });
    });
    switches.append(b);
    return b;
  };
  const swCloud = makeSwitch("clouds", "Nuages", "Afficher ou masquer la couverture nuageuse à cet instant (valeurs des modèles)");
  const swRain = makeSwitch("rain", "Pluie", "Afficher ou masquer la pluie à cet instant (valeurs des modèles)");
  const swWind = makeSwitch("wind", "Vent", "Afficher ou masquer le vent en barbules (km/h, valeurs des modèles)");
  const swRadar = radar ? makeSwitch("radar", "Radar", "Afficher ou masquer la pluie observée par les radars (2 dernières heures, RainViewer)") : null;
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
  const legRadar = el("div", "sky-leg-part");
  const radarRainBar = el("div", "sky-bar"); radarRainBar.style.background = `${radarGradientCss(RADAR_RAIN)}, #fff`;
  const radarSnowBar = el("div", "sky-bar"); radarSnowBar.style.background = `${snowGradientCss()}, #fff`;
  legRadar.append(el("p", "sky-leg-title", "Radar : pluie (≈ mm par heure)"), radarRainBar, ticks(radarTicks()),
    el("p", "sky-leg-title", "Radar : neige"), radarSnowBar, ticks(["faible", "forte"]));
  legend.append(legCloud, legRain, legRadar);

  const mkControl = (position, node) => {
    const c = L.control({ position });
    c.onAdd = () => { L.DomEvent.disableClickPropagation(node); L.DomEvent.disableScrollPropagation(node); return node; };
    return c.addTo(map);
  };
  mkControl("topright", panel);
  mkControl("bottomleft", legend);

  // ---- légende du vent (en bas à gauche, au-dessus de l'autre) : deux barbules repères et un « i » qui explique la lecture
  const windKey = el("div", "sky-wind-key"); windKey.hidden = true;
  const keyBarb = (kmh, size = 34) => { const s = el("span", "sky-barb-ico"); s.innerHTML = barbSvg(kmh, 270, size); return s; }; // SVG calculé ici, sans donnée externe
  const windInfo = el("button", "mini-info-btn sky-wind-i", "i");
  windInfo.type = "button"; windInfo.title = "Lire une barbule"; windInfo.setAttribute("aria-label", "Lire une barbule");
  windInfo.setAttribute("aria-expanded", "false"); windInfo.setAttribute("aria-controls", "sky-wind-help");
  const windHelp = el("div", "sky-wind-help"); windHelp.id = "sky-wind-help"; windHelp.hidden = true;
  windHelp.append(el("p", "sky-wh-title", "Lire une barbule"));
  for (const [v, t] of [[5, "demi-trait : 5 km/h"], [10, "trait : 10 km/h"], [50, "triangle : 50 km/h"], [25, "2 traits et demi : 25 km/h"], [0, "cercle : calme (moins de 2,5 km/h)"]]) {
    const row = el("div", "sky-wh-row"); row.append(keyBarb(v), el("span", "", t)); windHelp.append(row);
  }
  windHelp.append(
    el("p", "", "Les traits s'additionnent (vitesse arrondie aux 5 km/h). La hampe part vers l'endroit d'où vient le vent : ci-dessus, vent d'ouest."),
    el("p", "", "Vent à 10 m, hors rafales ; celles du point marqué sont dans la ligne sous la carte. Sur une carte marine, ces traits valent des nœuds ; ici, des km/h. Point sans valeur : rien n'est dessiné."));
  windInfo.addEventListener("click", () => {
    windHelp.hidden = !windHelp.hidden; windInfo.setAttribute("aria-expanded", String(!windHelp.hidden));
    // Petit écran, légende des nuages en plus : le panneau ne doit pas sortir de la carte par le haut (il défile alors).
    if (!windHelp.hidden) windHelp.style.maxHeight = `${Math.max(120, windKey.getBoundingClientRect().top - map.getContainer().getBoundingClientRect().top - 16)}px`;
  });
  const closeWindHelp = () => { windHelp.hidden = true; windInfo.setAttribute("aria-expanded", "false"); };
  windKey.append(keyBarb(10), el("span", "", "10 km/h"), keyBarb(50), el("span", "", "50 km/h"), windInfo, windHelp);
  mkControl("bottomleft", windKey);
  const barbPane = map.createPane("barbpane");
  barbPane.style.zIndex = 255; barbPane.style.pointerEvents = "none"; // au-dessus des nuages et de la pluie, sous le point de position
  const barbs = L.layerGroup().addTo(map);

  // ---- curseur dans le temps (sous la carte, au-dessus de la ligne d'état)
  const bar = el("div", "sky-time"); bar.hidden = true;
  const play = el("button", "sky-play"); play.type = "button";
  const range = el("input", "sky-range"); range.type = "range"; range.min = "0"; range.max = String(TIMELINE_HOURS); range.step = "1"; range.value = "0";
  range.setAttribute("aria-label", "Heure affichée sur la carte");
  range.title = "Faire glisser pour voir la pluie, les nuages et le vent prévus heure par heure";
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
    const dense = show.wind, { nx, ny } = dense ? gridDims(pw / ph, WIND_GRID.total, WIND_GRID.max) : gridDims(pw / ph);
    setStatus("Chargement…");
    try {
      const got = await fetchSky({ here: getHere(), bounds, nx, ny, hours: timeline ? TIMELINE_HOURS : 0 });
      if (id !== seq || !on) return;
      const w = 160, h = Math.max(24, Math.round((w * ph) / pw));
      sky = { data: got, bounds: [[bounds.south, bounds.west], [bounds.north, bounds.east]], w, h, urls: new Map(), dense };
      last = { bounds: L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]), zoom: z };
      bar.hidden = !timeline || got.steps.length === 0;
      range.max = String(got.steps.length);
      goTo(step); // garde l'heure choisie après un déplacement de la carte (dessine, vent, texte)
    } catch (e) {
      if (id !== seq) return;
      setStatus(`Indisponible : ${e.message}`, true);
      stop(); bar.hidden = true;
      overlay?.remove(); overlay = null; last = null; barbs.clearLayers();
    }
  }

  // Image redessinée sans nouvel appel quand on change seulement de calque.
  // Pluie seule et rien à dessiner : on le dit, pour qu'une carte vide ne passe pas pour une panne.
  // Image de l'étape affichée : 0 = à l'instant (« current »), k = k-ième heure suivante. Images gardées par étape et calques.
  function frame() {
    const d = sky.data, s = step ? d.steps[step - 1] : null;
    return s ? { cloud: s.cloud, rain: s.rain, wind: s.wind, dir: s.dir, here: s.here, nx: d.nx, ny: d.ny, at: s.at, hour: true }
      : { cloud: d.cloud, rain: d.rain, wind: d.wind, dir: d.dir, here: d.here, nx: d.nx, ny: d.ny, at: d.at, hour: false };
  }
  function tell() {
    if (!sky) return;
    const f = frame();
    const dry = f.rain.length > 0 && f.rain.every((v) => typeof v === "number" && v < RAIN_MIN); // tous les points connus et secs ; un seul inconnu : rien n'est affirmé
    const head = f.hour
      ? `Prévision pour ${fmtTime(f.at)}${show.rain ? ` (pluie tombée de ${fmtTime(f.at - 3600e3)} à ${fmtTime(f.at)})` : ""}.`
      : `Modèles à l'instant${f.at ? ` (${fmtTime(f.at)})` : ""}.`;
    // Vent du point marqué (les rafales n'ont pas de barbule) : même texte que la grande flèche, masquée tant que le calque Vent est allumé.
    const h = f.here, kmh = (v) => (v === null ? "—" : `${nf0.format(v)} km/h`);
    // Heure par heure, les rafales sont le maximum de l'heure qui s'achève (même convention que la pluie) : on le dit.
    const from = h.dir === null ? "" : ` (${windFromText(h.dir).replace(/^Vent/, "vent")})`;
    const gusts = f.hour ? `rafales jusqu'à ${kmh(h.gust)} entre ${fmtTime(f.at - 3600e3)} et ${fmtTime(f.at)}` : `rafales ${kmh(h.gust)}`;
    const windTxt = show.wind ? ` Vent au point marqué : ${kmh(h.wind)}${from}, ${gusts}.` : "";
    const image = show.clouds || show.rain ? " Open-Meteo, valeurs interpolées entre points : indicatif." : " Open-Meteo : une barbule par point de grille, sans interpolation.";
    setStatus(`${show.rain && dry ? `Pas de pluie sur la zone ${f.hour ? "pendant cette heure" : "à cet instant"}. ` : ""}${head}${windTxt}${image}`);
  }
  // Barbules de l'étape affichée, une par point de la grille (y compris dans la marge hors de l'écran, prête pour un déplacement).
  function drawBarbs() {
    barbs.clearLayers();
    if (!sky || !show.wind) return;
    const f = frame(), pts = sky.data.pts;
    pts.forEach((p, k) => {
      const svg = barbSvg(f.wind[k], f.dir[k]);
      if (!svg) return; // inconnu : rien dessiné
      L.marker([p.lat, p.lon], { pane: "barbpane", interactive: false, keyboard: false,
        icon: L.divIcon({ className: "sky-barb", html: svg, iconSize: [44, 44], iconAnchor: [22, 22] }) }).addTo(barbs);
    });
  }
  function paint() {
    if (!sky) return;
    tell();
    drawBarbs();
    if (!show.clouds && !show.rain) { overlay?.remove(); overlay = null; return; } // vent seul : pas d'image
    const key = `${step}|${show.clouds}|${show.rain}`;
    let url = sky.urls.get(key);
    if (!url) { url = skyImageUrl(frame(), sky.w, sky.h, show); sky.urls.set(key, url); }
    if (overlay && overlay.getBounds().equals(L.latLngBounds(sky.bounds))) { overlay.setUrl(url); return; } // même zone : on change l'image seulement (pas de clignotement)
    const next = L.imageOverlay(url, sky.bounds, { pane: "skypane", interactive: false, className: "sky-img" }).addTo(map);
    overlay?.remove(); overlay = next;
  }
  // ---- radar de pluie observée (RainViewer) : couverture grisée + une couche de tuiles par image, réglette à part
  const radarPane = map.createPane("radarpane");
  radarPane.style.zIndex = 240; radarPane.style.pointerEvents = "none"; // sous les nuages et la pluie des modèles (jamais affichés ensemble)
  const RADAR_ATTR = 'Radar : <a href="https://www.rainviewer.com/">RainViewer</a>'; // crédit demandé par RainViewer, ajouté au crédit de la carte tant que le radar est affiché
  const radarOpts = { pane: "radarpane", tileSize: 512, zoomOffset: -1, maxNativeZoom: RADAR.nativeZoom, attribution: RADAR_ATTR }; // au-delà du zoom 8 : images agrandies
  // Tuiles radar redessinées dans un canevas : la neige y est repeinte en violet (filterRadarPixels, weathermap.js) ; tout reste affiché.
  // RainViewer autorise cette lecture (en-tête « access-control-allow-origin: * », vérifié) et la permet expressément (api.html).
  const RadarTiles = L.TileLayer.extend({
    createTile(coords, done) {
      const canvas = document.createElement("canvas"), img = new Image();
      canvas.width = canvas.height = 512;
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, 512, 512);
          const d = ctx.getImageData(0, 0, 512, 512);
          filterRadarPixels(d.data);
          ctx.putImageData(d, 0, 0);
          canvas.complete = true; // Leaflet traite comme « en cours » une tuile sans cette marque
          done(null, canvas);
        } catch (e) { done(e, canvas); }
      };
      img.onerror = (e) => done(e, canvas);
      img.src = this.getTileUrl(coords);
      return canvas;
    },
  });
  const rBar = el("div", "sky-time"); rBar.hidden = true;
  const rPlay = el("button", "sky-play"); rPlay.type = "button";
  const rRange = el("input", "sky-range"); rRange.type = "range"; rRange.min = "0"; rRange.max = "0"; rRange.step = "1"; rRange.value = "0";
  rRange.setAttribute("aria-label", "Heure de l'image radar");
  rRange.title = "Faire glisser pour voir la pluie observée des 2 dernières heures, toutes les 20 minutes";
  const rWhen = el("output", "sky-when");
  rBar.append(rPlay, rRange, rWhen);
  if (radar) map.getContainer().insertAdjacentElement("afterend", rBar);
  let frames = [], framesAt = 0, rStep = 0, rPlaying = 0, rSeq = 0, rLayer = null, rOld = [], cover = null, rFailed = false;
  const setRPlay = () => {
    rPlay.textContent = rPlaying ? "⏸︎" : "▶︎";
    const t = rPlaying ? "Arrêter la lecture" : "Faire défiler les 2 dernières heures";
    rPlay.title = t; rPlay.setAttribute("aria-label", t);
  };
  setRPlay();
  const rStop = () => { clearInterval(rPlaying); rPlaying = 0; setRPlay(); };
  function rTell() {
    const f = frames[rStep];
    if (!f) return;
    setStatus(rFailed ? "Radar : certaines images n'ont pas pu être chargées (RainViewer ne garantit pas leur disponibilité)."
      : `Radar RainViewer : pluie et neige (en violet) observées à ${fmtTime(f.at)}${rStep === frames.length - 1 ? " (dernière image publiée)" : ""}. `
        + "Zones grisées : hors de portée des radars. Couleurs ≈ mm/h (approximation).", rFailed);
  }
  function rGoTo(k) {
    if (!frames.length) return;
    rStep = Math.max(0, Math.min(k, frames.length - 1));
    rRange.value = String(rStep);
    const f = frames[rStep], txt = rStep === frames.length - 1 ? `${fmtTime(f.at)} · dernière` : fmtTime(f.at);
    rWhen.textContent = txt; rRange.setAttribute("aria-valuetext", txt);
    if (rLayer) rOld.push(rLayer);
    const next = new RadarTiles(f.url, radarOpts);
    next.on("tileerror", () => { if (next === rLayer && !rFailed) { rFailed = true; rTell(); } });
    // L'image précédente reste jusqu'à l'arrivée de la nouvelle (pas de clignotement), au plus 2 s.
    const clean = () => { if (next !== rLayer) return; rOld.forEach((l) => l.remove()); rOld = []; };
    next.once("load", clean); setTimeout(clean, 2000);
    rLayer = next.addTo(map); rFailed = false;
    rTell();
  }
  rRange.addEventListener("input", () => { rStop(); rGoTo(Number(rRange.value)); });
  rPlay.addEventListener("click", () => {
    if (rPlaying) { rStop(); return; }
    if (rStep >= frames.length - 1) rGoTo(0);
    rPlaying = setInterval(() => { if (rStep >= frames.length - 1) rStop(); else rGoTo(rStep + 1); }, PLAY_MS);
    setRPlay();
  });
  async function startRadar() {
    const id = ++rSeq;
    setStatus("Radar : chargement…");
    try {
      if (!frames.length || Date.now() - framesAt > RADAR_INDEX_MAX_AGE_MS) { frames = await fetchRadarFrames(); framesAt = Date.now(); }
      if (id !== rSeq || !radarOn) return;
      cover = L.tileLayer(RADAR_COVERAGE_URL, { ...radarOpts, opacity: 0.25 }).addTo(map); // noir hors radar, transparent dessous : gris léger
      rRange.max = String(frames.length - 1);
      rBar.hidden = false;
      rGoTo(frames.length - 1); // ouverture sur la dernière image publiée
    } catch (e) {
      if (id !== rSeq) return;
      setStatus(`Radar indisponible : ${e.message}`, true);
    }
  }
  function stopRadar() {
    rSeq++; rStop(); rBar.hidden = true;
    rOld.forEach((l) => l.remove()); rOld = []; rLayer?.remove(); rLayer = null; cover?.remove(); cover = null; rFailed = false;
  }

  function setShow(next, { first = false } = {}) {
    const wasModel = on, wasRadar = radarOn, wasAny = wasModel || wasRadar;
    show.clouds = Boolean(next.clouds); show.rain = Boolean(next.rain); show.wind = Boolean(next.wind); show.radar = radar && Boolean(next.radar);
    on = show.clouds || show.rain || show.wind; radarOn = show.radar;
    const any = on || radarOn;
    for (const [b, v] of [[swCloud, show.clouds], [swRain, show.rain], [swWind, show.wind], [swRadar, show.radar]]) {
      if (!b) continue;
      b.setAttribute("aria-checked", String(v)); b.lastElementChild.textContent = v ? "ON" : "OFF"; b.classList.toggle("is-on", v);
    }
    legend.hidden = !(show.clouds || show.rain || show.radar); legCloud.hidden = !show.clouds; legRain.hidden = !show.rain; legRadar.hidden = !show.radar;
    if (!first) onShow({ ...show });
    clearTimeout(timer);
    if (!first && any !== wasAny) onSwitch(any); // échelle « météo » ou « lieu », AVANT la lecture
    clearTimeout(timer); // le changement d'échelle a pu programmer une relecture : celle qui suit suffit
    if (wasRadar && !radarOn) stopRadar();
    windKey.hidden = !show.wind; if (!show.wind) closeWindHelp();
    panel.classList.toggle("is-barbs", show.wind); // grande flèche masquée (voir plus haut)
    if (on && wasModel && (!show.wind || sky?.dense)) paint(); // déjà lu : on redessine seulement (le vent demande la grille serrée)
    else if (on) refresh();
    else if (wasModel) { stop(); step = 0; bar.hidden = true; seq++; overlay?.remove(); overlay = null; last = null; sky = null; barbs.clearLayers(); }
    if (radarOn && !wasRadar) startRadar();
    if (!any) setStatus("");
    if (!on && wasModel && map.getContainer().offsetParent) loadWind(); // carte fermée : pas d'appel ; update() relira le vent à la réouverture
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
    off: () => { if (on || radarOn) setShow({ clouds: false, rain: false, wind: false, radar: false }); },
    turnOn: (key) => { if (!show[key]) setShow(key === "radar" ? { clouds: false, rain: false, wind: false, radar: true } : { ...show, [key]: true, radar: false }); }, // comme un toucher sur l'interrupteur
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

// Stations d'aéroport sur la carte (26/11/2026) : bouton « manche à air » sous le relief ; chaque station du pays du lieu avec un
// relevé de moins de 3 h montre sa pression mesurée (QNH, hPa) et un éclair si un orage y est observé ; la toucher ouvre son détail.
// getTarget() → { lat, lon, cc, name } ; fmtTime(ms) → « 14:30 » (heure du lieu) ; load(cc) → stations (fetchStationsForMap).
// Éteinte à chaque ouverture de la carte (off), comme Nuages et Pluie. Tout le texte est posé par textContent.
export function createStationLayer(L, map, { getTarget, fmtTime, load, distanceKm, stormWords, metarLines }) {
  let on = false, seq = 0, group = null;
  const status = el("p", "sky-status stn-status muted small"); status.hidden = true;
  map.getContainer().insertAdjacentElement("afterend", status);
  const say = (t, err = false) => { status.hidden = !t; status.textContent = t ?? ""; status.classList.toggle("is-err", err); };
  const ctl = L.control({ position: "topleft" });
  let btn = null, bar = null;
  const show = () => {
    const t = on ? "Stations d'aéroport affichées : toucher pour les masquer" : "Afficher les stations d'aéroport : pression mesurée et orages observés";
    btn.title = t; btn.setAttribute("aria-label", "Stations d'aéroport"); btn.setAttribute("aria-pressed", String(on)); bar.classList.toggle("is-on", on);
  };
  ctl.onAdd = () => {
    bar = L.DomUtil.create("div", "leaflet-bar map-base map-stn"); btn = L.DomUtil.create("a", "", bar);
    btn.href = "#"; btn.setAttribute("role", "button");
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M5 3v18"/><path d="M5 4.5 19 7v4L5 13.5z"/><path d="M10 5.4v7.2M14.5 6.2v5.6"/></svg>'; // manche à air, statique
    show();
    L.DomEvent.on(btn, "click", (e) => { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); set(!on); });
    return bar;
  };
  ctl.addTo(map);
  const bolt = () => {
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "13"); svg.setAttribute("height", "13"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("class", "stn-bolt");
    svg.innerHTML = '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>';
    return svg;
  };
  function marker(s, target) {
    const pill = el("span", `stn-pill${s.storm ? " has-storm" : ""}`);
    if (s.storm) pill.append(bolt());
    pill.append(el("span", "", s.hpa === null ? "—" : String(s.hpa))); // « 1016 », sans espace des milliers, comme le baromètre
    pill.title = s.name;
    const m = L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "stn-icon", html: pill, iconSize: null }), keyboard: true, title: s.name, riseOnHover: true });
    const box = el("div", "stn-pop");
    const km = distanceKm(target.lat, target.lon, s.lat, s.lon);
    box.append(el("strong", "", `${s.name} (${s.station})`), el("span", "muted", `${nf0.format(km)} km de ${target.here ? "votre position" : target.name}`));
    box.append(el("span", "", s.hpa === null ? "Pression : — (non transmise)" : `Pression mesurée : ${s.hpa} hPa (QNH, ramenée au niveau de la mer)`));
    if (s.storm) box.append(el("span", "stn-pop-storm", `${stormWords[s.storm.kind]} (code ${s.storm.code}).`));
    for (const t of metarLines(s.obs, { skip: s.storm ? [s.storm.code] : [] })) box.append(el("span", "", t));
    box.append(el("span", "muted", `Relevé de ${fmtTime(s.at)} (message METAR${s.obs?.auto ? ", station automatique" : ""}).`));
    if (s.raw) box.append(el("code", "stn-raw", s.raw));
    // Marge en haut à gauche : la bulle ne passe pas sous les boutons (colonne de gauche ≈ 50 px) ni sous le cadre du vent (en haut).
    m.bindPopup(box, { maxWidth: Math.max(180, Math.min(280, map.getSize().x - 114)) /* 114 = marges 58 + 12 et bords de la bulle 44 */, autoPanPaddingTopLeft: [58, 140], autoPanPaddingBottomRight: [12, 12] });
    return m;
  }
  async function draw() {
    const id = ++seq, target = getTarget();
    say("Stations : chargement…");
    try {
      const list = await load(target.cc);
      if (id !== seq || !on) return;
      group?.remove();
      group = L.layerGroup(list.map((s) => marker(s, target))).addTo(map);
      const storms = list.filter((s) => s.storm).length;
      say(list.length
        ? `Stations d'aéroport du pays du lieu (IEM) : ${list.length} avec un relevé de moins de 3 h${storms ? `, dont ${storms} avec un orage observé` : ", aucun orage observé"}. Pression en hPa ; toucher une station pour le détail.`
        : "Stations d'aéroport : aucun relevé de moins de 3 h dans ce pays.");
    } catch (e) {
      if (id !== seq) return;
      say(`Stations indisponibles : ${e.message}`, true);
    }
  }
  function set(next) {
    on = next; show();
    if (on) draw(); else { seq++; group?.remove(); group = null; say(""); }
  }
  return { off: () => { if (on) set(false); }, update: () => { if (on) draw(); } };
}
