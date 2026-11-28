// Détection d'iOS (pour l'aide sur l'autorisation de position). Le choix de vue a disparu le 28/11/2026 (une seule vue).

export function isIOS(nav = globalThis.navigator) {
  const ua = nav?.userAgent ?? "";
  if (/iPhone|iPod|iPad/.test(ua)) return true;
  // iPadOS en mode « site pour ordinateur » se présente comme un Mac, mais il a un écran tactile ; un vrai Mac n'en a pas.
  return nav?.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1;
}
