// Couche fournisseur : un appel Open-Meteo par lieu, normalisation, sélection du modèle par valeur.
// Aucune valeur n'est inventée : une donnée absente reste null (jamais 0).

const API_URL = "https://api.open-meteo.com/v1/forecast";
export const FORECAST_DAYS = 16; // l'API renvoie 16 jours ; le 16e (J+15) est vide pour ECMWF, on garde J..J+14
export const KEPT_DAYS = 15;
export const TREND_LATEST_DAY = 5; // « tendance » au plus tard à partir de J+5 (cahier 8)

// Liste de priorité des modèles par pays (hypothèses confirmées au lot 0).
const LONG_MODEL = "ecmwf_ifs025";
const MODEL_PLANS = {
  FR: ["meteofrance_seamless", LONG_MODEL],
  JP: ["jma_seamless", LONG_MODEL],
  CA: ["gem_seamless", LONG_MODEL],
};
export function modelPlan(countryCode) {
  return MODEL_PLANS[countryCode] ?? [LONG_MODEL];
}

export const MODEL_INFO = {
  meteofrance_seamless: { short: "Météo-France", label: "Météo-France (AROME/ARPEGE, via Open-Meteo)", isMeteoFrance: true },
  ecmwf_ifs025: { short: "ECMWF", label: "ECMWF IFS, via Open-Meteo" },
  jma_seamless: { short: "JMA", label: "JMA, via Open-Meteo" },
  gem_seamless: { short: "GEM", label: "GEM (Environnement Canada), via Open-Meteo" },
};
export const modelShort = (m) => (m ? MODEL_INFO[m]?.short ?? m : null);
export const modelLabel = (m) => (m ? MODEL_INFO[m]?.label ?? `${m}, via Open-Meteo` : null);

const DAILY_VARS = [
  "weather_code", "temperature_2m_max", "temperature_2m_min", "apparent_temperature_max", "apparent_temperature_min",
  "precipitation_sum", "precipitation_probability_max", "wind_speed_10m_max", "wind_gusts_10m_max",
  "wind_direction_10m_dominant", "sunrise", "sunset",
];
const HOURLY_VARS = [
  "temperature_2m", "apparent_temperature", "precipitation", "precipitation_probability",
  "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m", "weather_code",
];
const CURRENT_VARS = ["temperature_2m", "apparent_temperature", "weather_code", "precipitation", "wind_speed_10m", "wind_gusts_10m"];

export class ForecastError extends Error {
  constructor(kind, message) { super(message); this.name = "ForecastError"; this.kind = kind; } // kind : network | http | format
}

export function buildUrl(place) {
  const q = new URLSearchParams({
    latitude: place.latitude, longitude: place.longitude, timezone: place.timezone,
    forecast_days: FORECAST_DAYS, models: modelPlan(place.countryCode).join(","),
    daily: DAILY_VARS.join(","), hourly: HOURLY_VARS.join(","), current: CURRENT_VARS.join(","),
  });
  return `${API_URL}?${q}`;
}

// Un seul appel réseau par lieu. Toute erreur est remontée, jamais avalée.
export async function fetchForecast(place, { fetchImpl = fetch, now = new Date() } = {}) {
  let res;
  try { res = await fetchImpl(buildUrl(place)); }
  catch (e) { throw new ForecastError("network", `Réseau indisponible : ${e.message}`); }
  if (!res.ok) throw new ForecastError("http", `Open-Meteo a répondu HTTP ${res.status}`);
  let raw;
  try { raw = await res.json(); }
  catch (e) { throw new ForecastError("format", "Réponse Open-Meteo illisible"); }
  return normalize(raw, place, { now });
}

// Valeur d'une variable pour un modèle : colonne suffixée, ou colonne simple si un seul modèle a été demandé.
function column(block, variable, model, models) {
  if (!block) return null;
  return block[`${variable}_${model}`] ?? (models.length === 1 ? block[variable] : undefined) ?? null;
}
const isValue = (v) => v !== null && v !== undefined;

// Règle 3.2 : premier modèle de la liste qui fournit une valeur non nulle ; le modèle est mémorisé avec la valeur.
function pick(block, variable, index, models) {
  for (const m of models) {
    const col = column(block, variable, m, models);
    if (col && isValue(col[index])) return { value: col[index], model: m };
  }
  return { value: null, model: null };
}

export function rainClass(mm) {
  if (!isValue(mm)) return null;
  if (mm < 0.2) return "sec";
  if (mm < 2) return "faible";
  if (mm <= 10) return "modéré";
  return "fort";
}

// Étiquette d'horizon fixe, non calibrée (cahier 9). dayIndex : 0 = aujourd'hui.
export function horizonConfidence(dayIndex) {
  if (dayIndex < TREND_LATEST_DAY) return null;
  if (dayIndex <= 7) return "moyenne";
  if (dayIndex <= 10) return "faible";
  return "très faible";
}

// Date locale (YYYY-MM-DD) d'un instant dans un fuseau IANA.
export function localDateISO(instant, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

export function normalize(raw, place, { now = new Date() } = {}) {
  if (!raw?.daily?.time || !raw?.hourly?.time) throw new ForecastError("format", "Réponse Open-Meteo incomplète");
  const models = modelPlan(place.countryCode);
  const primary = models[0];

  const days = raw.daily.time.slice(0, KEPT_DAYS);
  const daily = days.map((date, i) => {
    const f = (v) => pick(raw.daily, v, i, models);
    return {
      date,
      dayIndex: i,
      weatherCode: f("weather_code"),
      tempMax: f("temperature_2m_max"),
      tempMin: f("temperature_2m_min"),
      apparentMax: f("apparent_temperature_max"),
      apparentMin: f("apparent_temperature_min"),
      precipSum: f("precipitation_sum"),
      // Définition : probabilité horaire maximale du jour, pas la probabilité de pluie sur la journée.
      precipProbMax: f("precipitation_probability_max"),
      windMax: f("wind_speed_10m_max"),
      gustMax: f("wind_gusts_10m_max"),
      windDirDominant: f("wind_direction_10m_dominant"),
      sunrise: f("sunrise"),
      sunset: f("sunset"),
    };
  });

  // Frontière « tendance » : premier jour où le modèle court n'a plus de température, plafonnée à J+5.
  const primaryTemp = column(raw.daily, "temperature_2m_max", primary, models);
  let boundary = days.findIndex((_, i) => !(primaryTemp && isValue(primaryTemp[i])));
  if (boundary < 0) boundary = days.length;
  const trendFrom = Math.min(boundary, TREND_LATEST_DAY);
  daily.forEach((d) => {
    d.trend = d.dayIndex >= trendFrom;
    d.confidence = horizonConfidence(d.dayIndex);
    d.precipClass = rainClass(d.precipSum.value);
  });

  const hourly = raw.hourly.time.map((time, i) => {
    const f = (v) => pick(raw.hourly, v, i, models);
    return {
      time,
      temp: f("temperature_2m"), apparent: f("apparent_temperature"),
      precip: f("precipitation"), precipProb: f("precipitation_probability"),
      wind: f("wind_speed_10m"), gust: f("wind_gusts_10m"), windDir: f("wind_direction_10m"),
      weatherCode: f("weather_code"),
    };
  });

  const c = raw.current ?? {};
  const current = {
    time: c.time ?? null,
    // Valeurs de modèle, non mesurées ; Open-Meteo ne précise pas le modèle retenu pour « current ».
    status: "estimation de modèle",
    model: null,
    temp: c.temperature_2m ?? null, apparent: c.apparent_temperature ?? null, weatherCode: c.weather_code ?? null,
    precip: c.precipitation ?? null, wind: c.wind_speed_10m ?? null, gust: c.wind_gusts_10m ?? null,
  };

  const localToday = localDateISO(now, place.timezone);
  return {
    location: { name: place.name, country: place.country, latitude: place.latitude, longitude: place.longitude, timezone: raw.timezone ?? place.timezone, elevation: raw.elevation ?? null },
    metadata: {
      provider: "Open-Meteo",
      modelsRequested: models,
      fetchedAt: now.toISOString(),
      sourceUpdatedAt: null, // non publié par l'API : on n'invente pas d'heure
      license: "Open-Meteo, usage non commercial — Weather data by Open-Meteo.com",
      localToday,
      firstDayIsToday: days[0] === localToday,
      trendFromDay: trendFrom,
      modelsUsed: usedModels(daily, hourly),
    },
    current, hourly, daily,
    warnings: { status: "non confirmée" },
  };
}

// Modèles réellement présents dans les valeurs affichables (pour les attributions).
export function usedModels(daily, hourly = []) {
  const set = new Set();
  const scan = (obj) => { for (const v of Object.values(obj)) if (v && typeof v === "object" && "model" in v && v.model) set.add(v.model); };
  daily.forEach(scan); hourly.forEach(scan);
  return [...set];
}

export const firstWeek = (data) => data.daily.slice(0, 7);
export const secondWeek = (data) => data.daily.slice(7, KEPT_DAYS);

// 24 heures glissantes à partir de l'heure locale courante (comparaison de chaînes ISO locales, même fuseau).
export function next24h(data, currentTime = data.current.time) {
  if (!currentTime) return [];
  const hourStart = currentTime.slice(0, 13); // « YYYY-MM-DDTHH »
  const start = data.hourly.findIndex((h) => h.time.slice(0, 13) >= hourStart);
  return start < 0 ? [] : data.hourly.slice(start, start + 24);
}
