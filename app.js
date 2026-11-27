// Orchestration : lieu, un appel réseau par validation, onglets qui re-rendent sans appel réseau.
import { FAVORITES, DEFAULT_PLACE, CUSTOM_ID, searchPlaces, validatePlace, placeLabel } from "./places.js?v=521daa6a";
import { fetchForecast, localDateISO } from "./weather-provider.js?v=afd8726c";
import { loadWarnings, officialSource } from "./warnings.js?v=79a17bd6";
import { fetchEnsemble } from "./ensemble.js?v=88c38ccc";
import { initInfo } from "./info.js?v=0231d5ac";
import { initBarometer, preloadDial, trendSign } from "./barometer.js?v=f58dbfb8";
import { createSkyLayer, addDoubleTapZoom, createStationLayer } from "./skymap.js?v=1dd4b71e";
import { parseMapPrefs, MAP_ZOOM, maxZoomFor } from "./weathermap.js?v=32549e56";
import { initWalk } from "./walkui.js?v=fbdaa9a1";
import { buildHome, buildHomeNow, wireHomePages, homeSteps, homeAlerts, HOME_STEPS, HOME_PAGES, homeLegend, buildLegend, homeMode, HOME_KEY, PHONE_QUERY } from "./home.js?v=9bb7b375";
import { localToMs, fetchNextHour } from "./walk.js?v=dbfc9474";
import { fetchObservedPressure, fetchPressureTrend, fetchObservedStorms, stormText, fetchObservedPrecip, precipText, pressureDisplay, TREND_WORD, fetchStationsForMap, distanceKm, STORM_WORDS, metarLines } from "./observation.js?v=9b23b237";
import { getPosition, reverseGeocode, placeFromPosition, storedGeoPlace, formatCoords, deniedHelp, GEO_ID, GEO_MAX_AGE_MS } from "./geo.js?v=b6df63a8";
import { shouldRefresh, STALE_MS, TRY_GAP_MS, RETRY_MS, QUIET_WAIT_MS } from "./refresh.js?v=beadd3fe";
import { createLoader } from "./loading.js?v=956b591b";
import { makeRecord, saveRecord, loadJournal, exportText, exportName } from "./journal.js?v=47a0f04a";
import { chooseView, DEFAULT_VIEW, isIOS } from "./device.js?v=804d2636";
import { TABS, foldTip, buildPin, buildTopPlace, buildTopNow, buildCurrent, buildHourly, buildWeek, buildTrend, buildCompact, buildMini, extremeText, COMPACT_HELP_ITEMS, buildSources, buildWarnings, buildAttribution, warningsStatus, formatLocal } from "./weather-render.js?v=8a4c0223";

const $ = (id) => {
  const el = document.getElementById(id);
  // Un élément absent signale presque toujours des fichiers publiés de versions différentes (index.html ancien avec app.js récent, par exemple).
  if (!el) throw new Error(`élément « #${id} » introuvable : les fichiers du site ne sont pas tous de la même version (republiez-les tous, puis rechargez avec Cmd+Maj+R)`);
  return el;
};
const PLACE_KEY = "meteo.lastPlace", CUSTOM_KEY = "meteo.customPlace", POSITION_KEY = "meteo.position", TAB_DEFAULT = "precip";

const loader = createLoader($("loader"));
const state = { place: null, data: null, warnings: null, ensemble: undefined, pressure: null, view: DEFAULT_VIEW, tab: TAB_DEFAULT, loading: false, searching: 0, loadId: 0, posCoords: null };

// Dernier « autre lieu » choisi, relu et revalidé (jamais pris tel quel dans le stockage) ; absent ou illisible : null.
function readCustomPlace() {
  try { return validatePlace(JSON.parse(localStorage.getItem(CUSTOM_KEY))); } catch { return null; }
}
// Dernier lieu validé : favori, ou lieu libre.
function readLastPlace() {
  try {
    const id = localStorage.getItem(PLACE_KEY);
    if (id === CUSTOM_ID) return readCustomPlace() ?? DEFAULT_PLACE;
    return FAVORITES.find((p) => p.id === id) ?? DEFAULT_PLACE;
  } catch { return DEFAULT_PLACE; } // stockage indisponible ou corrompu
}
function saveLastPlace(place) {
  try {
    localStorage.setItem(PLACE_KEY, place.id);
    if (place.id === CUSTOM_ID) localStorage.setItem(CUSTOM_KEY, JSON.stringify(place));
    if (place.id === GEO_ID) localStorage.setItem(POSITION_KEY, JSON.stringify(place));
  } catch { /* ignoré */ }
}
const lastPlaceId = () => { try { return localStorage.getItem(PLACE_KEY); } catch { return null; } };
// Dernière position connue (« Ma position »), relue et revalidée ; absente ou illisible : null.
function readStoredPosition() {
  try { return storedGeoPlace(JSON.parse(localStorage.getItem(POSITION_KEY))); } catch { return null; }
}

function setStatus(text, kind = "") { const s = $("status"); s.className = kind; s.textContent = text; }

// Onglets : seul `state.tab` change, aucun appel réseau.
function renderTabs() {
  const box = $("tabs");
  box.replaceChildren();
  for (const t of TABS) {
    const b = document.createElement("button");
    b.type = "button"; b.className = `tab fam-${t.id}`; b.id = `tab-${t.id}`; b.textContent = t.label; b.title = t.tip;
    b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(t.id === state.tab));
    b.setAttribute("aria-controls", "hourly"); b.tabIndex = t.id === state.tab ? 0 : -1;
    b.addEventListener("click", () => selectTab(t.id));
    b.addEventListener("keydown", (e) => {
      const i = TABS.findIndex((x) => x.id === state.tab);
      const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
      if (next === null) return;
      e.preventDefault();
      selectTab(TABS[(next + TABS.length) % TABS.length].id, true);
    });
    box.append(b);
  }
}
function selectTab(id, focus = false) {
  state.tab = id;
  renderTabs();
  renderTabbed();
  if (focus) $(`tab-${id}`).focus();
}
// Le titre de chaque section nomme la rubrique active (précipitations, températures, vent).
const RUBRIC = { precip: "précipitations", temp: "températures", wind: "vent" };
function renderTitles() {
  for (const id of ["h-24", "h-7", "h-15", "h-compact", "h-compact-15"]) {
    const pill = $(id).querySelector(".rubric");
    pill.textContent = RUBRIC[state.tab];
    pill.className = `rubric fam-${state.tab}`;
  }
}
// Bandeau 24 h : en changeant d'onglet (ou quand les scénarios arrivent), on reste sur les mêmes heures ; nouvelles données
// (autre lieu, Actualiser) : retour au début. Les cases ont la même largeur dans les trois onglets, la position suffit.
let stripScroll = { data: null, left: 0 };
function renderTabbed() {
  renderTitles();
  if (!state.data) return;
  const oldStrip = $("hourly").querySelector(".strip");
  if (oldStrip) stripScroll = { data: stripScroll.data, left: oldStrip.scrollLeft };
  if (stripScroll.data !== state.data) stripScroll = { data: state.data, left: 0 };
  $("hourly").setAttribute("aria-labelledby", `tab-${state.tab}`);
  $("hourly").replaceChildren(buildHourly(state.data, state.tab));
  const newStrip = $("hourly").querySelector(".strip");
  if (newStrip) newStrip.scrollLeft = stripScroll.left;
  $("week").replaceChildren(buildWeek(state.data, state.tab, state.ensemble));
  $("trend").replaceChildren(buildTrend(state.data, state.tab, state.ensemble));
  const compact = buildCompact(state.data, state.tab, state.ensemble);
  $("compact").replaceChildren(compact.week);
  $("compact-trend").replaceChildren(compact.trend);
  $("compact-trend-fold").hidden = !compact.hasTrend;
}

function renderAll() {
  const d = state.data;
  $("content").hidden = false;
  $("where").textContent = `${d.location.name}${d.location.country ? ` (${d.location.country})` : ""} · fuseau ${d.location.timezone} · ` +
    formatLocal(new Date(), d.location.timezone, { dateStyle: "full", timeStyle: "short" });
  $("current").replaceChildren(buildCurrent(d));
  // Épingle : seulement à la position actuelle (pas un lieu de la liste, ni une « dernière position connue »).
  $("top-place").replaceChildren(buildTopPlace(d, { here: state.place?.id === GEO_ID && !state.note }));
  $("top-now").replaceChildren(buildTopNow(d));
  renderTabs();
  renderTabbed();
  renderWarnings();
  $("refresh").hidden = false;
  $("place-map-btn").disabled = false;
  updateFreshness();
}

// Vue minimale : les prochaines heures à la position réelle de l'appareil ; remplace la page tant qu'elle est ouverte.
// La position n'est jamais stockée (mémoire seulement) ; la prévision est celle de la position, pas du lieu choisi dans la liste.
const geo = { at: 0, shown: false, data: null, coords: null, named: true, pressure: null, storms: null, precip: null, loadId: 0 };
function miniMessage(text, kind = "") { const m = $("mini-msg"); m.hidden = !text; m.textContent = text; m.className = `mini-msg${kind ? ` is-${kind}` : ""}`; }
// Carte : Leaflet est chargé au premier clic seulement (aucun appel réseau tant qu'on ne l'ouvre pas).
const LEAFLET = {
  css: { href: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", integrity: "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" },
  js: { src: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", integrity: "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" },
};
let leafletP = null;
function loadLeaflet() {
  if (globalThis.L) return Promise.resolve(globalThis.L);
  leafletP ??= new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet"; link.href = LEAFLET.css.href; link.integrity = LEAFLET.css.integrity; link.crossOrigin = "";
    const script = document.createElement("script");
    script.src = LEAFLET.js.src; script.integrity = LEAFLET.js.integrity; script.crossOrigin = "";
    script.onload = () => resolve(globalThis.L);
    script.onerror = () => { leafletP = null; script.remove(); reject(new Error("la bibliothèque de carte n'a pas pu être chargée (réseau ou blocage)")); };
    document.head.append(link, script);
  });
  return leafletP;
}
// Une seule carte, plein écran (26/11/2026 : la carte intégrée à la vue 🥾 a été remplacée par celle-ci), ouverte par le bouton carte
// de l'écran d'accueil et par le bouton « Carte » de la vue 🥾. Fermer ramène à l'écran d'où l'on vient.
const mapState = { map: null, layer: null, sky: null, target: null, centerBtn: null };
// Lieu montré par la carte (26/11/2026 : la page principale ouvre aussi la carte, sur le lieu affiché) :
// { lat, lon, accuracy (m, ou null), here (vrai seulement pour la position actuelle de l'appareil), name, tz }.
// here : point bleu plein (+ disque de précision) et « à votre position » ; sinon anneau blanc cerclé de bleu et le nom du lieu.
const placeName = (l) => `${l.name}${l.country ? ` (${l.country})` : ""}`;
const geoTarget = () => ({ lat: geo.coords.latitude, lon: geo.coords.longitude, accuracy: geo.coords.accuracy ?? null, here: true, name: placeName(geo.data.location), tz: geo.data.location.timezone, cc: geo.cc });
// opts.saved : réglages retenus (zoom, calques, fond) ; opts.onSave(réglages) : à chaque changement ; opts.timeline : réglette des 12 heures.
// keepZoom : garder le zoom en cours (position mise à jour pendant que la carte est ouverte) ; sinon ouverture à l'échelle « lieu ».
function drawMap(L, target, { saved = null, onSave = null, timeline = false, keepZoom = false } = {}) {
  const st = mapState, box = $("home-map");
  st.target = target;
  const here = [target.lat, target.lon];
  const centerTip = target.here ? "Recentrer sur votre position" : `Recentrer sur ${target.name}`;
  if (!st.map) {
    const prefs = st.prefs = saved ?? parseMapPrefs(null);
    st.skyOn = false;
    st.map = L.map(box, { zoomControl: false, attributionControl: true, doubleClickZoom: false, minZoom: MAP_ZOOM.min, maxZoom: maxZoomFor({ topo: prefs.topo }) }).setView(here, prefs.zoomPlace);
    addDoubleTapZoom(L, st.map); // le double toucher de Leaflet ne marche pas sur iPhone (constaté le 26/11/2026)
    L.control.zoom({ zoomInTitle: "Zoom avant", zoomOutTitle: "Zoom arrière" }).addTo(st.map);
    // Recentrer sur la position (après un déplacement de la carte), sans changer le zoom.
    const center = L.control({ position: "topleft" });
    center.onAdd = () => {
      const bar = L.DomUtil.create("div", "leaflet-bar map-center"), b = L.DomUtil.create("a", "", bar);
      b.href = "#"; b.setAttribute("role", "button"); st.centerBtn = b;
      b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="2" class="dot"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
      L.DomEvent.on(b, "click", (e) => { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); st.map.setView([st.target.lat, st.target.lon], st.map.getZoom()); });
      return bar;
    };
    center.addTo(st.map);
    new ResizeObserver(() => st.map.invalidateSize()).observe(box); // la ligne d'état sous la carte change sa hauteur : le centre doit rester juste
    // Deux fonds : « Plan » (OpenStreetMap) et « Relief » (OpenTopoMap : courbes de niveau, ombrage, sentiers ; 26/11/2026, demandé).
    // OpenTopoMap (opentopomap.org/about, lu le 26/11/2026) : CC-BY-SA 3.0, attribution obligatoire (le texte ci-dessous),
    // gratuit et sans garantie ; tuiles jusqu'au zoom 17 seulement (au-delà, il renvoie « max zoom layer = 17 ») : agrandies aux zooms 18 et 19.
    const plan = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© contributeurs <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a>" });
    // Crédit raccourci (26/11/2026, demandé : 3 lignes sur iPhone) : noms, © et licence gardés, mots « Données » / « Rendu » retirés
    // (OpenTopoMap « devrait » afficher sa formule, pas « doit » ; OpenStreetMap exige son nom et le lien vers /copyright).
    const relief = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { subdomains: "abc", maxZoom: MAP_ZOOM.topoMax,
      attribution: "© <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a>, SRTM · © <a href=\"https://opentopomap.org/\">OpenTopoMap</a> (<a href=\"https://creativecommons.org/licenses/by-sa/3.0/\">CC-BY-SA</a>)" });
    let topo = prefs.topo;
    // Zoom maximal selon le mode : 10 avec Nuages ou Pluie, 17 avec le relief (le « + » se grise de lui-même).
    const applyMax = () => st.map.setMaxZoom(maxZoomFor({ sky: st.skyOn, topo }));
    (topo ? relief : plan).addTo(st.map);
    const base = L.control({ position: "topleft" });
    base.onAdd = () => {
      const bar = L.DomUtil.create("div", "leaflet-bar map-base"), b = L.DomUtil.create("a", "", bar);
      b.href = "#"; b.setAttribute("role", "button");
      const show = () => {
        const t = topo ? "Fond relief affiché (OpenTopoMap) : toucher pour revenir au plan" : "Afficher le fond relief (courbes de niveau, sentiers ; OpenTopoMap)";
        b.title = t; b.setAttribute("aria-label", "Fond relief"); b.setAttribute("aria-pressed", String(topo)); bar.classList.toggle("is-on", topo);
      };
      b.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M2.5 19.5 9 8.5l3.6 6 2.4-3.5 6.5 8.5z"/><path d="m7.2 11.6 1.8 1.4 1.6-1.6"/></svg>';
      show();
      L.DomEvent.on(b, "click", (e) => {
        L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e);
        topo = !topo;
        (topo ? relief : plan).addTo(st.map); (topo ? plan : relief).remove();
        applyMax(); // relief au zoom 18 ou 19 : la carte recule à 17 (le zoom retenu suit)
        show(); prefs.topo = topo; onSave?.(prefs);
      });
      return bar;
    };
    base.addTo(st.map);
    st.stations = createStationLayer(L, st.map, {
      getTarget: () => st.target, load: (cc) => fetchStationsForMap(cc), distanceKm, stormWords: STORM_WORDS, metarLines,
      fmtTime: (ms) => formatLocal(new Date(ms), st.target.tz, { hour: "2-digit", minute: "2-digit" }),
    });
    // Le crédit des cartes (obligatoire) change de hauteur selon le fond et la largeur (3 lignes à 375 px avec le relief) :
    // la légende des calques, en bas à gauche, se place toujours au-dessus de lui (--attrib-h, lu par styles.css).
    st.map.attributionControl.setPrefix(false); // sans « Leaflet » ni drapeau : non exigé par sa licence (BSD), place gagnée ; Leaflet reste cité dans l'aide
    const attrib = st.map.attributionControl.getContainer();
    new ResizeObserver(() => box.style.setProperty("--attrib-h", `${attrib.offsetHeight}px`)).observe(attrib);
    L.control.scale({ position: "bottomright", metric: true, imperial: false, maxWidth: 110 }).addTo(st.map); // échelle des distances, sous le crédit des cartes
    // Deux échelles retenues chacune de son côté (zoomPlace, zoomSky) ; en passant de l'une à l'autre, le centre regardé est gardé.
    // Un zoom lancé juste avant (« + », « − », pincement) peut finir APRÈS le changement d'échelle et l'annuler (constaté le
    // 26/11/2026, l'animation de Leaflet démarre à l'image suivante) : le zoom choisi est donc tenu au moins LOCK_MS et LOCK_FRAMES
    // images (une page en arrière-plan ralentit les images : le temps seul ne suffit pas).
    const LOCK_MS = 700, LOCK_FRAMES = 4;
    let switching = false, lock = null;
    const setZoomQuiet = (z) => { switching = true; st.map.setZoom(z, { animate: false }); switching = false; };
    const toScale = (sky) => {
      st.skyOn = sky;
      const z = sky ? Math.min(prefs.zoomSky, maxZoomFor({ sky: true, topo })) : Math.min(prefs.zoomPlace, maxZoomFor({ topo }));
      if (sky) { setZoomQuiet(z); switching = true; applyMax(); switching = false; } else { switching = true; applyMax(); switching = false; setZoomQuiet(z); }
      const l = lock = { zoom: z, until: Date.now() + LOCK_MS, frames: 0 };
      const tick = () => { if (lock === l && ++l.frames < LOCK_FRAMES) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    };
    st.sky = createSkyLayer(L, st.map, {
      getHere: () => ({ lat: st.target.lat, lon: st.target.lon }),
      fmtTime: (ms) => formatLocal(new Date(ms), st.target.tz, { hour: "2-digit", minute: "2-digit" }), // heures du lieu montré
      show: { clouds: false, rain: false }, // toujours éteints à l'ouverture
      onSwitch: toScale,
      timeline,
      radar: true, // radar de pluie observée (RainViewer)
    });
    st.map.on("zoomend", () => {
      if (switching) return;
      const zoom = st.map.getZoom();
      if (lock && (Date.now() < lock.until || lock.frames < LOCK_FRAMES)) { if (zoom !== lock.zoom) setZoomQuiet(lock.zoom); return; } // zoom arrivé en retard : on remet l'échelle choisie
      lock = null;
      if (st.skyOn) prefs.zoomSky = Math.min(zoom, MAP_ZOOM.skyMax); else prefs.zoomPlace = zoom;
      onSave?.(prefs);
    });
  } else { st.map.setView(here, keepZoom ? st.map.getZoom() : st.prefs.zoomPlace); st.sky?.update(); } // calques éteints à la fermeture : ouverture à l'échelle « lieu »
  st.centerBtn.title = centerTip; st.centerBtn.setAttribute("aria-label", centerTip);
  st.layer?.remove();
  st.layer = L.layerGroup(target.here
    ? [...(target.accuracy ? [L.circle(here, { radius: target.accuracy, color: "#285775", weight: 1, fillOpacity: 0.12 })] : []),
      L.circleMarker(here, { radius: 8, color: "#ffffff", weight: 3, fillColor: "#285775", fillOpacity: 1 })]
    : [L.circleMarker(here, { radius: 7, color: "#285775", weight: 3, fillColor: "#ffffff", fillOpacity: 1 })]).addTo(st.map);
  st.map.invalidateSize();
}
// « sam. 21/11 17:42 » : dernière actualisation (position + météo), à l'heure de l'appareil.
const refreshedText =(ms, tz) => formatLocal(new Date(ms), tz, { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
// Titre de la vue 🥾 : ce qu'elle montre vraiment (position de l'appareil, ou, à défaut, lieu choisi sur la page).
const MINI_TITLE = "Météo des 12 prochaines heures, à votre position";
const MINI_TITLE_FALLBACK = "Météo des 12 prochaines heures, au lieu choisi";
// Pression et sa tendance : flèche verte (hausse) ou rouge (baisse), simple trait si stable (dessinés : le caractère ↗ devient un pictogramme bleu sur iPhone), dite aussi aux lecteurs d'écran.
function showPressure(el, p) {
  el.textContent = p?.text ?? "… hPa";
  if (!p?.trend) return;
  const word = document.createElement("span");
  word.className = "sr-only"; word.textContent = `, ${TREND_WORD[p.trend.dir]}`;
  el.append(word);
  el.append(trendSign(p.trend.dir));
}
// Textes de la pression à l'heure du lieu ; la tendance arrive un peu après la mesure et complète l'affichage.
const pressureOf = (data, observed, trend = null) => pressureDisplay(data.current.pressure, observed, (ms) => formatLocal(new Date(ms), data.location.timezone, { hour: "2-digit", minute: "2-digit" }), trend);
const trendOf = (observedP) => observedP.then((o) => (o ? fetchPressureTrend(o) : null)).catch(() => null); // sans tendance : ni flèche ni aiguille dorée
function showMiniPlace(data, coords, named, pressure, at) {
  geo.shown = true;
  $("mini-title").textContent = MINI_TITLE;
  $("mini-tools").hidden = false; // baromètre et carte : seulement quand la vraie position est connue
  const pb = $("mini-pressure");
  showPressure(pb, pressure); pb.title = pressure.title;
  $("mini-baro-btn").disabled = pressure.hpa === null; // sans valeur, rien à montrer sur le cadran
  $("mini-place").replaceChildren(buildPin(), `${data.location.name}${data.location.country ? ` (${data.location.country})` : ""}`);
  // L'heure d'actualisation suit la ligne GPS ; sur téléphone, elle passe à la ligne d'un seul bloc (jamais coupée).
  const when = document.createElement("span");
  when.className = "mini-when"; when.title = "Dernière actualisation de la position et de la météo";
  when.textContent = `· actualisé ${refreshedText(at, data.location.timezone)}`; // le « · » part avec l'heure : jamais seul en fin de ligne
  $("mini-gps").replaceChildren(`GPS : ${formatCoords(coords.latitude, coords.longitude)}${coords.accuracy !== null ? ` · précision ± ${Math.round(coords.accuracy)} m` : ""}${named ? "" : " · nom du lieu indisponible"} `, when);
  $("mini-body").replaceChildren(buildMini(data, undefined, { walk: true })); // position réelle : chaque heure ouvre « Balade ? »
  $("mini-lead").textContent = "Touchez une heure pour savoir si vous pouvez partir marcher à ce moment-là.";
  // Orage OBSERVÉ par une station d'aéroport à moins de 50 km (message de moins d'une heure) : bandeau ; sinon rien.
  const st = stormText(geo.storms, (ms) => formatLocal(new Date(ms), data.location.timezone, { hour: "2-digit", minute: "2-digit" }));
  $("mini-storm").hidden = !st; $("mini-storm").textContent = st ?? "";
  // Pluie, bruine ou neige OBSERVÉE par une station à moins de 50 km (même lecture) : bandeau plus discret ; sinon rien.
  const pr = precipText(geo.precip, (ms) => formatLocal(new Date(ms), data.location.timezone, { hour: "2-digit", minute: "2-digit" }));
  $("mini-precip").hidden = !pr; $("mini-precip").textContent = pr ? `${pr} C'est une observation, pas une prévision.` : "";
}
function setHomeFlag(v) { try { localStorage.setItem(HOME_KEY, v); } catch { /* ignoré */ } }
// Position de l'appareil, puis prévision, pression et orages à cet endroit, rangés dans `geo` (vue 🥾 et écran d'accueil).
// Rend false si une autre recherche a pris le relais ; toute erreur est remontée.
async function readHere(id, onFound = () => {}) {
  const coords = await getPosition();
  if (id !== geo.loadId) return false;
  onFound();
  let named = null;
  try { named = await reverseGeocode(coords.latitude, coords.longitude); } catch { /* repli : « Position GPS » */ }
  if (id !== geo.loadId) return false;
  const place = placeFromPosition(coords, named);
  if (!place) throw new Error("coordonnées ou fuseau horaire invalides");
  // Prévision et pression mesurée (station la plus proche) en parallèle ; sans mesure, la valeur du modèle reste, marquée « ≈ ».
  // Orages observés : même lecture du réseau de stations, faite après la pression (gardée 10 min, donc sans second appel).
  const where = { latitude: coords.latitude, longitude: coords.longitude, countryCode: place.countryCode };
  const observedP = fetchObservedPressure(where).catch(() => null);
  const stormsP = observedP.then(() => fetchObservedStorms(where)).catch(() => null); // null = inconnu (rien affiché)
  const precipP = observedP.then(() => fetchObservedPrecip(where)).catch(() => null);
  const trendP = trendOf(observedP);
  const [data, observed, storms, precip] = await Promise.all([fetchForecast(place), observedP, stormsP, precipP]);
  if (id !== geo.loadId) return false;
  setHomeFlag("ok"); // position accordée : l'écran d'accueil peut s'ouvrir au lancement
  Object.assign(geo, { at: Date.now(), data, coords, named: Boolean(named), pressure: pressureOf(data, observed), storms, precip, recorded: false, cc: place.countryCode });
  trendP.then((t) => {
    if (!t || geo.data !== data) return; // une autre position a été chargée entre-temps
    geo.pressure = pressureOf(data, observed, t);
    if (geo.shown) { showPressure($("mini-pressure"), geo.pressure); $("mini-pressure").title = geo.pressure.title; }
    if (homeDlg.open) renderHome();
  });
  return true;
}
// Carnet de relevés : la prévision affichée dans la vue 🥾 est gardée sur l'appareil (une fois), pour la comparer plus tard aux observations.
function recordHere() {
  if (geo.recorded) return;
  geo.recorded = true;
  const saved = saveRecord(makeRecord(geo.data, geo.coords, { named: geo.named, at: geo.at }));
  showJournal(saved.ok ? null : "Relevé non enregistré : stockage de l'appareil plein ou bloqué.");
}
// quiet : retour dans l'application, l'ancien tableau (avec son heure d'actualisation) reste à l'écran pendant la recherche.
async function locate(force = false, { quiet = false } = {}) {
  if (!force && geo.data && Date.now() - geo.at < GEO_MAX_AGE_MS) { showMiniPlace(geo.data, geo.coords, geo.named, geo.pressure, geo.at); miniMessage(""); $("mini-map-btn").disabled = false; recordHere(); return; }
  const id = ++geo.loadId;
  $("mini-refresh").disabled = true;
  if (!quiet) {
    $("mini-map-btn").disabled = true;
    geo.shown = false;
    $("mini-title").textContent = MINI_TITLE; $("mini-tools").hidden = true; $("mini-place").textContent = ""; $("mini-gps").textContent = ""; $("mini-pressure").textContent = ""; $("mini-baro-btn").disabled = true; $("mini-lead").textContent = ""; $("mini-storm").hidden = true; $("mini-body").replaceChildren();
  }
  miniMessage(quiet ? "Mise à jour de votre position et de la météo…" : "Recherche de votre position…");
  try {
    if (!await readHere(id, () => { if (!quiet) miniMessage("Position trouvée, chargement de la météo…"); })) return;
    showMiniPlace(geo.data, geo.coords, geo.named, geo.pressure, geo.at);
    miniMessage("");
    recordHere();
    $("mini-map-btn").disabled = false;
    if ($("home-map-dlg").open && mapState.target?.here && globalThis.L) drawMap(globalThis.L, geoTarget(), { keepZoom: true }); // carte de la position ouverte (mise à jour au retour) : recentrée
  } catch (e) {
    if (id !== geo.loadId) return;
    if (quiet) { // l'ancien tableau reste, daté ; il n'est plus présenté comme étant « ici et maintenant »
      miniMessage(`Mise à jour impossible : ${e.message}${e.kind === "denied" ? ` ${deniedHelp(isIOS())}` : ""} Le tableau est celui du ${refreshedText(geo.at, geo.data.location.timezone)}, à votre position d'alors.`, "err");
      return false;
    }
    // Échec : dit pourquoi, et ne montre pas pour autant une autre ville comme si c'était la position réelle.
    miniMessage(`Position actuelle indisponible : ${e.message}${e.kind === "denied" ? ` ${deniedHelp(isIOS())}` : ""}`, "err");
    if (state.data) {
      $("mini-title").textContent = MINI_TITLE_FALLBACK;
      $("mini-place").textContent = `${state.data.location.name}${state.data.location.country ? ` (${state.data.location.country})` : ""}`;
      $("mini-gps").textContent = "Lieu choisi sur la page : ce n'est pas votre position actuelle.";
      $("mini-body").replaceChildren(buildMini(state.data));
      $("mini-lead").textContent = "";
    }
  } finally { if (id === geo.loadId) $("mini-refresh").disabled = false; }
}
// Carnet de relevés : nombre gardé sur l'appareil, et export (feuille de partage si possible, sinon téléchargement).
function showJournal(note = null) {
  const n = loadJournal().length;
  $("journal-export").disabled = n === 0;
  $("journal-info").textContent = note ?? (n ? `${n} relevé${n > 1 ? "s" : ""} gardé${n > 1 ? "s" : ""} sur cet appareil.` : "Aucun relevé gardé pour l'instant.");
}
async function exportJournal() {
  const list = loadJournal();
  if (!list.length) return showJournal();
  const at = Date.now();
  const name = exportName(at);
  const blob = new Blob([exportText(list, at)], { type: "application/json" });
  const file = typeof File === "function" ? new File([blob], name, { type: "application/json" }) : null;
  try {
    if (file && navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: name }); showJournal(`${list.length} relevé${list.length > 1 ? "s" : ""} partagé${list.length > 1 ? "s" : ""} (${name}).`); return; }
  } catch (e) {
    if (e?.name === "AbortError") return showJournal(); // partage annulé par l'utilisateur
    // autre échec du partage : repli sur le téléchargement
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  showJournal(`Fichier ${name} téléchargé (${list.length} relevé${list.length > 1 ? "s" : ""}).`);
}
// Retour ramène à l'écran d'où l'on vient (26/11/2026) : la page météo, ou l'écran d'accueil (téléphone, iPad).
let miniFrom = "page";
function setMini(open, from = "page") {
  if (open) {
    miniFrom = from;
    $("mini-close").title = from === "home" ? "Revenir à l'écran d'accueil" : "Revenir à la page météo";
  }
  document.querySelector("main.shell").hidden = open;
  $("mini").hidden = !open;
  window.scrollTo({ top: 0 });
  if (open) { showJournal(); locate(false); preloadDial(); $("mini-close").focus(); } else { geo.loadId++; $("mini-refresh").disabled = false; $("mini-open").focus(); autoRefresh(); if (miniFrom === "home") openHome("go", { asked: true }); } // fermer abandonne une recherche en cours ; la page principale a pu vieillir entre-temps
}
// Hauteur du haut de page fixe de « Lieu actuel » : les titres de colonnes se collent juste dessous.
if (typeof ResizeObserver !== "undefined") { const top = document.querySelector(".mini-top"); new ResizeObserver(() => $("mini").style.setProperty("--mini-top-h", `${top.offsetHeight}px`)).observe(top); }
const walk = initWalk({
  fallbackFocus: () => (homeDlg.open ? $("home-refresh") : $("mini-close")), // si l'heure touchée n'existe plus (tableau ou écran d'accueil redessiné), le curseur revient sur Actualiser ou Retour
  // mêmes modèles que le tableau « Lieu actuel » (selon le pays de la position)
  getHere: () => (geo.coords ? { lat: geo.coords.latitude, lon: geo.coords.longitude, models: geo.data?.metadata?.modelsRequested ?? [] } : null),
  getStorms: () => geo.storms, // orages observés par les stations (repris en tête de « Balade ? »)
  getPrecip: () => geo.precip, // pluie, bruine, neige observées (idem)
  fmtTime: (ms) => formatLocal(new Date(ms), geo.data?.location.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, { hour: "2-digit", minute: "2-digit" }),
});
// Toucher une heure du tableau : « Balade ? » pour un départ à cette heure (heure locale du lieu → instant).
$("mini-body").addEventListener("click", (e) => {
  const b = e.target.closest("button.mini-walk");
  if (!b || !geo.coords || !geo.data) return; // les heures ne sont cliquables qu'avec la vraie position (buildMini … { walk: true })
  if (b.dataset.now) { walk.openAt(null, b); return; } // première ligne (heure en cours) : « Dans l'heure »
  const at = localToMs(b.dataset.time, geo.data.location.timezone);
  if (at !== null) walk.openAt(at, b);
});
// Écran d'accueil : toucher une heure fait de même (27/11/2026) ; la première colonne est l'heure en cours.
$("home-body").addEventListener("click", (e) => {
  const b = e.target.closest("button.home-h-walk");
  if (!b || !geo.coords || !geo.data) return;
  if (b.dataset.now) { walk.openAt(null, b); return; }
  const at = localToMs(b.dataset.time, geo.data.location.timezone);
  if (at !== null) walk.openAt(at, b);
});
// Pression de l'écran d'accueil : un seul bouton, replacé à chaque dessin de l'écran.
const homeBaroBtn = Object.assign(document.createElement("button"), { type: "button", className: "home-baro", title: "Ouvrir le baromètre" });
homeBaroBtn.setAttribute("aria-haspopup", "dialog");
homeBaroBtn.innerHTML = '<svg class="mini-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#ico-baro"/></svg><span class="sr-only">Baromètre, pression : </span><span></span>';
initBarometer([
  { openBtn: $("mini-baro-btn"), getPressure: () => geo.pressure },
  { openBtn: $("place-baro-btn"), getPressure: () => state.pressure },
  { openBtn: homeBaroBtn, getPressure: () => geo.pressure },
]);
$("mini-open").addEventListener("click", () => setMini(true));
$("mini-close").addEventListener("click", () => setMini(false));
$("mini-refresh").addEventListener("click", () => locate(true));
$("mini-map-btn").addEventListener("click", () => { if (geo.coords) openMap($("mini-map-btn"), geoTarget(), (t) => miniMessage(t, "err")); });
$("journal-export").addEventListener("click", exportJournal);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("mini").hidden) setMini(false); });

// Écran d'accueil (25/11/2026) : les 4 heures à venir à la position de l'appareil, au lancement sur téléphone.
// « Toutes les prévisions » marche tout de suite : la page se charge dessous.
const homeDlg = $("home");
const home = { steps: undefined, data: null, page: 0, pageOf: null }; // steps : undefined = en cours de lecture, null = illisible ; data : prévision à laquelle ils se rapportent ; page : page des 12 heures affichée (pageOf : pour quelle prévision)
const homeTime = (ms) => formatLocal(new Date(ms), geo.data.location.timezone, { hour: "2-digit", minute: "2-digit" });
function renderHome() {
  const { data } = geo;
  $("home-place").replaceChildren(buildPin(), data.location.name);
  $("home-when").textContent = `Actualisé à ${homeTime(geo.at)}, à votre position`;
  const steps = home.data === data ? home.steps : undefined;
  showPressure(homeBaroBtn.lastElementChild, geo.pressure);
  homeBaroBtn.disabled = geo.pressure.hpa === null; // sans valeur, rien à montrer sur le cadran
  $("home-map-btn").disabled = !geo.coords;
  const baroHadFocus = document.activeElement === homeBaroBtn; // redessiner l'écran le lui ferait perdre
  const storm = stormText(geo.storms, homeTime);
  const precip = precipText(geo.precip, homeTime);
  $("home-now").replaceChildren(buildHomeNow(data, homeBaroBtn)); // bouton « icône, valeur, tendance » : ouvre le baromètre
  if (home.pageOf !== data) Object.assign(home, { page: 0, pageOf: data }); // nouvelles valeurs : retour aux 4 premières heures
  // Avertissements : les 4 premières heures seulement (leurs textes disent « dans les 4 heures »).
  $("home-body").replaceChildren(buildHome({ data, steps, page: home.page, fmtTime: homeTime, alerts: [storm, precip && `${precip} C'est une observation, pas une prévision.`, ...homeAlerts(data, (steps ?? []).slice(0, HOME_STEPS), homeTime)].filter(Boolean) }));
  wireHomePages($("home-body"), home.page, (n) => { home.page = n; });
  if (baroHadFocus) homeBaroBtn.focus();
}
// force = false : une position lue il y a moins de 10 minutes (écran d'accueil ou vue 🥾) sert telle quelle.
// asked : ouvert par la maison ; un refus de position est alors expliqué, au lieu de fermer l'écran sans un mot.
async function fillHome({ force = true, asked = false } = {}) {
  const id = ++geo.loadId, msg = $("home-msg"), btn = $("home-refresh");
  const fresh = !force && geo.data && Date.now() - geo.at < GEO_MAX_AGE_MS;
  msg.textContent = fresh ? "" : geo.data ? "Mise à jour…" : "Recherche de votre position…";
  btn.disabled = true;
  try {
    if (!fresh && !await readHere(id, () => { if (!geo.data) msg.textContent = "Chargement de la météo…"; })) return;
    const { data, coords, at } = geo;
    msg.textContent = "";
    renderHome(); preloadDial();
    if (home.data === data && home.steps) return; // pluie par quart d'heure déjà lue pour ces valeurs
    let steps = null;
    try {
      const { rows } = await fetchNextHour({ lat: coords.latitude, lon: coords.longitude, models: data.metadata.modelsRequested });
      steps = homeSteps(rows, at, HOME_STEPS * HOME_PAGES);
    } catch { /* « indisponible » affiché */ }
    if (geo.data !== data) return;
    Object.assign(home, { data, steps });
    renderHome();
  } catch (e) {
    if (id !== geo.loadId || !homeDlg.open) return;
    if (e.kind === "denied") setHomeFlag("no"); // ne plus l'ouvrir au lancement, jusqu'à ce que la position réussisse (maison, vue 🥾)
    if (e.kind === "denied" && !geo.data && !asked) { homeDlg.close(); return; } // position refusée : la page habituelle, jamais une autre ville présentée comme ici
    msg.textContent = `${geo.data ? `Mise à jour impossible (valeurs de ${homeTime(geo.at)})` : "Position ou météo indisponible"} : ${e.message}${e.kind === "denied" ? ` ${deniedHelp(isIOS())}` : ""}`;
  } finally { if (id === geo.loadId) btn.disabled = false; }
}
function openHome(mode, { asked = false } = {}) {
  homeDlg.showModal();
  home.page = 0; // chaque ouverture repart des 4 premières heures
  document.documentElement.classList.remove("home-boot"); // la page était masquée le temps d'ouvrir l'écran (index.html)
  $("home-ask").hidden = mode !== "ask"; homeDlg.classList.toggle("is-ask", mode === "ask");
  if (mode !== "ask") fillHome({ force: false, asked }); // aucun bouton n'est mis au premier plan (autofocus sur le conteneur) : Safari l'entourerait d'un gros contour
}
$("home-ask-btn").addEventListener("click", () => { $("home-ask").hidden = true; homeDlg.classList.remove("is-ask"); fillHome(); });
// Maison, entre le marcheur et le « i » : revenir à l'écran d'accueil (téléphones et iOS ; toucher la maison vaut accord pour chercher la position).
$("home-open").addEventListener("click", () => openHome("go", { asked: true }));
$("home-all").addEventListener("click", () => {
  if (homeDlg.classList.contains("is-ask")) setHomeFlag("no"); // invitation déclinée : elle ne revient pas
  homeDlg.close();
});
$("home-mini").addEventListener("click", () => { homeDlg.close(); setMini(true, "home"); });
$("home-refresh").addEventListener("click", () => fillHome());
// Carte plein écran : Leaflet chargé au premier toucher, carte créée une fois (après l'ouverture : il lui faut sa taille), recentrée à chaque ouverture.
// Zoom et fond (plan ou relief) retenus sur l'appareil (meteo.map) ; au départ, zone d'environ 200 km, plan.
// Nuages et pluie éteints à chaque ouverture (demandé le 26/11/2026).
const MAP_KEY = "meteo.map";
function readMapPrefs() { try { return parseMapPrefs(localStorage.getItem(MAP_KEY)); } catch { return parseMapPrefs(null); } }
const saveMapPrefs = (p) => { try { localStorage.setItem(MAP_KEY, JSON.stringify({ zoomPlace: p.zoomPlace, zoomSky: p.zoomSky, topo: p.topo === true })); } catch { /* ignoré */ } };
const homeMapDlg = $("home-map-dlg");
// btn : bouton qui ouvre la carte (désactivé pendant le chargement, puis rendu tel qu'il était) ; target : lieu montré (voir drawMap) ;
// fail(texte) : où dire que la carte est indisponible. Titre : « à votre position » seulement pour la position actuelle, sinon le nom du lieu.
async function openMap(btn, target, fail) {
  const was = btn.disabled;
  btn.disabled = true;
  try {
    const L = await loadLeaflet();
    const where = target.here ? "à votre position" : target.name;
    $("home-map-title").querySelector("span").textContent = `· ${where}`;
    $("home-map").setAttribute("aria-label", target.here ? "Carte de votre position" : `Carte : ${target.name}`);
    homeMapDlg.showModal();
    drawMap(L, target, { saved: readMapPrefs(), onSave: saveMapPrefs, timeline: true });
  } catch (e) { fail(`Carte indisponible : ${e.message}`); }
  finally { btn.disabled = was; }
}
$("home-map-btn").addEventListener("click", () => { if (geo.coords) openMap($("home-map-btn"), geoTarget(), (t) => { $("home-msg").textContent = t; }); });
// Page principale : carte du lieu affiché. « Ma position » réellement trouvée (comme l'épingle rouge : sans « dernière position
// connue ») = votre position, avec les coordonnées précises gardées en mémoire (state.posCoords, jamais stockées) ; sinon le lieu.
function pageTarget() {
  const p = state.place, d = state.data;
  if (!p || !d) return null;
  const here = p.id === GEO_ID && !state.note, c = here ? state.posCoords : null;
  return { lat: c?.latitude ?? p.latitude, lon: c?.longitude ?? p.longitude, accuracy: c?.accuracy ?? null, here, name: placeName(d.location), tz: d.location.timezone, cc: p.countryCode };
}
$("place-map-btn").addEventListener("click", () => { const t = pageTarget(); if (t) openMap($("place-map-btn"), t, (m) => setStatus(m, "err")); });
$("home-map-close").addEventListener("click", () => homeMapDlg.close());
// Fermer ou Échap : la lecture des heures s'arrête et les calques s'éteignent (la carte se rouvre toujours sans nuages ni pluie).
homeMapDlg.addEventListener("close", () => { mapState.sky?.pause(); mapState.sky?.off(); mapState.stations?.off(); });
const homeHelpDlg = $("home-help");
$("home-info").addEventListener("click", () => {
  const { data } = geo;
  const { sections, notes } = homeLegend(data, home.data === data ? home.steps : null);
  $("home-legend").replaceChildren(buildLegend(sections));
  $("home-notes").replaceChildren(...notes.map(([what, text]) => {
    const li = document.createElement("li"), b = document.createElement("strong");
    b.textContent = what; li.append(b, ` : ${text}`);
    return li;
  }));
  $("home-more").open = false; // toujours replié à l'ouverture
  homeHelpDlg.showModal();
  homeHelpDlg.querySelector(".modal-body").scrollTop = 0;
});
$("home-help-close").addEventListener("click", () => homeHelpDlg.close());
homeHelpDlg.addEventListener("click", (e) => { // clic sur le voile seulement (même règle que les autres fenêtres)
  if (e.target !== homeHelpDlg) return;
  const r = homeHelpDlg.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) homeHelpDlg.close();
});

// Pastille rouge d'un jour : fenêtre d'explication (un seul écouteur, les lignes étant redessinées à chaque changement d'onglet).
const extremeDlg = $("extreme");
$("content").addEventListener("click", (e) => {
  const btn = e.target.closest(".day-alert");
  const day = btn && state.data?.daily.find((d) => d.date === btn.dataset.date);
  const info = day && extremeText(day, state.tab);
  if (!info) return;
  $("extreme-title").textContent = info.title;
  $("extreme-lines").replaceChildren(...info.lines.map((l) => {
    const p = document.createElement("p"), b = document.createElement("strong");
    b.textContent = l.value; p.append(b, ` ${l.rule}`);
    return p;
  }));
  $("extreme-note").textContent = info.note;
  const src = officialSource(state.place);
  $("extreme-links").replaceChildren(...[src, src.extra].filter(Boolean).map((s) => {
    const a = document.createElement("a");
    a.href = s.url; a.rel = "noopener"; a.textContent = s.name;
    return a;
  }));
  extremeDlg.showModal();
});
$("extreme-close").addEventListener("click", () => extremeDlg.close());
extremeDlg.addEventListener("click", (e) => { // clic sur le voile seulement (même règle que les autres fenêtres)
  if (e.target !== extremeDlg) return;
  const r = extremeDlg.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) extremeDlg.close();
});

// Vigilances et sources : redessinés ensemble, car les sources citent ECCC si ses alertes sont affichées.
function renderWarnings() {
  if (!state.data) return;
  $("warnings").replaceChildren(buildWarnings(state.data, state.warnings));
  const st = warningsStatus(state.data, state.warnings);
  $("warnings-status").textContent = st.text;
  $("warnings-status").classList.toggle("is-alert", st.alert);
  $("sources").replaceChildren(buildSources(state.data, state.warnings, state.ensemble));
  $("attribution").replaceChildren(buildAttribution(state.data, state.warnings, state.ensemble));
}

// Pression du lieu affiché (bouton sous Actualiser) ; null = mesure en cours de lecture, jamais la pression du lieu précédent.
function renderPressure() {
  const btn = $("place-baro-btn"), p = state.pressure;
  btn.hidden = !state.data;
  btn.disabled = typeof p?.hpa !== "number";
  btn.title = p?.title ?? "Lecture de la pression…";
  showPressure($("place-pressure"), p);
  // Rappel discret, non cliquable, à droite du lever et du coucher du soleil : même valeur que le bouton.
  const sun = $("current").querySelector(".cur-sun");
  if (sun) {
    let el = sun.querySelector(".cur-pressure");
    if (!el) {
      el = document.createElement("span");
      el.className = "cur-pressure"; el.innerHTML = '<span class="sr-only">Pression : </span><span></span>';
      sun.append(el);
    }
    el.title = btn.title;
    showPressure(el.lastElementChild, p);
  }
  if (!btn.disabled) preloadDial();
}

// Données périmées ou premier jour ≠ aujourd'hui : signalé, jamais masqué.
function updateFreshness() {
  const d = state.data;
  if (!d || state.loading) return;
  const age = Date.now() - new Date(d.metadata.fetchedAt).getTime();
  if (d.daily[0]?.date !== localDateISO(new Date(), d.location.timezone)) setStatus("Ces données ne commencent plus à la date locale d'aujourd'hui : actualisez.", "warn");
  else if (age > STALE_MS) setStatus(`Données récupérées il y a ${Math.round(age / 60000)} min : actualisez pour les mettre à jour.`, "warn");
  else setStatus(state.note?.text ?? "", state.note?.kind ?? ""); // message propre au lieu affiché (ex. « dernière position connue »)
}

// note : message affiché après un chargement réussi (ex. « dernière position connue »), au lieu de vider la zone d'état.
// quiet : retour dans l'application. Les anciennes valeurs restent à l'écran, sans fenêtre de chargement, jusqu'à ce que tout soit arrivé.
// Rend true (affiché), false (échec, dit à l'écran) ou undefined (un autre chargement a pris le relais).
async function load(place, { note = "", kind = "", quiet = false } = {}) {
  const id = ++state.loadId;
  state.loading = true;
  setStatus(quiet ? "Mise à jour des prévisions…" : "Chargement…");
  // Vigilance en parallèle : n'attend pas la météo et ne la bloque pas (loadWarnings ne lève jamais).
  if (!quiet) loader.start(place.name);
  const warningsP = loadWarnings(place);
  const observedP = fetchObservedPressure(place).catch(() => null); // pression mesurée : n'attend pas la météo et ne la bloque pas
  const trendP = trendOf(observedP);
  try {
    const data = await fetchForecast(place);
    if (id !== state.loadId) return; // un lieu plus récent a été demandé entre-temps
    loader.done("forecast");
    loader.begin("ensemble");
    // Scénarios d'ensemble (J+4 à J+14) : chargés après la prévision, sans bloquer son affichage (sauf retour discret : tout d'un coup).
    const ensembleP = fetchEnsemble(place, data.daily.map((d) => d.date));
    if (quiet) {
      await Promise.race([Promise.allSettled([warningsP, trendP, ensembleP]), new Promise((r) => setTimeout(r, QUIET_WAIT_MS))]);
      if (id !== state.loadId) return;
    }
    const focusId = document.activeElement?.id; // redessiner les onglets leur ferait perdre le curseur
    state.place = place; state.data = data; state.warnings = null; state.ensemble = undefined; state.pressure = null; state.loading = false;
    state.note = note ? { text: note, kind } : null; // reste affiché tant que ces données sont à l'écran (renderAll → état « périmé »)
    renderAll();
    renderPressure();
    if (quiet && focusId && document.activeElement === document.body) document.getElementById(focusId)?.focus({ preventScroll: true });
    observedP.then((o) => {
      if (id !== state.loadId) return;
      state.pressure = pressureOf(data, o);
      renderPressure();
      trendP.then((t) => { if (t && id === state.loadId) { state.pressure = pressureOf(data, o, t); renderPressure(); } });
    });
    warningsP.then((w) => { if (id === state.loadId) { state.warnings = w; renderWarnings(); loader.done("warnings", true); } });
    ensembleP.then((e) => {
      if (id !== state.loadId) return;
      state.ensemble = e; renderTabbed(); renderWarnings();
      loader.done("ensemble", e.status === "ok");
    });
    return true;
  } catch (e) {
    if (id !== state.loadId) return;
    loader.fail(); // l'erreur est affichée ci-dessous : la fenêtre de chargement se ferme
    state.loading = false;
    // L'erreur reste visible ; les anciennes données éventuelles restent affichées mais signalées.
    setStatus(`Impossible de récupérer la météo (${e.kind ?? "erreur"}) : ${e.message}.${state.data ? ` Les données affichées (${state.data.location.name}) sont celles de la dernière consultation réussie.` : ""}`, "err");
    return false;
  }
}

const select = $("place");
// « Ma position » en tête de liste : toute la page (24 h, 7 et 15 jours) à la position réelle de l'appareil.
const POSITION_LABEL = "📍 Ma position";
select.add(new Option(POSITION_LABEL, GEO_ID));
const setPositionLabel = (place) => { const o = select.querySelector(`option[value="${GEO_ID}"]`); if (o) o.text = place ? `${POSITION_LABEL} (${place.name})` : POSITION_LABEL; };
for (const p of FAVORITES) select.add(new Option(`${p.name} (${p.country})`, p.id));

// Lieu libre : une option dédiée dans le sélecteur ; aucune requête météo tant que le bouton n'est pas validé.
function setCustomPlace(place) {
  state.customPlace = place;
  select.querySelector(`option[value="${CUSTOM_ID}"]`)?.remove();
  select.add(new Option(placeLabel(place), CUSTOM_ID));
  select.value = CUSTOM_ID;
}
const initial = readLastPlace();
const storedCustom = readCustomPlace(); // toujours remis en bas de liste, même s'il n'était pas le dernier lieu affiché
if (storedCustom) setCustomPlace(storedCustom);
select.value = initial.id;

// Choisir un lieu dans la liste suffit à le valider : la météo se charge aussitôt (choix de l'utilisateur, 22/11/2026, écart avec le
// cahier v1.1 qui demandait un bouton « Afficher la météo »). Petit délai : si l'on fait défiler la liste fermée au clavier
// (une flèche = un changement), seul le dernier lieu est chargé.
// Position réelle de l'appareil pour la page principale. Échec : le motif est affiché ; avec une position déjà connue, celle-ci est
// montrée en le disant (« dernière position connue ») ; sans, le lieu affiché ne change pas : jamais une autre ville présentée comme ici.
let posSeq = 0;
async function showPosition({ quiet = false } = {}) {
  const seq = ++posSeq;
  state.searching++;
  const stillWanted = () => seq === posSeq && select.value === GEO_ID;
  setStatus("Recherche de votre position…");
  try {
    const coords = await getPosition();
    if (!stillWanted()) return;
    state.posCoords = coords; // précises, en mémoire seulement : pour la carte (le lieu gardé est arrondi à 0,01°)
    let named = null;
    try { named = await reverseGeocode(coords.latitude, coords.longitude); } catch { /* repli : « Position GPS » */ }
    if (!stillWanted()) return;
    const place = placeFromPosition(coords, named);
    if (!place) throw new Error("coordonnées ou fuseau horaire invalides");
    const stamped = { ...place, at: Date.now() };
    setPositionLabel(stamped);
    saveLastPlace(stamped);
    return await load(stamped, { quiet });
  } catch (e) {
    if (!stillWanted()) return;
    const why = `Position indisponible : ${e.message}${e.kind === "denied" ? ` ${deniedHelp(isIOS())}` : ""}`;
    const stored = readStoredPosition();
    if (stored) {
      setPositionLabel(stored);
      const when = stored.at ? ` (${formatLocal(new Date(stored.at), Intl.DateTimeFormat().resolvedOptions().timeZone, { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })})` : "";
      // l'essentiel d'abord (ce qui est affiché), puis le motif et l'aide
      return await load(stored, { note: `Dernière position connue${when}, qui n'est peut-être plus la vôtre. ${why}`, kind: "warn", quiet });
    } else {
      const back = state.place ?? readLastPlaceOrDefault();
      select.value = back.id === GEO_ID ? DEFAULT_PLACE.id : back.id;
      setStatus(`${why} Le lieu affiché n'a pas changé.`, "err");
      if (!state.data) load(back.id === GEO_ID ? DEFAULT_PLACE : back);
    }
  } finally { state.searching--; }
}
const readLastPlaceOrDefault = () => { const p = readLastPlace(); return p.id === GEO_ID ? DEFAULT_PLACE : p; };

const CHANGE_DELAY_MS = 400;
let changeTimer = null;
const selectedPlace = () => (select.value === CUSTOM_ID ? state.customPlace : FAVORITES.find((p) => p.id === select.value));
function showSelected() {
  clearTimeout(changeTimer);
  if (select.value === GEO_ID) { showPosition(); return; }
  posSeq++; // une recherche de position en cours est abandonnée
  const place = selectedPlace();
  if (!place) return;
  saveLastPlace(place);
  load(place);
}
select.addEventListener("change", () => { clearTimeout(changeTimer); changeTimer = setTimeout(showSelected, CHANGE_DELAY_MS); });
$("form").addEventListener("submit", (ev) => { ev.preventDefault(); showSelected(); }); // Entrée dans le formulaire : tout de suite

// À l'ouverture de « Autre lieu », le curseur va directement dans le champ de saisie.
foldTip($("other"), "la recherche d'une ville");
foldTip($("baro-more"), "les explications");
foldTip($("home-more"), "les modèles et les sources");
$("other").addEventListener("toggle", () => { if ($("other").open) $("q").focus(); });

// Recherche d'un autre lieu : géocodage, liste complète des homonymes, choix explicite.
$("search").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const msg = $("search-msg"), list = $("results"), btn = ev.submitter ?? $("search").querySelector("button");
  list.replaceChildren();
  btn.disabled = true; msg.textContent = "Recherche…";
  try {
    const found = await searchPlaces($("q").value);
    msg.textContent = found.length ? `${found.length} résultat(s) : choisissez le bon lieu.` : "Aucun lieu trouvé. Vérifiez l'orthographe.";
    for (const p of found) {
      const li = document.createElement("li"), b = document.createElement("button");
      b.type = "button"; b.textContent = placeLabel(p);
      const sub = document.createElement("span"); sub.className = "sub";
      sub.textContent = `${p.latitude.toFixed(2)}, ${p.longitude.toFixed(2)} · ${p.timezone}${p.elevation !== null ? ` · ${Math.round(p.elevation)} m` : ""}`;
      b.append(sub);
      // Toucher un résultat = choisir ce lieu : la météo s'affiche, la recherche se referme.
      b.addEventListener("click", () => {
        setCustomPlace(p);
        list.replaceChildren();
        msg.textContent = "";
        $("other").open = false;
        select.focus();
        showSelected();
      });
      li.append(b); list.append(li);
    }
  } catch (e) {
    msg.textContent = e.message;
  } finally { btn.disabled = false; }
});
$("refresh").addEventListener("click", () => { if (select.value === GEO_ID) showPosition(); else if (state.place) load(state.place); }); // « Ma position » : la position est recherchée à nouveau
// Retour dans l'application (icône de l'écran d'accueil, changement d'onglet, appareil réveillé) : des prévisions périmées sont relues
// d'elles-mêmes ; en attendant, les anciennes restent affichées. Vue 🥾 ouverte : c'est elle qui est relue (position comprise).
const lastAutoTry = { page: null, mini: null };
async function autoRefresh({ retry = true } = {}) {
  if (document.hidden) return;
  if (homeDlg.open && geo.data && Date.now() - geo.at >= GEO_MAX_AGE_MS) fillHome(); // écran d'accueil resté ouvert : relu lui aussi
  const now = Date.now(), view = $("mini").hidden ? "page" : "mini", lastTryMs = retry ? lastAutoTry[view] : null;
  let ok;
  if (view === "mini") {
    const busy = !geo.shown || $("mini-refresh").disabled; // rien à garder à l'écran, ou recherche déjà en cours
    if (busy || now - geo.at < GEO_MAX_AGE_MS || (lastTryMs !== null && now - lastTryMs < TRY_GAP_MS)) return;
    lastAutoTry.mini = now;
    ok = await locate(true, { quiet: true });
  } else {
    const d = state.data;
    const due = shouldRefresh({
      hasData: Boolean(d), busy: state.loading || state.searching > 0, lastTryMs, now,
      fetchedAtMs: Date.parse(d?.metadata.fetchedAt), firstDay: d?.daily[0]?.date, today: d ? localDateISO(new Date(now), d.location.timezone) : null,
    });
    if (!due) { if ($("status").className !== "err") updateFreshness(); return; } // une erreur affichée reste lisible
    lastAutoTry.page = now;
    if (select.value === GEO_ID) ok = await showPosition({ quiet: Boolean(d) });
    else {
      const place = selectedPlace() ?? state.place; // le lieu de la liste, même si son premier chargement avait échoué
      if (place) ok = await load(place, { quiet: Boolean(d) && place.id === state.place?.id });
    }
  }
  if (ok === false && retry) setTimeout(() => autoRefresh({ retry: false }), RETRY_MS);
}
document.addEventListener("visibilitychange", () => autoRefresh());
window.addEventListener("pageshow", (e) => { if (e.persisted) autoRefresh(); }); // page ressortie de la mémoire du navigateur

// Vue compacte (par défaut : 7 jours dans un pavé, jours 8 à 15 repliés) ou détaillée. Le choix est retenu sur l'appareil.
const VIEW_KEY = "meteo.view";
function applyView() {
  const compact = state.view === "compact";
  $("detail-only").hidden = compact; // situation et 24 h restent visibles dans les deux vues (condensées en compact)
  $("compact-only").hidden = !compact;
  $("content").classList.toggle("is-compact", compact);
  // Le petit déroulant montre l'icône de la vue en cours.
  $("view-select").value = state.view;
  $("view-pick").dataset.view = state.view;
}
function setView(view) {
  if (state.view === view) return;
  state.view = view;
  try { localStorage.setItem(VIEW_KEY, state.view); } catch { /* ignoré */ }
  applyView();
  window.scrollTo({ top: 0 });
}
{
  // Choix mémorisé s'il existe ; sinon vue compacte.
  let stored = null;
  try { stored = localStorage.getItem(VIEW_KEY); } catch { /* stockage indisponible : vue par défaut */ }
  state.view = chooseView(stored, isIOS());
  // iOS : vue compacte seulement ; le déroulant disparaît et la ligne du haut se partage entre le lieu et la situation.
  $("view-pick").hidden = isIOS();
  document.querySelector(".top-row").classList.toggle("no-view-pick", isIOS());
}
{
  const ul = document.createElement("ul");
  for (const t of COMPACT_HELP_ITEMS) { const li = document.createElement("li"); li.textContent = t; ul.append(li); }
  $("compact-help").replaceChildren(ul);
}
// Sections repliables (bouton à flèche seule) : l'infobulle dit ce que fera le clic, selon l'état.
for (const d of document.querySelectorAll("details.fold")) {
  foldTip(d, `« ${(d.querySelector("h2 .h2-main") ?? d.querySelector("h2")).textContent.trim()} »`);
}
$("view-select").addEventListener("change", () => setView($("view-select").value));
$("compact-info-btn").addEventListener("click", () => {
  const open = $("compact-help").hidden; // hidden = fermé : un clic l'ouvre
  $("compact-help").hidden = !open;
  $("compact-info-btn").setAttribute("aria-expanded", String(open));
});
applyView();

try { localStorage.removeItem("meteo.theme"); } catch { /* ignoré */ }
initInfo();

{
  let flag = null;
  try { flag = localStorage.getItem(HOME_KEY); } catch { /* stockage indisponible */ }
  const forced = new URLSearchParams(location.search).has("accueil"), mobile = matchMedia(PHONE_QUERY).matches || isIOS();
  $("home-open").hidden = !mobile && !forced;
  const mode = homeMode({
    forced, mobile, flag,
    used: lastPlaceId() === GEO_ID || Boolean(readStoredPosition()) || loadJournal().length > 0,
  });
  if (mode !== "none") openHome(mode);
  document.documentElement.classList.remove("home-boot");
}
// Premier lancement : lieu mémorisé (Bar-le-Duc par défaut).
if (lastPlaceId() === GEO_ID) { select.value = GEO_ID; setPositionLabel(readStoredPosition()); showPosition(); } else load(readLastPlace());
