// Commandes Leaflet des calques « Nuages » et « Pluie » : deux interrupteurs ON/OFF indépendants (26/11/2026), légende, et flèche du vent toujours affichée. Le calcul est dans weathermap.js.
// Tout le texte affiché est écrit par textContent ; seules des valeurs numériques calculées ici sont injectées dans les styles.
import { fetchSky, fetchHere, gridDims, skyImageUrl, windFromText, arrowAngle, cloudGradientCss, rainGradientCss, MAX_LAT, RAIN_STOPS, RAIN_MIN, isTap, isDoubleTap } from "./weathermap.js?v=df6ad046";

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
// onSwitch(on) : appelé quand le calque passe d'éteint à allumé ou l'inverse, AVANT la lecture de la grille : l'application y règle
// l'échelle (zoom « météo » ou « lieu », voir MAP_ZOOM) ; le centre n'est pas touché ici.
export function createSkyLayer(L, map, { getHere, fmtTime, show: start = { clouds: false, rain: false }, onShow = () => {}, onSwitch = () => {}, timeline = false }) {
  const pane = map.createPane("skypane");
  pane.style.zIndex = 250; pane.style.pointerEvents = "none"; // au-dessus des tuiles, sous le point de position
  const show = { clouds: Boolean(start.clouds), rain: Boolean(start.rain) };
  let on = false, overlay = null, last = null, timer = 0, seq = 0, sky = null, step = 0, playing = 0;

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
      if (!first) onSwitch(true);
      clearTimeout(timer); // le changement d'échelle a pu programmer une relecture : celle-ci suffit
      refresh();
    } else {
      stop(); step = 0; bar.hidden = true;
      setStatus(""); seq++; overlay?.remove(); overlay = null; last = null; sky = null;
      if (map.getContainer().offsetParent) loadWind(); // carte fermée : pas d'appel ; update() relira le vent à la réouverture
      if (was) onSwitch(false);
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
