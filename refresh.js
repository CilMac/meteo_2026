// Mise à jour automatique quand on revient dans l'application : décision seule, sans DOM ni réseau (tests Node).

export const STALE_MS = 30 * 60 * 1000;   // prévisions de la page principale : au-delà, elles sont relues au retour
export const TRY_GAP_MS = 60 * 1000;      // pas plus d'une tentative automatique par minute (aller-retour entre applications, panne de réseau)
export const RETRY_MS = 5 * 1000;         // le réseau peut manquer juste au réveil de l'appareil : une seconde tentative, une seule
export const QUIET_WAIT_MS = 8 * 1000;    // les anciennes valeurs restent à l'écran le temps que tout arrive, au plus ce délai

// Prévisions à relire : trop anciennes, d'une heure illisible ou dans le futur (horloge changée), ou commençant un autre jour que celui du lieu.
export function isOutdated({ fetchedAtMs, firstDay, today, now }) {
  const age = now - fetchedAtMs;
  if (!Number.isFinite(age) || age < 0) return true;
  return age > STALE_MS || firstDay !== today;
}

// Faut-il recharger maintenant ? Jamais pendant un chargement, jamais deux fois dans la même minute.
export function shouldRefresh({ hasData, busy, lastTryMs = null, now, ...rest }) {
  if (busy) return false;
  if (lastTryMs !== null && now >= lastTryMs && now - lastTryMs < TRY_GAP_MS) return false;
  return !hasData || isOutdated({ now, ...rest }); // rien d'affiché (premier chargement échoué) : nouvel essai
}
