// Baromètre marin : cadran à aiguille dessiné en SVG, de 950 à 1050 hPa sur 270°, dans une fenêtre <dialog>.
// Le dessin n'interpole que des nombres calculés ici (jamais de texte venu du réseau).

export const BARO_MIN = 950, BARO_MAX = 1050, BARO_START = -135, BARO_SWEEP = 270;
const C = 160; // centre du cadran (viewBox 320 × 320)
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

export function baroSvg(pressure) {
  const has = isNum(pressure);
  let ticks = "", nums = "";
  for (let p = BARO_MIN; p <= BARO_MAX; p++) {
    const big = p % 10 === 0, mid = p % 5 === 0;
    const [x0, y0] = pt(p, 128), [x1, y1] = pt(p, big ? 113 : mid ? 118 : 122);
    ticks += `<line x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}" stroke="#3b2f1e" stroke-width="${big ? 2 : mid ? 1.4 : 0.8}" stroke-linecap="round"/>`;
    if (big) { const [tx, ty] = pt(p, 97); nums += `<text x="${f(tx)}" y="${f(ty)}" text-anchor="middle" dominant-baseline="central" font-size="13" font-weight="700">${p}</text>`; }
  }
  let zones = "", defs = "";
  BARO_ZONES.forEach((z, i) => {
    defs += `<path id="bz${i}" d="${arc(z.from, z.to, 74)}"/>`;
    zones += `<text font-size="10" letter-spacing="2" fill="#6b4a1e"><textPath href="#bz${i}" startOffset="50%" text-anchor="middle">${z.word}</textPath></text>`;
  });
  const angle = has ? baroAngle(pressure) : BARO_START;
  const needle = has ? `<g class="baro-needle" data-angle="${f(angle)}" style="transform-origin:${C}px ${C}px;transform:rotate(${f(angle)}deg)" filter="url(#bshadow)">
      <path d="M${C} 44 L${C + 4.6} 150 L${C} 182 L${C - 4.6} 150 Z" fill="#241b12"/>
      <path d="M${C} 52 L${C + 1.6} 150 L${C} 160 L${C - 1.6} 150 Z" fill="#7a5a2a" opacity=".55"/>
    </g>` : "";
  return `<svg class="baro-svg" viewBox="0 0 320 320" role="img" aria-label="Baromètre : ${baroLabel(pressure)}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bbrass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f1d58a"/><stop offset=".45" stop-color="#b98a35"/><stop offset=".75" stop-color="#e8c675"/><stop offset="1" stop-color="#7d5a1f"/></linearGradient>
    <linearGradient id="bring" x1="1" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#f1d58a"/><stop offset=".5" stop-color="#a97b2c"/><stop offset="1" stop-color="#f5dc9a"/></linearGradient>
    <radialGradient id="bdial" cx=".42" cy=".38" r=".8"><stop offset="0" stop-color="#fbf5e4"/><stop offset=".7" stop-color="#f0e6cb"/><stop offset="1" stop-color="#dccfae"/></radialGradient>
    <radialGradient id="bhub" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#f6e2a5"/><stop offset=".6" stop-color="#b98a35"/><stop offset="1" stop-color="#6e4e17"/></radialGradient>
    <linearGradient id="bglass" x1=".1" y1="0" x2=".7" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".42"/><stop offset=".5" stop-color="#fff" stop-opacity=".05"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <filter id="bshadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="2.5" dy="3.5" stdDeviation="2.2" flood-color="#000" flood-opacity=".35"/></filter>
    ${defs}
  </defs>
  <circle cx="${C}" cy="${C}" r="156" fill="#2b2112"/>
  <circle cx="${C}" cy="${C}" r="153" fill="url(#bbrass)"/>
  <circle cx="${C}" cy="${C}" r="141" fill="url(#bring)"/>
  <circle cx="${C}" cy="${C}" r="139" fill="#3a2a10"/>
  <circle cx="${C}" cy="${C}" r="137" fill="url(#bdial)"/>
  <g fill="#3b2f1e" font-family="Georgia, 'Times New Roman', serif">
    ${ticks}${nums}${zones}
    <text x="${C}" y="${C - 30}" text-anchor="middle" font-size="10" letter-spacing="3" font-weight="700">BAROMÈTRE</text>
    <text x="${C}" y="${C + 62}" text-anchor="middle" font-size="12" letter-spacing="2" fill="#6b4a1e">hPa</text>
    <text x="${C}" y="${C + 86}" text-anchor="middle" font-size="22" font-weight="700">${has ? Math.round(pressure) : "—"}</text>
  </g>
  ${needle}
  <circle cx="${C}" cy="${C}" r="10" fill="url(#bhub)" stroke="#5a3f12" stroke-width="1"/>
  <circle cx="${C}" cy="${C}" r="3.2" fill="#241b12"/>
  <circle cx="${C}" cy="${C}" r="137" fill="url(#bglass)" pointer-events="none"/>
</svg>`;
}

// Fenêtre du baromètre : ouverte depuis la pression affichée ; l'aiguille balaie l'échelle depuis 950 hPa jusqu'à la valeur (animation CSS ; position finale correcte même sans animation).
export function initBarometer({ getPressure, openBtn }) {
  const $ = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`élément « #${id} » introuvable : les fichiers du site ne sont pas tous de la même version (republiez-les tous, puis rechargez avec Cmd+Maj+R)`);
    return el;
  };
  const dlg = $("baro");
  openBtn.addEventListener("click", () => {
    const p = getPressure();
    $("baro-dial").innerHTML = baroSvg(p);
    $("baro-value").textContent = baroLabel(p);
    $("baro-range").hidden = !(typeof p === "number" && (p < BARO_MIN || p > BARO_MAX));
    dlg.showModal(); // l'aiguille est posée sur la valeur dès le dessin ; le balayage est une simple animation CSS qui y mène
  });
  $("baro-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => openBtn.focus());
  // Comme la fenêtre « i » : seul un clic dont la cible est le dialogue lui-même, hors de son cadre, le ferme.
  dlg.addEventListener("click", (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  });
}
