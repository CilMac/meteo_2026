// Orchestration : lieu, un appel réseau par validation, onglets qui re-rendent sans appel réseau.
import { FAVORITES, DEFAULT_PLACE, CUSTOM_ID, searchPlaces, validatePlace, placeLabel } from "./places.js";
import { fetchForecast } from "./weather-provider.js";
import { loadWarnings } from "./warnings.js";
import { fetchEnsemble } from "./ensemble.js";
import { initInfo } from "./info.js";
import { initBarometer, preloadDial } from "./barometer.js";
import { createSkyLayer } from "./skymap.js";
import { initWalk } from "./walkui.js";
import { fetchObservedPressure, pressureDisplay } from "./observation.js";
import { getPosition, reverseGeocode, placeFromPosition, formatCoords, deniedHelp, GEO_MAX_AGE_MS } from "./geo.js";
import { createLoader } from "./loading.js";
import { chooseView, isIOS } from "./device.js";
import { TABS, buildTopPlace, buildTopNow, buildCurrent, buildHourly, buildWeek, buildTrend, buildCompact, buildMini, COMPACT_HELP_ITEMS, buildSources, buildWarnings, buildAttribution, warningsStatus, formatLocal } from "./weather-render.js";

const $ = (id) => {
  const el = document.getElementById(id);
  // Un élément absent signale presque toujours des fichiers publiés de versions différentes (index.html ancien avec app.js récent, par exemple).
  if (!el) throw new Error(`élément « #${id} » introuvable : les fichiers du site ne sont pas tous de la même version (republiez-les tous, puis rechargez avec Cmd+Maj+R)`);
  return el;
};
const PLACE_KEY = "meteo.lastPlace", CUSTOM_KEY = "meteo.customPlace", TAB_DEFAULT = "precip", STALE_MS = 30 * 60 * 1000;

const loader = createLoader($("loader"));
const state = { place: null, data: null, warnings: null, ensemble: undefined, view: "detail", tab: TAB_DEFAULT, loading: false, loadId: 0 };

// Dernier lieu validé : favori, ou lieu libre relu et revalidé (jamais pris tel quel dans le stockage).
function readLastPlace() {
  try {
    const id = localStorage.getItem(PLACE_KEY);
    if (id === CUSTOM_ID) { const p = validatePlace(JSON.parse(localStorage.getItem(CUSTOM_KEY))); if (p) return p; }
    return FAVORITES.find((p) => p.id === id) ?? DEFAULT_PLACE;
  } catch { return DEFAULT_PLACE; } // stockage indisponible ou corrompu
}
function saveLastPlace(place) {
  try {
    localStorage.setItem(PLACE_KEY, place.id);
    if (place.id === CUSTOM_ID) localStorage.setItem(CUSTOM_KEY, JSON.stringify(place));
  } catch { /* ignoré */ }
}

function setStatus(text, kind = "") { const s = $("status"); s.className = kind; s.textContent = text; }

// Onglets : seul `state.tab` change, aucun appel réseau.
function renderTabs() {
  const box = $("tabs");
  box.replaceChildren();
  for (const t of TABS) {
    const b = document.createElement("button");
    b.type = "button"; b.className = `tab fam-${t.id}`; b.id = `tab-${t.id}`; b.textContent = t.label;
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
  for (const id of ["h-24", "h-7", "h-15", "h-compact"]) {
    const pill = $(id).querySelector(".rubric");
    pill.textContent = RUBRIC[state.tab];
    pill.className = `rubric fam-${state.tab}`;
  }
}
function renderTabbed() {
  renderTitles();
  if (!state.data) return;
  $("hourly").setAttribute("aria-labelledby", `tab-${state.tab}`);
  $("hourly").replaceChildren(buildHourly(state.data, state.tab));
  $("week").replaceChildren(buildWeek(state.data, state.tab, state.ensemble));
  $("trend").replaceChildren(buildTrend(state.data, state.tab, state.ensemble));
  $("compact").replaceChildren(buildCompact(state.data, state.tab, state.ensemble));
}

function renderAll() {
  const d = state.data;
  $("content").hidden = false;
  $("where").textContent = `${d.location.name} (${d.location.country}) · fuseau ${d.location.timezone} · ` +
    formatLocal(new Date(), d.location.timezone, { dateStyle: "full", timeStyle: "short" });
  $("current").replaceChildren(buildCurrent(d));
  $("top-place").replaceChildren(buildTopPlace(d));
  $("top-now").replaceChildren(buildTopNow(d));
  renderTabs();
  renderTabbed();
  renderWarnings();
  $("refresh").hidden = false;
  updateFreshness();
}

// Vue minimale : les prochaines heures à la position réelle de l'appareil ; remplace la page tant qu'elle est ouverte.
// La position n'est jamais stockée (mémoire seulement) ; la prévision est celle de la position, pas du lieu choisi dans la liste.
const geo = { at: 0, data: null, coords: null, named: true, pressure: null, loadId: 0 };
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
function showMiniPlace(data, coords, named, pressure, at) {
  const pb = $("mini-pressure");
  pb.textContent = pressure.text; pb.title = pressure.title;
  $("mini-baro-btn").disabled = pressure.hpa === null; // sans valeur, rien à montrer sur le cadran
  $("walk-btn").disabled = false; // la position est connue
  $("mini-place").textContent = `📍 ${data.location.name}${data.location.country ? ` (${data.location.country})` : ""}`;
  // L'heure d'actualisation suit la ligne GPS ; sur téléphone, elle passe à la ligne d'un seul bloc (jamais coupée).
  const when = document.createElement("span");
  when.className = "mini-when"; when.title = "Dernière actualisation de la position et de la météo";
  when.textContent = `· actualisé ${refreshedText(at, data.location.timezone)}`; // le « · » part avec l'heure : jamais seul en fin de ligne
  $("mini-gps").replaceChildren(`GPS : ${formatCoords(coords.latitude, coords.longitude)}${coords.accuracy !== null ? ` · précision ± ${Math.round(coords.accuracy)} m` : ""}${named ? "" : " · nom du lieu indisponible"} `, when);
  $("mini-body").replaceChildren(buildMini(data));
}
async function locate(force = false) {
  if (!force && geo.data && Date.now() - geo.at < GEO_MAX_AGE_MS) { showMiniPlace(geo.data, geo.coords, geo.named, geo.pressure, geo.at); miniMessage(""); $("mini-map-btn").disabled = false; return; }
  const id = ++geo.loadId;
  $("mini-refresh").disabled = true;
  $("mini-map-btn").disabled = true;
  $("mini-place").textContent = ""; $("mini-gps").textContent = ""; $("mini-pressure").textContent = ""; $("mini-baro-btn").disabled = true; $("walk-btn").disabled = true; $("mini-body").replaceChildren();
  miniMessage("Recherche de votre position…");
  try {
    const coords = await getPosition();
    if (id !== geo.loadId) return;
    miniMessage("Position trouvée, chargement de la météo…");
    let named = null;
    try { named = await reverseGeocode(coords.latitude, coords.longitude); } catch { /* repli : « Position GPS » */ }
    if (id !== geo.loadId) return;
    const place = placeFromPosition(coords, named);
    if (!place) throw new Error("coordonnées ou fuseau horaire invalides");
    // Prévision et pression mesurée (station la plus proche) en parallèle ; sans mesure, la valeur du modèle reste, marquée « ≈ ».
    const [data, observed] = await Promise.all([
      fetchForecast(place),
      fetchObservedPressure({ latitude: coords.latitude, longitude: coords.longitude, countryCode: place.countryCode }).catch(() => null),
    ]);
    if (id !== geo.loadId) return;
    const pressure = pressureDisplay(data.current.pressure, observed, (ms) => formatLocal(new Date(ms), data.location.timezone, { hour: "2-digit", minute: "2-digit" }));
    Object.assign(geo, { at: Date.now(), data, coords, named: Boolean(named), pressure });
    showMiniPlace(data, coords, Boolean(named), pressure, geo.at);
    miniMessage("");
    $("mini-map-btn").disabled = false;
    if (!$("mini-map-wrap").hidden && globalThis.L) drawMap(globalThis.L); // carte ouverte : recentrée sur la nouvelle position
  } catch (e) {
    if (id !== geo.loadId) return;
    // Échec : dit pourquoi, et ne montre pas pour autant une autre ville comme si c'était la position réelle.
    $("mini-map-wrap").hidden = true; setMapButton(false);
    miniMessage(`Position actuelle indisponible : ${e.message}${e.kind === "denied" ? ` ${deniedHelp(isIOS())}` : ""}`, "err");
    if (state.data) {
      $("mini-place").textContent = `📍 Lieu choisi sur la page : ${state.data.location.name} (${state.data.location.country})`;
      $("mini-gps").textContent = "Ce n'est pas votre position actuelle.";
      $("mini-body").replaceChildren(buildMini(state.data));
    }
  } finally { if (id === geo.loadId) $("mini-refresh").disabled = false; }
}
function setMini(open) {
  document.querySelector("main.shell").hidden = open;
  $("mini").hidden = !open;
  window.scrollTo({ top: 0 });
  if (open) { locate(false); preloadDial(); $("mini-close").focus(); } else { geo.loadId++; $("mini-open").focus(); } // fermer abandonne une recherche en cours
}
// Hauteur du haut de page fixe de « Lieu actuel » : les titres de colonnes se collent juste dessous.
if (typeof ResizeObserver !== "undefined") { const top = document.querySelector(".mini-top"); new ResizeObserver(() => $("mini").style.setProperty("--mini-top-h", `${top.offsetHeight}px`)).observe(top); }
initWalk({
  openBtn: $("walk-btn"),
  getHere: () => (geo.coords ? { lat: geo.coords.latitude, lon: geo.coords.longitude } : null),
  fmtTime: (ms) => formatLocal(new Date(ms), geo.data?.location.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, { hour: "2-digit", minute: "2-digit" }),
});
initBarometer({ getPressure: () => geo.pressure, openBtn: $("mini-baro-btn") });
$("mini-open").addEventListener("click", () => setMini(true));
$("mini-close").addEventListener("click", () => setMini(false));
$("mini-refresh").addEventListener("click", () => locate(true));
$("mini-map-btn").addEventListener("click", toggleMap);
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

// Données périmées ou premier jour ≠ aujourd'hui : signalé, jamais masqué.
function updateFreshness() {
  const d = state.data;
  if (!d || state.loading) return;
  const age = Date.now() - new Date(d.metadata.fetchedAt).getTime();
  if (!d.metadata.firstDayIsToday) setStatus("Ces données ne commencent plus à la date locale d'aujourd'hui : actualisez.", "warn");
  else if (age > STALE_MS) setStatus(`Données récupérées il y a ${Math.round(age / 60000)} min : actualisez pour les mettre à jour.`, "warn");
  else setStatus("");
}

async function load(place) {
  const id = ++state.loadId;
  state.loading = true;
  setStatus("Chargement…");
  // Vigilance en parallèle : n'attend pas la météo et ne la bloque pas (loadWarnings ne lève jamais).
  loader.start(place.name);
  const warningsP = loadWarnings(place);
  try {
    const data = await fetchForecast(place);
    if (id !== state.loadId) return; // un lieu plus récent a été demandé entre-temps
    loader.done("forecast");
    loader.begin("ensemble");
    state.place = place; state.data = data; state.warnings = null; state.ensemble = undefined; state.loading = false;
    setStatus("");
    renderAll();
    warningsP.then((w) => { if (id === state.loadId) { state.warnings = w; renderWarnings(); loader.done("warnings", true); } });
    // Scénarios d'ensemble (J+4 à J+14) : chargés après l'affichage de la prévision, sans la bloquer.
    fetchEnsemble(place, data.daily.map((d) => d.date)).then((e) => {
      if (id !== state.loadId) return;
      state.ensemble = e; renderTabbed(); renderWarnings();
      loader.done("ensemble", e.status === "ok");
    });
  } catch (e) {
    if (id !== state.loadId) return;
    loader.fail(); // l'erreur est affichée ci-dessous : la fenêtre de chargement se ferme
    state.loading = false;
    // L'erreur reste visible ; les anciennes données éventuelles restent affichées mais signalées.
    setStatus(`Impossible de récupérer la météo (${e.kind ?? "erreur"}) : ${e.message}.${state.data ? ` Les données affichées (${state.data.location.name}) sont celles de la dernière consultation réussie.` : ""}`, "err");
  }
}

const select = $("place");
for (const p of FAVORITES) select.add(new Option(`${p.name} (${p.country})`, p.id));

// Lieu libre : une option dédiée dans le sélecteur ; aucune requête météo tant que le bouton n'est pas validé.
function setCustomPlace(place) {
  state.customPlace = place;
  select.querySelector(`option[value="${CUSTOM_ID}"]`)?.remove();
  select.add(new Option(placeLabel(place), CUSTOM_ID));
  select.value = CUSTOM_ID;
}
const initial = readLastPlace();
if (initial.id === CUSTOM_ID) setCustomPlace(initial);
select.value = initial.id;

$("form").addEventListener("submit", (ev) => {
  ev.preventDefault(); // changer la valeur du sélecteur ne lance rien ; le bouton valide
  const place = select.value === CUSTOM_ID ? state.customPlace : FAVORITES.find((p) => p.id === select.value);
  if (!place) return;
  saveLastPlace(place);
  load(place);
});

// À l'ouverture de « Autre lieu », le curseur va directement dans le champ de saisie.
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
      b.addEventListener("click", () => {
        setCustomPlace(p);
        list.replaceChildren();
        msg.textContent = `Lieu choisi : ${placeLabel(p)}. Validez avec « Afficher la météo ».`;
        $("form").querySelector("button[type=submit]").focus();
      });
      li.append(b); list.append(li);
    }
  } catch (e) {
    msg.textContent = e.message;
  } finally { btn.disabled = false; }
});
$("refresh").addEventListener("click", () => state.place && load(state.place));
document.addEventListener("visibilitychange", () => { if (!document.hidden) updateFreshness(); });

// Vue détaillée (par défaut) ou compacte (15 jours dans un seul pavé). Le choix est retenu sur l'appareil.
const VIEW_KEY = "meteo.view";
function applyView() {
  const compact = state.view === "compact";
  $("detail-only").hidden = compact; // situation et 24 h restent visibles dans les deux vues (condensées en compact)
  $("compact-card").hidden = !compact;
  $("content").classList.toggle("is-compact", compact);
  // La vue en cours est signalée sur le sélecteur lui-même (aria-pressed, rendu enfoncé).
  $("view-detail").setAttribute("aria-pressed", String(!compact));
  $("view-compact").setAttribute("aria-pressed", String(compact));
}
function setView(view) {
  if (state.view === view) return;
  state.view = view;
  try { localStorage.setItem(VIEW_KEY, state.view); } catch { /* ignoré */ }
  applyView();
  window.scrollTo({ top: 0 });
}
{
  // Choix mémorisé s'il existe ; sinon compacte sur iOS, détaillée ailleurs.
  let stored = null;
  try { stored = localStorage.getItem(VIEW_KEY); } catch { /* stockage indisponible : défaut de l'appareil */ }
  state.view = chooseView(stored);
}
{
  const ul = document.createElement("ul");
  for (const t of COMPACT_HELP_ITEMS) { const li = document.createElement("li"); li.textContent = t; ul.append(li); }
  $("compact-help").replaceChildren(ul);
}
$("view-detail").addEventListener("click", () => setView("detail"));
$("view-compact").addEventListener("click", () => setView("compact"));
$("compact-info-btn").addEventListener("click", () => {
  const open = $("compact-help").hidden; // hidden = fermé : un clic l'ouvre
  $("compact-help").hidden = !open;
  $("compact-info-btn").setAttribute("aria-expanded", String(open));
});
applyView();

try { localStorage.removeItem("meteo.theme"); } catch { /* ignoré */ }
initInfo();

// Premier lancement : lieu mémorisé (Bar-le-Duc par défaut).
load(readLastPlace());
