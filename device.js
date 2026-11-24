// Vue par défaut (compacte, sur tous les appareils) et détection d'iOS (pour l'aide sur l'autorisation de position).
// Le choix de l'utilisateur, une fois fait, passe toujours avant ce défaut.

export function isIOS(nav = globalThis.navigator) {
  const ua = nav?.userAgent ?? "";
  if (/iPhone|iPod|iPad/.test(ua)) return true;
  // iPadOS en mode « site pour ordinateur » se présente comme un Mac, mais il a un écran tactile ; un vrai Mac n'en a pas.
  return nav?.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1;
}

export const DEFAULT_VIEW = "compact";

// Vue à utiliser : le choix mémorisé s'il est valide, sinon le défaut.
export const chooseView = (stored) => (stored === "compact" || stored === "detail" ? stored : DEFAULT_VIEW);
