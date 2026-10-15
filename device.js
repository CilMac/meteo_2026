// Détection de l'appareil pour la vue par défaut : compacte sur iOS (iPhone, iPod, iPad), détaillée ailleurs (Mac, etc.).
// Le choix de l'utilisateur, une fois fait, passe toujours avant ce défaut.

export function isIOS(nav = globalThis.navigator) {
  const ua = nav?.userAgent ?? "";
  if (/iPhone|iPod|iPad/.test(ua)) return true;
  // iPadOS en mode « site pour ordinateur » se présente comme un Mac, mais il a un écran tactile ; un vrai Mac n'en a pas.
  return nav?.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1;
}

export const defaultView = (nav = globalThis.navigator) => (isIOS(nav) ? "compact" : "detail");

// Vue à utiliser : le choix mémorisé s'il est valide, sinon le défaut de l'appareil.
export const chooseView = (stored, nav = globalThis.navigator) => (stored === "compact" || stored === "detail" ? stored : defaultView(nav));
