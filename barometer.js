// Baromètre marin : cadran à aiguille dessiné en SVG, de 950 à 1050 hPa sur 270°, dans une fenêtre <dialog>.
// Le dessin n'interpole que des nombres calculés ici (jamais de texte venu du réseau).

export const BARO_MIN = 950, BARO_MAX = 1050, BARO_START = -135, BARO_SWEEP = 270;
const C = 160; // centre du cadran (viewBox 320 × 320)
// Image du boîtier (cadran-laiton.webp, 1254 × 1254 px, créée avec ChatGPT) : positions mesurées sur l'image.
export const DIAL_IMG = {
  file: "cadran-laiton.webp", px: 1254,
  faceX: 621, faceY: 635,      // centre du fond de cadran = axe de l'aiguille
  outerX: 623.3, outerY: 628.9, outerR: 603, // cercle extérieur du boîtier (pour le découpage)
  scale: 0.26,                 // unités du dessin par pixel de l'image : le boîtier tient dans les 320 unités
  k: 0.8,                      // l'échelle (dessinée pour un cadran de 137) est réduite pour tenir dans le fond de 117 unités
};
// Chargement anticipé de l'image, pour qu'elle soit prête à l'ouverture de la fenêtre.
export const preloadDial = () => { if (typeof Image !== "undefined") new Image().src = DIAL_IMG.file; };
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// Angle de l'aiguille en degrés, 0° = midi, sens horaire ; borné aux extrémités de l'échelle.
export const baroAngle = (p) => BARO_START + ((Math.min(BARO_MAX, Math.max(BARO_MIN, p)) - BARO_MIN) / (BARO_MAX - BARO_MIN)) * BARO_SWEEP;
const pt = (p, r) => { const a = (baroAngle(p) * Math.PI) / 180; return [C + r * Math.sin(a), C - r * Math.cos(a)]; };
const f = (n) => Math.round(n * 100) / 100;
const arc = (p0, p1, r) => { const [x0, y0] = pt(p0, r), [x1, y1] = pt(p1, r); return `M${f(x0)} ${f(y0)} A${r} ${r} 0 ${baroAngle(p1) - baroAngle(p0) > 180 ? 1 : 0} 1 ${f(x1)} ${f(y1)}`; };

// Indications traditionnelles des baromètres : un décor, pas une prévision (le texte de la fenêtre le rappelle).
export const BARO_ZONES = [
  { from: 950, to: 980, word: "TEMPÊTE" }, { from: 980, to: 1000, word: "PLUIE" },
  { from: 1000, to: 1020, word: "VARIABLE" }, { from: 1020, to: 1050, word: "BEAU" },
];

export const baroLabel = (p) => (isNum(p) ? `${Math.round(p)} hPa` : "pression indisponible");

// past : pression mesurée environ 3 h plus tôt (aiguille repère dorée), ou null : pas d'aiguille.
export function baroSvg(pressure, past = null) {
  const has = isNum(pressure), hasPast = has && isNum(past);
  let ticks = "", nums = "";
  for (let p = BARO_MIN; p <= BARO_MAX; p++) {
    const big = p % 10 === 0, mid = p % 5 === 0;
    const [x0, y0] = pt(p, 128), [x1, y1] = pt(p, big ? 113 : mid ? 118 : 122);
    ticks += `<line x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}" stroke="#3b2f1e" stroke-width="${big ? 2 : mid ? 1.4 : 0.8}" stroke-linecap="round"/>`;
    if (big) { const [tx, ty] = pt(p, 97); nums += `<text x="${f(tx)}" y="${f(ty)}" text-anchor="middle" dominant-baseline="central" font-size="15" font-weight="700">${p}</text>`; }
  }
  let zones = "", defs = "";
  BARO_ZONES.forEach((z, i) => {
    defs += `<path id="bz${i}" d="${arc(z.from, z.to, 74)}"/>`;
    zones += `<text font-size="11.5" letter-spacing="2" fill="#6b4a1e"><textPath href="#bz${i}" startOffset="50%" text-anchor="middle">${z.word}</textPath></text>`;
  });
  const angle = has ? baroAngle(pressure) : BARO_START;
  const needle = has ? `<g class="baro-needle" data-angle="${f(angle)}" style="transform-origin:${C}px ${C}px;transform:rotate(${f(angle)}deg)" filter="url(#bshadow)">
      <path d="M${C} 44 L${C + 4.6} 150 L${C} 182 L${C - 4.6} 150 Z" fill="#241b12"/>
      <path d="M${C} 52 L${C + 1.6} 150 L${C} 160 L${C - 1.6} 150 Z" fill="#7a5a2a" opacity=".55"/>
    </g>` : "";
  // Aiguille repère : fine, dorée, cerclée près de la pointe, sous l'aiguille noire ; posée sur sa valeur, sans animation.
  const ref = hasPast ? `<g class="baro-ref" data-angle="${f(baroAngle(past))}" transform="rotate(${f(baroAngle(past))} ${C} ${C})">
      <path d="M${C} 34 L${C} 160" stroke="#5a3f12" stroke-width="4.6" stroke-linecap="round"/><path d="M${C} 34 L${C} 160" stroke="#d9a53a" stroke-width="3" stroke-linecap="round"/>
      <circle cx="${C}" cy="38" r="6.5" fill="#d9a53a" stroke="#5a3f12" stroke-width="1.2"/>
    </g>` : "";
  const D = DIAL_IMG, s = D.scale;
  const imgX = f(C - D.faceX * s), imgY = f(C - D.faceY * s), imgS = f(D.px * s);
  const clipX = f(C + (D.outerX - D.faceX) * s), clipY = f(C + (D.outerY - D.faceY) * s), clipR = f((D.outerR - 4) * s);
  return `<svg class="baro-svg" viewBox="0 0 320 320" role="img" aria-label="Baromètre : ${baroLabel(pressure)}${hasPast ? ` ; aiguille repère : ${baroLabel(past)}` : ""}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bhub" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#f6e2a5"/><stop offset=".6" stop-color="#b98a35"/><stop offset="1" stop-color="#6e4e17"/></radialGradient>
    <filter id="bshadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="2.5" dy="3.5" stdDeviation="2.2" flood-color="#000" flood-opacity=".35"/></filter>
    <clipPath id="bclip"><circle cx="${clipX}" cy="${clipY}" r="${clipR}"/></clipPath>
    ${defs}
  </defs>
  <g clip-path="url(#bclip)"><image href="${D.file}" x="${imgX}" y="${imgY}" width="${imgS}" height="${imgS}" preserveAspectRatio="none"/></g>
  <g transform="translate(${C} ${C}) scale(${D.k}) translate(-${C} -${C})">
    <g fill="#3b2f1e" font-family="Georgia, 'Times New Roman', serif">
      ${ticks}${nums}${zones}
      <text x="${C}" y="${C - 30}" text-anchor="middle" font-size="12" letter-spacing="3" font-weight="700">BAROMÈTRE</text>
      <text x="${C}" y="${C + 62}" text-anchor="middle" font-size="14" letter-spacing="2" fill="#6b4a1e">hPa</text>
      <text x="${C}" y="${C + 88}" text-anchor="middle" font-size="26" font-weight="700">${has ? Math.round(pressure) : "—"}</text>
    </g>
    ${ref}${needle}
    <circle cx="${C}" cy="${C}" r="10" fill="url(#bhub)" stroke="#5a3f12" stroke-width="1"/>
    <circle cx="${C}" cy="${C}" r="3.2" fill="#241b12"/>
  </g>
</svg>`;
}

// Fenêtre du baromètre : ouverte depuis une pression affichée (page principale ou vue 🥾 : liste de { openBtn, getPressure }) ; l'aiguille balaie l'échelle depuis 950 hPa jusqu'à la valeur (animation CSS ; position finale correcte même sans animation).
export function initBarometer(entries) {
  const $ = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`élément « #${id} » introuvable : les fichiers du site ne sont pas tous de la même version (republiez-les tous, puis rechargez avec Cmd+Maj+R)`);
    return el;
  };
  const dlg = $("baro");
  let opener = null; // bouton d'origine : le curseur y revient à la fermeture
  for (const { openBtn, getPressure } of entries) openBtn.addEventListener("click", () => {
    opener = openBtn;
    const info = getPressure(), p = typeof info?.hpa === "number" ? info.hpa : null;
    $("baro-dial").innerHTML = baroSvg(p, info?.trend?.hpa ?? null);
    $("baro-trend").textContent = info?.trendText ?? "";
    $("baro-trend").hidden = $("baro-trend-note").hidden = !info?.trendText;
    $("baro-value").textContent = info?.text ?? baroLabel(p);
    $("baro-src").textContent = info?.note ?? ""; // texte venu du réseau (nom de station) : toujours textContent
    $("baro-range").hidden = !(typeof p === "number" && (p < BARO_MIN || p > BARO_MAX));
    dlg.showModal(); // l'aiguille est posée sur la valeur dès le dessin ; le balayage est une simple animation CSS qui y mène
  });
  $("baro-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => opener?.focus());
  // Comme la fenêtre « i » : seul un clic dont la cible est le dialogue lui-même, hors de son cadre, le ferme.
  dlg.addEventListener("click", (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  });
}
