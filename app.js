// Orchestration : lieu, un appel réseau par validation, onglets qui re-rendent sans appel réseau.
import { FAVORITES, DEFAULT_PLACE, CUSTOM_ID, searchPlaces, validatePlace, placeLabel } from "./places.js?v=521daa6a";
import { fetchForecast, localDateISO } from "./weather-provider.js?v=631084d1";
import { loadWarnings } from "./warnings.js?v=79a17bd6";
import { fetchEnsemble } from "./ensemble.js?v=88c38ccc";
import { initInfo } from "./info.js?v=0231d5ac";
import { initBarometer, preloadDial } from "./barometer.js?v=c389d0e2";
import { createSkyLayer } from "./skymap.js?v=490696b3";
import { initWalk } from "./walkui.js?v=2b16ce77";
import { localToMs } from "./walk.js?v=68874bb7";
import { fetchObservedPressure, fetchPressureTrend, fetchObservedStorms, stormText, pressureDisplay, TREND_WORD } from "./observation.js?v=25a46dff";
import { getPosition, reverseGeocode, placeFromPosition, storedGeoPlace, formatCoords, deniedHelp, GEO_ID, GEO_MAX_AGE_MS } from "./geo.js?v=b6df63a8";
import { shouldRefresh, STALE_MS, TRY_GAP_MS, RETRY_MS, QUIET_WAIT_MS } from "./refresh.js?v=beadd3fe";
import { createLoader } from "./loading.js?v=956b591b";
import { makeRecord, saveRecord, loadJournal, exportText, exportName } from "./journal.js?v=5a6c3eb3";
import { chooseView, DEFAULT_VIEW, isIOS } from "./device.js?v=fddeae53";
import { TABS, foldTip, buildPin, buildTopPlace, buildTopNow, buildCurrent, buildHourly, buildWeek, buildTrend, buildCompact, buildMini, COMPACT_HELP_ITEMS, buildSources, buildWarnings, buildAttribution, warningsStatus, formatLocal } from "./weather-render.js?v=bec4d6dd";

const $ = (id) => {
  const el = document.getElementById(id);
  // Un élément absent signale presque toujours des fichiers publiés de versions différentes (index.html ancien avec app.js récent, par exemple).
  if (!el) throw new Error(`élément « #${id} » introuvable : les fichiers du site ne sont pas tous de la même version (republiez-les tous, puis rechargez avec Cmd+Maj+R)`);
  return el;
};
const PLACE_KEY = "meteo.lastPlace", CUSTOM_KEY = "meteo.customPlace", POSITION_KEY = "meteo.position", TAB_DEFAULT = "precip";

const loader = createLoader($("loader"));
const state = { place: null, data: null, warnings: null, ensemble: undefined, pressure: null, view: DEFAULT_VIEW, tab: TAB_DEFAULT, loading: false, searching: 0, loadId: 0 };

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
  updateFreshness();
}

// Vue minimale : les prochaines heures à la position réelle de l'appareil ; remplace la page tant qu'elle est ouverte.
// La position n'est jamais stockée (mémoire seulement) ; la prévision est celle de la position, pas du lieu choisi dans la liste.
const geo = { at: 0, shown: false, data: null, coords: null, named: true, pressure: null, storms: null, loadId: 0 };
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
const mapState = { map: null, layer: null, sky: null };
function setMapButton(open) { // l'icône reste : seul le libellé change
  $("mini-map-btn").setAttribute("aria-expanded", String(open));
  $("mini-map-label").textContent = open ? "Masquer la carte" : "Carte";
}
function drawMap(L) {
  const { latitude, longitude, accuracy } = geo.coords;
  const here = [latitude, longitude];
  if (!mapState.map) {
    mapState.map = L.map($("mini-map"), { zoomControl: false, attributionControl: true }).setView(here, 15);
    L.control.zoom({ zoomInTitle: "Zoom avant", zoomOutTitle: "Zoom arrière" }).addTo(mapState.map);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© contributeurs <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a>" }).addTo(mapState.map);
    L.control.scale({ position: "bottomright", metric: true, imperial: false, maxWidth: 110 }).addTo(mapState.map); // échelle des distances, sous le crédit des cartes
    mapState.sky = createSkyLayer(L, mapState.map, {
      getHere: () => ({ lat: geo.coords.latitude, lon: geo.coords.longitude }),
      fmtTime: (ms) => formatLocal(new Date(ms), geo.data.location.timezone, { hour: "2-digit", minute: "2-digit" }),
    });
  } else { mapState.map.setView(here, mapState.map.getZoom()); mapState.sky?.update(); }
  mapState.layer?.remove();
  mapState.layer = L.layerGroup([
    ...(accuracy ? [L.circle(here, { radius: accuracy, color: "#285775", weight: 1, fillOpacity: 0.12 })] : []),
    L.circleMarker(here, { radius: 8, color: "#ffffff", weight: 3, fillColor: "#285775", fillOpacity: 1 }),
  ]).addTo(mapState.map);
  mapState.map.invalidateSize();
}
async function toggleMap() {
  const wrap = $("mini-map-wrap"), btn = $("mini-map-btn");
  if (!wrap.hidden) { wrap.hidden = true; setMapButton(false); return; }
  if (!geo.coords) return;
  wrap.hidden = false; setMapButton(true); btn.disabled = true;
  try { drawMap(await loadLeaflet()); }
  catch (e) { wrap.hidden = true; setMapButton(false); miniMessage(`Carte indisponible : ${e.message}`, "err"); }
  finally { btn.disabled = !geo.coords; }
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
  el.insertAdjacentHTML("beforeend", '<svg class="trend-arrow" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path/></svg>');
  el.lastElementChild.classList.add(`is-${p.trend.dir}`);
  el.lastElementChild.firstElementChild.setAttribute("d", p.trend.dir === "steady" ? "M3 8h10" : "M2 8h12M9 3l5 5-5 5");
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
}
// quiet : retour dans l'application, l'ancien tableau (avec son heure d'actualisation) reste à l'écran pendant la recherche.
async function locate(force = false, { quiet = false } = {}) {
  if (!force && geo.data && Date.now() - geo.at < GEO_MAX_AGE_MS) { showMiniPlace(geo.data, geo.coords, geo.named, geo.pressure, geo.at); miniMessage(""); $("mini-map-btn").disabled = false; return; }
  const id = ++geo.loadId;
  $("mini-refresh").disabled = true;
  if (!quiet) {
    $("mini-map-btn").disabled = true;
    geo.shown = false;
    $("mini-title").textContent = MINI_TITLE; $("mini-tools").hidden = true; $("mini-place").textContent = ""; $("mini-gps").textContent = ""; $("mini-pressure").textContent = ""; $("mini-baro-btn").disabled = true; $("mini-lead").textContent = ""; $("mini-storm").hidden = true; $("mini-body").replaceChildren();
  }
  miniMessage(quiet ? "Mise à jour de votre position et de la météo…" : "Recherche de votre position…");
  try {
    const coords = await getPosition();
    if (id !== geo.loadId) return;
    if (!quiet) miniMessage("Position trouvée, chargement de la météo…");
    let named = null;
    try { named = await reverseGeocode(coords.latitude, coords.longitude); } catch { /* repli : « Position GPS » */ }
    if (id !== geo.loadId) return;
    const place = placeFromPosition(coords, named);
    if (!place) throw new Error("coordonnées ou fuseau horaire invalides");
    // Prévision et pression mesurée (station la plus proche) en parallèle ; sans mesure, la valeur du modèle reste, marquée « ≈ ».
    // Orages observés : même lecture du réseau de stations, faite après la pression (gardée 10 min, donc sans second appel).
    const where = { latitude: coords.latitude, longitude: coords.longitude, countryCode: place.countryCode };
    const observedP = fetchObservedPressure(where).catch(() => null);
    const stormsP = observedP.then(() => fetchObservedStorms(where)).catch(() => null); // null = inconnu (rien affiché)
    const trendP = trendOf(observedP);
    const [data, observed, storms] = await Promise.all([fetchForecast(place), observedP, stormsP]);
    if (id !== geo.loadId) return;
    const pressure = pressureOf(data, observed);
    Object.assign(geo, { at: Date.now(), data, coords, named: Boolean(named), pressure, storms });
    showMiniPlace(data, coords, Boolean(named), pressure, geo.at);
    miniMessage("");
    trendP.then((t) => {
      if (!t || geo.data !== data) return; // une autre position a été chargée entre-temps
      geo.pressure = pressureOf(data, observed, t);
      if (geo.shown) { showPressure($("mini-pressure"), geo.pressure); $("mini-pressure").title = geo.pressure.title; }
    });
    // Carnet de relevés : la prévision affichée est gardée sur l'appareil, pour la comparer plus tard aux observations.
    const saved = saveRecord(makeRecord(data, coords, { named: Boolean(named), at: geo.at }));
    showJournal(saved.ok ? null : "Relevé non enregistré : stockage de l'appareil plein ou bloqué.");
    $("mini-map-btn").disabled = false;
    if (!$("mini-map-wrap").hidden && globalThis.L) drawMap(globalThis.L); // carte ouverte : recentrée sur la nouvelle position
  } catch (e) {
    if (id !== geo.loadId) return;
    if (quiet) { // l'ancien tableau reste, daté ; il n'est plus présenté comme étant « ici et maintenant »
      miniMessage(`Mise à jour impossible : ${e.message}${e.kind === "denied" ? ` ${deniedHelp(isIOS())}` : ""} Le tableau est celui du ${refreshedText(geo.at, geo.data.location.timezone)}, à votre position d'alors.`, "err");
      return false;
    }
    // Échec : dit pourquoi, et ne montre pas pour autant une autre ville comme si c'était la position réelle.
    $("mini-map-wrap").hidden = true; setMapButton(false);
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
function setMini(open) {
  document.querySelector("main.shell").hidden = open;
  $("mini").hidden = !open;
  window.scrollTo({ top: 0 });
  if (open) { showJournal(); locate(false); preloadDial(); $("mini-close").focus(); } else { geo.loadId++; $("mini-refresh").disabled = false; $("mini-open").focus(); autoRefresh(); } // fermer abandonne une recherche en cours ; la page principale a pu vieillir entre-temps
}
// Hauteur du haut de page fixe de « Lieu actuel » : les titres de colonnes se collent juste dessous.
if (typeof ResizeObserver !== "undefined") { const top = document.querySelector(".mini-top"); new ResizeObserver(() => $("mini").style.setProperty("--mini-top-h", `${top.offsetHeight}px`)).observe(top); }
const walk = initWalk({
  fallbackFocus: () => $("mini-close"), // si l'heure touchée n'existe plus (tableau redessiné), le curseur revient sur Retour
  // mêmes modèles que le tableau « Lieu actuel » (selon le pays de la position)
  getHere: () => (geo.coords ? { lat: geo.coords.latitude, lon: geo.coords.longitude, models: geo.data?.metadata?.modelsRequested ?? [] } : null),
  getStorms: () => geo.storms, // orages observés par les stations (repris en tête de « Balade ? »)
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
initBarometer([
  { openBtn: $("mini-baro-btn"), getPressure: () => geo.pressure },
  { openBtn: $("place-baro-btn"), getPressure: () => state.pressure },
]);
$("mini-open").addEventListener("click", () => setMini(true));
$("mini-close").addEventListener("click", () => setMini(false));
$("mini-refresh").addEventListener("click", () => locate(true));
$("mini-map-btn").addEventListener("click", toggleMap);
$("journal-export").addEventListener("click", exportJournal);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("mini").hidden) setMini(false); });

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
  state.view = chooseView(stored);
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

// Premier lancement : lieu mémorisé (Bar-le-Duc par défaut).
if (lastPlaceId() === GEO_ID) { select.value = GEO_ID; setPositionLabel(readStoredPosition()); showPosition(); } else load(readLastPlace());
