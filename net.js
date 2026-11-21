// Délai maximal des appels réseau : un service qui ne répond pas ne doit jamais bloquer la page indéfiniment
// (fetch n'a pas de délai par défaut). Sans dépendance au DOM (tests Node).

// Délais par service, en millisecondes.
export const TIMEOUTS = {
  forecast: 15000, // prévision principale (réponse volumineuse)
  search: 10000,   // recherche d'un lieu
  reverse: 8000,   // nom du lieu (Nominatim)
  pressure: 6000,  // pression mesurée (IEM) : la vue « Lieu actuel » l'attend, d'où un délai court
  walk: 12000,     // « Balade dans l'heure ? »
  sky: 15000,      // carte « nuages · pluie » (une cinquantaine de points)
};

// Exécute `run(signal)` (lecture réseau + lecture de la réponse) en au plus `ms` millisecondes.
// Au-delà : la requête est abandonnée et la promesse est rejetée avec `onTimeout()`, l'erreur propre au module appelant.
// Le délai couvre aussi la lecture du corps de la réponse, pas seulement l'arrivée des en-têtes.
export function timed(ms, run, onTimeout) {
  const ctl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { reject(onTimeout()); ctl.abort(); }, ms); // rejet d'abord : c'est lui qui l'emporte, pas l'erreur d'abandon
  });
  return Promise.race([run(ctl.signal), timeout]).finally(() => clearTimeout(timer));
}

export const seconds = (ms) => `${Math.round(ms / 1000)} s`;
