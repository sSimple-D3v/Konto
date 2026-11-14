/* Konto — base v0.3
 * 100% offline: todos os dados ficam neste dispositivo (ver storage.js: ficheiros por ano na app Android,
 * localStorage no browser).
 * Estrutura:  1) dados  2) utilitários  3) lançamentos  4) ecrãs  5) eventos
 *
 * Ideia central: cada módulo (subscrições, gastos avulsos, …) produz "lançamentos"
 * (entries). O calendário e o resumo do Início só leem lançamentos — por isso
 * adicionar um módulo novo não obriga a mexer no resto.
 */
'use strict';

/* ───────────── 1. DADOS ───────────── */
const KEY = 'konto.v1';
const DB_VERSION = 2;           // sobe sempre que a estrutura dos dados mudar
let db = { version: DB_VERSION, profiles: [] };   // preenchido no arranque (boot, no fim do ficheiro)

/* Põe um perfil (do armazenamento ou de uma cópia importada) na estrutura atual. */
function migrateProfile(p) {
  const now = new Date().toISOString();
  p.subs = Array.isArray(p.subs) ? p.subs : [];
  p.spends = Array.isArray(p.spends) ? p.spends : [];     // v2
  p.modules = Array.isArray(p.modules) ? p.modules : [];
  p.habits = Array.isArray(p.habits) ? p.habits : [];     // hábitos (vícios)
  p.bills = Array.isArray(p.bills) ? p.bills : [];        // contas de casa (renda, luz, água…)
  p.billLog = p.billLog && typeof p.billLog === 'object' && !Array.isArray(p.billLog) ? p.billLog : {};   // valor real das faturas: "idConta:AAAA-MM" → €
  p.bills.forEach(b => { b.created ||= now; });
  p.ldp = p.ldp && typeof p.ldp === 'object' && !Array.isArray(p.ldp) ? p.ldp : null;      // animações de entrada favoritas deste perfil (laboratório)
  p.carFix = Array.isArray(p.carFix) ? p.carFix : [];                   // pagamentos fixos do automóvel (seguro, IUC…)
  p.carFix.forEach(c => { c.created ||= now; });
  p.incomes = Array.isArray(p.incomes) ? p.incomes : [];                 // ordenados (o que entra), para saber quanto resta
  p.incomes.forEach(i => { i.created ||= now; });
  p.earnings = Array.isArray(p.earnings) ? p.earnings : [];               // ganhos avulsos ou diários ("+ Ganho")
  p.balanceNotice = !!p.balanceNotice;                                   // aviso no Início, nos primeiros dias do mês, do balanço do mês que fechou
  p.noticeSeen = typeof p.noticeSeen === 'string' ? p.noticeSeen : '';
  p.earnCycle = p.earnCycle === 'week' ? 'week' : 'month';               // sem ordenado com dia certo, o "resta" conta o mês ou a semana
  p.shopRems = Array.isArray(p.shopRems) ? p.shopRems : [];            // lembretes das outras despesas do carro (óleo, pneus, inspeção…)
  p.vehicles = Array.isArray(p.vehicles) ? p.vehicles : [];             // veículos do combustível
  const legacyFuel = p.spends.filter(s => s.cat === 'fuel' && s.liters > 0 && !s.veh);   // abastecimentos de antes de haver veículos
  if (legacyFuel.length) {
    let v = p.vehicles[0];
    if (!v) { v = { id: uid(), name: 'O meu carro', type: 'car' }; p.vehicles.push(v); }
    legacyFuel.forEach(s => { s.veh = v.id; });
  }
  p.hlog = p.hlog && typeof p.hlog === 'object' && !Array.isArray(p.hlog) ? p.hlog : {};   // um registo por hábito e por dia: "idHábito:AAAA-MM-DD"
  if (!VICE_ICONS.some(v => v[0] === p.viceIcon)) p.viceIcon = p.habits.some(h => h.tpl === 'tabaco') ? 'cig' : 'flame';   // chama por defeito; quem já tinha tabaco mantém o cigarro
  p.created ||= now;                                      // v2
  p.subs.forEach(s => { s.created ||= now; });
  p.habits.forEach(h => { delete h.inPlay; delete h.inPlayAt; if (h.icon === 'vices') h.icon = 'cig'; });   // 'vices' passou a ser o ícone escolhido por perfil   // o saldo do casino deixou de existir
  // casino: já não há levantamentos. Nos perfis da versão com "ganho" separado (campo g), o ganho passa a ser o ganho real.
  p.habits.filter(h => h.tpl === 'casino').forEach(h => {
    const keys = Object.keys(p.hlog).filter(k => k.startsWith(h.id + ':'));
    if (!keys.some(k => p.hlog[k].g !== undefined)) return;
    for (const k of keys) {
      const r = p.hlog[k]; r.won = r.g || 0; delete r.g;
      if (!r.spent && !r.won && !r.n) delete p.hlog[k];             // registo que só tinha um levantamento
    }
  });
  return p;
}

/* Lê do localStorage (browser) e põe os dados na estrutura atual. Na app Android serve só para passar os dados
 * antigos para ficheiros, na primeira vez. */
/* Um perfil novo nasce sempre com a estrutura completa (a mesma que os perfis lidos do armazenamento). */
function newProfile(fields) {
  return migrateProfile({ id: uid(), created: new Date().toISOString(), modules: [], ...fields });
}

function loadDB() {
  const raw = localStorage.getItem(KEY);
  let data;
  try { data = JSON.parse(raw) || { profiles: [] }; }
  catch {                                                 // dados corrompidos: guarda-os à parte, nunca os perde
    try { localStorage.setItem(KEY + '.corrupt', raw); } catch {}
    data = { profiles: [] };
  }
  data.profiles ||= [];
  if ((data.version || 1) < DB_VERSION && data.profiles.length) {
    try { localStorage.setItem(KEY + '.backup', raw); } catch {}   // cópia automática antes de migrar
  }
  data.profiles.forEach(migrateProfile);
  data.version = DB_VERSION;
  return data;
}
function saveDB() { Store.save(); }                      // browser: localStorage; app Android: ficheiros (ver storage.js)

/* ── Tema: cor, estilo do gradiente e modo claro/escuro. Cada perfil tem o seu (p.theme). ── */
const PALETTES = [   // g = as duas cores do gradiente; s = a cor predominante (é a do estilo "Sólido"); dark/light = cor de destaque nos modos escuro/claro; a2 = cor de apoio
  { id: 'esmeralda', name: 'Esmeralda',  g: ['#34d399', '#6366f1'], s: '#34d399', dark: '#34d399', light: '#10b981', a2: '#6366f1', tintDark: '#5393a8' },   // tintDark: o verde do fundo no modo Auto escuro, menos vivo
  { id: 'oceano',    name: 'Oceano',     g: ['#67e8f9', '#2563eb'], s: '#06b6d4', dark: '#22d3ee', light: '#0891b2', a2: '#3b82f6' },
  { id: 'rosa',      name: 'Rosa',       g: ['#f472b6', '#a78bfa'], s: '#ec4899', dark: '#f472b6', light: '#db2777', a2: '#a78bfa' },
  { id: 'aurora',    name: 'Aurora',     g: ['#5eead4', '#a855f7'], s: '#8b5cf6', dark: '#a78bfa', light: '#7c3aed', a2: '#2dd4bf' },
  { id: 'cereja',    name: 'Cereja',     g: ['#fb7185', '#9f1239'], s: '#f43f5e', dark: '#fb7185', light: '#e11d48', a2: '#fda4af' },
  { id: 'floresta',  name: 'Floresta',   g: ['#bef264', '#15803d'], s: '#84cc16', dark: '#a3e635', light: '#65a30d', a2: '#22c55e' },
  { id: 'tropical',  name: 'Tropical',   g: ['#a3e635', '#06b6d4'], s: '#22d3ee', dark: '#a3e635', light: '#0d9488', a2: '#22d3ee' },
  { id: 'menta',     name: 'Menta',      g: ['#a7f3d0', '#0ea5e9'], s: '#2dd4bf', dark: '#5eead4', light: '#0d9488', a2: '#38bdf8' },
  { id: 'lavanda',   name: 'Lavanda',    g: ['#e9d5ff', '#6366f1'], s: '#a78bfa', dark: '#a5b4fc', light: '#6366f1', a2: '#c4b5fd' },
  { id: 'algodao',   name: 'Algodão',    g: ['#f9a8d4', '#7dd3fc'], s: '#f9a8d4', dark: '#f9a8d4', light: '#db2777', a2: '#7dd3fc' },
  { id: 'noite',     name: 'Noite',      g: ['#818cf8', '#312e81'], s: '#6366f1', dark: '#818cf8', light: '#4f46e5', a2: '#a5b4fc' },
  { id: 'grafite',   name: 'Grafite',    g: ['#f3f4f6', '#6b7280'], s: '#9ca3af', dark: '#e5e7eb', light: '#374151', a2: '#9ca3af' },
];
const THEME_STYLES = [['gradient', 'Gradiente'], ['pixel', 'Píxeis'], ['solid', 'Sólido'], ['aurora', 'Aurora'], ['grid', 'Quadrículas'], ['conic', 'Cónico'], ['magma', 'Magma'], ['ocean', 'Ondas do oceano'], ['embers', 'Brasas'], ['crust', 'Crosta rachada'], ['neon', 'Néon'], ['clouds', 'Nuvens'], ['rain', 'Chuva'], ['marble', 'Mármore'], ['paper', 'Papel'], ['hgrid', 'Corações a cintilar'], ['jelly', 'Medusas'], ['kelp', 'Algas e bolhas'], ['bars', 'Barras'], ['linechart', 'Linha de gráfico']];
// estilos que só existem animados (Magma, Ondas, Brasas…): com "Animações ligadas" a mexer; desligadas (ou com "reduzir animações" do sistema), ficam só em imagem parada.
// O código de duas letras serve para os nomes das variáveis CSS (--mg-cover, --em-card…).
const FLUID_CODE = { magma: 'mg', ocean: 'oc', embers: 'em', crust: 'cr', neon: 'ne', clouds: 'cl', rain: 'ra', marble: 'mb', paper: 'pp', hgrid: 'hg', jelly: 'jl', kelp: 'kl', bars: 'bs', linechart: 'lc' };
const ALWAYS_ANIM = Object.keys(FLUID_CODE);
const THEME_MODES = [['dark', 'Escuro'], ['light', 'Claro'], ['autodark', 'Auto escuro'], ['autolight', 'Auto claro']];     // Auto: o fundo e as caixas ganham um toque da cor escolhida
const MODE_KEYS = THEME_MODES.map(m => m[0]);
const CAL_STYLES = [['soft', 'Padrão'], ['min', 'Minimalista'], ['grid', 'Grelha']];
const DEFAULT_THEME = { palette: 'esmeralda', style: 'gradient', mode: 'autolight', cal: 'soft', anim: false, cardStyle: false, speed: 1, amount: 3, day: 'default' };
const DAY_STYLES = [['default', 'Padrão'], ['sticker', 'Autocolante']];
const fxLevel = t => Math.min(5, Math.max(1, Math.round(+t?.amount || 3)));     // quantidade de efeitos: 1 (muito poucos) a 5 (muitos); 3 = o aspeto de sempre
/* Regra dos efeitos: a QUANTIDADE (cursor "Quantidade de efeitos") só mexe no fundo (capa e miniaturas); os cartões usam sempre CARD_LEVEL, a quantidade padrão pensada para eles.
   A VELOCIDADE (cursor "Velocidade") mexe nos dois. */
const CARD_LEVEL = 3;
const fxSpeed = t => Math.min(2, Math.max(.5, +t?.speed || 1));                  // velocidade das animações (0,5× a 2×)
const FX_AMOUNT = ['Muito poucos', 'Poucos', 'Normal', 'Bastantes', 'Muitos'];
const fxSpeedLabel = v => String(v).replace('.', ',') + '×';
const validStyle = t => {                          // estilos que já não existem caem no Gradiente; o antigo "Automático" (seguir o telemóvel) passa a Claro ou Escuro, conforme o telemóvel estava
  const okStyle = THEME_STYLES.some(s => s[0] === t.style), okPal = PALETTES.some(p => p.id === t.palette), mode = MODE_KEYS.includes(t.mode) ? t.mode : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  return okStyle && okPal && mode === t.mode ? t : { ...t, style: okStyle ? t.style : 'gradient', palette: okPal ? t.palette : 'esmeralda', mode };
};
const themeOf = p => validStyle({ ...DEFAULT_THEME, ...(p?.theme || {}) });
const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const pixelCache = {};
function pixelGradient(c1, c2) {   // gradiente "em píxeis": imagem minúscula, poucos tons e ruído ordenado, ampliada sem suavizar
  const key = c1 + c2; if (pixelCache[key]) return pixelCache[key];
  const W = 24, H = 14, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'), A = hexRgb(c1), B = hexRgb(c2), steps = 5;
  const bayer = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = x / (W - 1) * 0.7 + y / (H - 1) * 0.3;
    const k = Math.min(steps - 1, Math.max(0, Math.floor(t * (steps - 1) + bayer[y % 4][x % 4] / 16))) / (steps - 1);
    g.fillStyle = `rgb(${A.map((a, i) => Math.round(a + (B[i] - a) * k)).join(',')})`; g.fillRect(x, y, 1, 1);
  }
  return pixelCache[key] = cv.toDataURL('image/png');
}
function pixelLoop(c1, c2) {       // como pixelGradient, mas c1 → c2 → c1 na horizontal, para correr sem costura
  const key = 'L' + c1 + c2; if (pixelCache[key]) return pixelCache[key];
  const W = 48, H = 14, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'), A = hexRgb(c1), B = hexRgb(c2), steps = 5;
  const bayer = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const tri = 1 - Math.abs(2 * x / W - 1), t = tri * 0.75 + y / (H - 1) * 0.25;
    const k = Math.min(steps - 1, Math.max(0, Math.floor(t * (steps - 1) + bayer[y % 4][x % 4] / 16))) / (steps - 1);
    g.fillStyle = `rgb(${A.map((a, i) => Math.round(a + (B[i] - a) * k)).join(',')})`; g.fillRect(x, y, 1, 1);
  }
  return pixelCache[key] = cv.toDataURL('image/png');
}
const mixHex = (a, b, k = 0.5) => '#' + hexRgb(a).map((v, i) => Math.round(v + (hexRgb(b)[i] - v) * k).toString(16).padStart(2, '0')).join('');
const lumHex = h => { const [r, g, b] = hexRgb(h).map(v => v / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const palOf = id => PALETTES.find(x => x.id === id) || PALETTES[0];
/* Magma e Ondas do oceano: as cores vêm da paleta escolhida (variáveis CSS no <html>) e o movimento é só transform. */
function fluidVars(pal) {
  const [c1, c2] = pal.g, dk = (h, k) => mixHex(h, '#000000', k), rgba = (h, a) => `rgba(${hexRgb(h).join(',')},${a})`;
  return {
    '--mg-cover': `linear-gradient(180deg, ${dk(c2, .6)} 0%, ${dk(c2, .2)} 55%, ${mixHex(c1, c2, .4)} 100%)`,
    '--mg-card': `linear-gradient(180deg, ${dk(c2, .62)} 0%, ${dk(c2, .28)} 55%, ${mixHex(c1, c2, .25)} 100%)`,
    '--mg-blob': `radial-gradient(circle at 35% 30%, ${c1} 0, ${mixHex(c1, c2, .5)} 38%, ${rgba(c2, 0)} 72%)`,
    '--oc-cover': `linear-gradient(180deg, ${mixHex(c1, '#ffffff', .2)} 0%, ${c1} 30%, ${c2} 100%)`,
    '--oc-card': `linear-gradient(180deg, ${mixHex(c1, c2, .5)} 0%, ${mixHex(c1, c2, .78)} 45%, ${dk(c2, .25)} 100%)`,
    '--ow1': 'rgba(255,255,255,.22)', '--ow2': rgba(dk(c2, .1), .55), '--ow3': rgba(dk(c2, .35), .85),
    // Brasas
    '--em-cover': `radial-gradient(ellipse at 50% 120%, ${mixHex(c1, c2, .35)} 0, ${dk(c2, .3)} 40%, ${dk(c2, .8)} 85%)`,
    '--em-card': `radial-gradient(ellipse at 50% 120%, ${mixHex(c1, c2, .45)} 0, ${dk(c2, .38)} 45%, ${dk(c2, .72)} 90%)`,
    '--em-dot': mixHex(c1, '#ffffff', .35), '--em-glow': rgba(c1, .75),
    // Crosta rachada
    '--cr-cover': `radial-gradient(circle at 50% 60%, ${dk(c2, .8)}, ${dk(c2, .93)})`, '--cr-card': `radial-gradient(circle at 50% 60%, ${dk(c2, .7)}, ${dk(c2, .88)})`, '--cr-line': c1,
    // Corações
    '--ht-cover': `linear-gradient(180deg, ${dk(c2, .82)} 0%, ${dk(mixHex(c1, c2, .5), .45)} 100%)`, '--ht-card': `linear-gradient(180deg, ${dk(c2, .75)} 0%, ${dk(mixHex(c1, c2, .5), .35)} 100%)`,
    '--ht-a': mixHex(c1, '#ffffff', .3), '--ht-b': mixHex(c1, '#ffffff', .7),
    '--hg-card': 'var(--ht-card)',
    '--ne-cover': dk(c2, .9), '--ne-card': `radial-gradient(circle at 85% 50%, ${dk(c2, .62)}, ${dk(c2, .86)} 70%)`, '--ne-a': c1, '--ne-b': pal.a2, '--ne-ga': rgba(c1, .8), '--ne-gb': rgba(pal.a2, .8),
    '--cl-cover': `linear-gradient(180deg, ${dk(c2, .55)} 0%, ${dk(mixHex(c1, c2, .5), .25)} 100%)`, '--cl-card': `linear-gradient(180deg, ${dk(c2, .5)} 0%, ${dk(mixHex(c1, c2, .5), .12)} 100%)`,
    '--ra-cover': `linear-gradient(180deg, ${dk(c2, .88)} 0%, ${dk(c2, .62)} 100%)`, '--ra-card': `linear-gradient(180deg, ${dk(c2, .8)} 0%, ${dk(c2, .5)} 100%)`, '--ra-a': 'rgba(255,255,255,.55)', '--ra-b': rgba(c1, .6),
    '--mb-cover': dk(c2, .8), '--mb-card': dk(c2, .7), '--mb-vein': c1,
    '--pp-cover': (b => `linear-gradient(40deg, transparent 0 38%, rgba(0,0,0,.18) 38% 39%, transparent 39% 64%, rgba(255,255,255,.1) 64% 65%, transparent 65%), linear-gradient(115deg, ${dk(b, .5)} 0 28%, ${dk(b, .38)} 28% 50%, ${dk(b, .62)} 50% 71%, ${dk(b, .5)} 71%)`)(mixHex(c1, c2, .5)),
    '--pp-card': 'var(--pp-cover)',      // o cartão leva as mesmas facetas e vincos do fundo
    // Aquário e finanças
    '--kl-cover': 'var(--jl-cover)', '--kl-card': 'var(--jl-card)', '--kl-a': mixHex(c1, '#ffffff', .25), '--kl-b': mixHex(c1, c2, .5),
    '--jl-cover': `linear-gradient(180deg, ${dk(mixHex(c1, c2, .5), .45)} 0%, ${dk(c2, .88)} 100%)`, '--jl-card': `linear-gradient(180deg, ${dk(mixHex(c1, c2, .5), .4)} 0%, ${dk(c2, .8)} 100%)`, '--jl-a': mixHex(c1, '#ffffff', .45), '--jl-b': mixHex(c1, '#ffffff', .85),
    '--bs-cover': `linear-gradient(${dk(c2, .9)}, ${dk(c2, .9)})`, '--bs-card': `linear-gradient(${dk(c2, .88)}, ${dk(c2, .88)})`, '--bs-a': c1, '--bs-b': mixHex(c1, '#ffffff', .5),
    '--lc-card': 'var(--bs-card)',
  };
}
// Cada elemento tem o nível (1–5) a partir do qual aparece: no nível 3 há os de sempre, abaixo há menos e acima há mais.
const upTo = (list, lvl) => list.filter(x => x.l <= lvl);
const WAVES = [{ n: 4, y: 55, l: 4 }, { n: 1, y: 70, l: 3 }, { n: 2, y: 95, l: 2 }, { n: 5, y: 106, l: 5 }, { n: 3, y: 118, l: 1 }]
  .map(w => ({ ...w, d: 'M0 ' + w.y + ' Q100 ' + (w.y - 28) + ' 200 ' + w.y + ' T400 ' + w.y + ' T600 ' + w.y + ' T800 ' + w.y + ' V150 H0Z' }));
const MG_BLOBS = [[92, 12, -30, 1, 9, 0, 2], [128, 42, -60, 2, 12, -4, 1], [70, 72, -24, 1, 8, -2, 1], [56, 28, -20, 2, 10, -7, 3], [100, 84, -50, 2, 13, -9, 3],
  [80, 56, -40, 1, 11, -5, 4], [64, 4, -26, 2, 9, -3, 4], [76, 92, -30, 1, 10, -6, 5]].map(([w, left, bottom, k, dur, delay, l]) => ({ w, left, bottom, k, dur, delay, l }));   // [tamanho, esquerda %, fundo px, tipo de subida, duração, atraso, nível]
const MG_BUBBLES = [[7, 20, 5, 0, 3], [5, 52, 6.5, -2, 1], [9, 66, 7.5, -4, 3], [6, 90, 5.5, -1, 2], [6, 38, 6, -3, 4], [8, 78, 7, -5, 4], [5, 8, 5.8, -1.5, 5]]
  .map(([w, left, dur, delay, l]) => ({ w, left, dur, delay, l }));
const EMBERS = [[12, 5, 12, -.4, 5, 2], [24, 8, -14, -2.1, 6.4, 1], [33, 4, 18, -3.3, 5, 3], [45, 7, -10, -1.2, 5.6, 2], [55, 5, 16, -4.1, 5, 3], [64, 9, -18, -2.7, 7, 1], [73, 4, 10, -.9, 5, 3], [82, 6, -12, -3.8, 5.2, 2], [91, 5, 14, -1.8, 5, 1],
  [18, 6, -9, -5.2, 5.4, 4], [38, 5, 11, -2.4, 6, 4], [60, 4, -13, -3.6, 5, 4], [69, 7, 9, -.6, 6.6, 5], [86, 5, -8, -4.6, 5.8, 5], [8, 4, 14, -1.4, 5.2, 5]].map(([left, size, dx, delay, dur, l]) => ({ left, size, dx, delay, dur, l }));   // [esquerda %, tamanho px, deslocação lateral, atraso, duração, nível]
const CRACKS = [['l1', '<path class="crk" stroke-width="3" d="M0 120 L40 100 L70 112 L110 82 L150 95 L190 60 L230 74 L300 40"/>', 1],
  ['l2', '<path class="crk" stroke-width="3" d="M20 150 L60 130 L100 140 L140 118 L180 132 L240 100 L300 112"/>', 2],
  ['l1', '<path class="crk" stroke-width="2" d="M110 82 L120 50 L150 30"/>', 3],
  ['l2', '<path class="crk" stroke-width="2" d="M190 60 L210 30 L250 15"/>', 3],
  ['l1', '<path class="crk" stroke-width="2.5" d="M300 130 L260 115 L230 128 L200 104 L170 112 L150 90"/>', 4],
  ['l2', '<path class="crk" stroke-width="2" d="M60 20 L90 45 L80 70 L115 85"/>', 4],
  ['l1', '<path class="crk" stroke-width="2" d="M0 60 L35 70 L60 55 L95 62"/>', 5],
  ['l2', '<path class="crk" stroke-width="2" d="M300 90 L270 80 L255 55 L220 48"/>', 5]].map(([c, p, l]) => ({ c, p, l }));
// ---- Estilos novos (Néon, Nuvens, Chuva, Mármore, Papel): mesma regra dos outros (parados por defeito; mexem com as animações ligadas).
// Posições bem espalhadas em qualquer número de elementos (sequência R2), e o nível a partir do qual cada elemento aparece (limiares = quantos há em cada nível 1–5).
const R2 = i => [(0.5 + 0.7548776662 * (i + 1)) % 1, (0.5 + 0.5698402910 * (i + 1)) % 1];
const gen = (thr, f) => Array.from({ length: thr[thr.length - 1] }, (_, i) => { const [u, v] = R2(i); return { l: thr.findIndex(n => i < n) + 1, ...f(i, u, v) }; });
const CLOUDS = [[12, 100, 32, 18, -5, 1, 20], [66, 140, 38, 24, -14, 1, 70], [104, 90, 28, 15, -2, 2, 40], [36, 80, 26, 13, -9, 3, 85], [84, 120, 34, 20, -17, 4, 15], [0, 70, 22, 12, -7, 4, 55], [120, 110, 30, 19, -11, 5, 30], [50, 150, 40, 26, -20, 5, 75]]
  .map(([top, w, h, dur, delay, l, cx]) => ({ top, w, h, dur, delay, l, cx }));
const RAIN = gen([10, 16, 24, 34, 48], (i, u, v) => ({ x: 2 + u * 96, h: 14 + ((i * 3) % 3) * 6, dur: .8 + ((i * 7) % 5) * .12, delay: -(v * 1.5) }));
const MARBLE = [[1, 2.5, 'M0 110 C50 95 70 60 120 70 S200 40 250 48 S290 30 300 28'], [1, 1.5, 'M40 150 C70 120 110 126 150 104 S230 92 290 70'], [2, 2, 'M200 150 C220 128 250 118 300 122'],
  [3, 1.5, 'M0 40 C40 50 70 30 110 34 S170 20 200 10'], [4, 1.5, 'M90 0 C100 30 80 50 110 76 S120 110 100 150'], [5, 1.2, 'M250 0 C240 30 270 50 255 80 S280 110 270 150']]
  .map(([l, w, d], i) => ({ l, w, d, c: i % 2 ? 'm2' : 'm1' }));
const SHEENS = [{ l: 1, x: 30 }, { l: 3, x: 62 }, { l: 4, x: 12 }, { l: 5, x: 80 }];
// Corações a cintilar: tamanho em px, posição em %, e o nível a partir do qual cada um aparece
const HEART_PATH = 'M12 21s-7.5-4.6-9.6-9.2C.9 8.2 3 5 6.2 5c2 0 3.5 1.1 4.3 2.4h3C14.3 6.1 15.8 5 17.8 5 21 5 23.1 8.2 21.6 11.8 19.5 16.4 12 21 12 21z';
const HEART_LATTICE = Array.from({ length: 6 }, (_, row) => Array.from({ length: row % 2 ? 9 : 10 }, (_, col) => ({ x: (row % 2 ? 10 : 5) + col * 10, y: 10 + row * 16 }))).flat();   // grelha centrada: as linhas ficam simétricas em relação ao meio
const HEARTS_CARD = lvl => { const n = [6, 8, 10, 12, 14][lvl - 1]; return Array.from({ length: n }, (_, i) => ({ x: 9 + i * 82 / (n - 1), y: 88, s: 13, dx: 0, r: 0, dur: 2.4, delay: -(i * .22) })); };   // nos cartões: uma fila pequena no rodapé, por baixo dos números, a acender em onda
const HEARTS = {
  hgrid: gen([10, 18, 32, 44, 57], (i) => { const p = HEART_LATTICE[(i * 37) % 57]; return { x: p.x, y: p.y, s: 23, dx: 0, r: 0, dur: 1.4 + ((i * 7) % 5) * .3, delay: -((i * .37) % 3) }; }),
};
// Aquário (Medusas, Cardume) e Finanças (Barras, Linha de gráfico): tudo com nível 1–5 de "Quantidade"
const BAR_N = [5, 7, 9, 12, 16], LINE_N = [5, 7, 9, 12, 16];
const barsFor = lvl => Array.from({ length: BAR_N[lvl - 1] }, (_, i) => ({ x: (i + .5) / BAR_N[lvl - 1] * 100, w: 55 / BAR_N[lvl - 1], h: 26 + ((i * 37 + lvl * 5) % 11) / 10 * 64, dur: 1.8 + ((i * 7) % 5) * .3, delay: -((i * .43) % 3) }));
const linePts = lvl => { const n = LINE_N[lvl - 1], P = Array.from({ length: n }, (_, i) => ({ x: i / (n - 1) * 300, y: Math.min(128, Math.max(22, 78 + 34 * Math.sin(i / (n - 1) * Math.PI * 3 + .6) + (R2(i + 1)[0] - .5) * 30)) })); P[n - 1].y = P[0].y; return P; };   // periódica: o fim encaixa no princípio
// Medusas (profundidade): camada de trás (pequenas, quase apagadas, lentas) + camada da frente (maiores, mais nítidas, com brilho). Nos cartões ficam na coluna da direita.
const JELLY = [
  ...gen([2, 4, 6, 8, 10], (i, u, v) => ({ x: 8 + u * 84, w: 14 + (i % 2) * 4, dur: 18 + v * 6, delay: -(v * 24), dx: (u - .5) * 20, far: true, y: 15 + v * 70 })),
  ...gen([1, 2, 3, 4, 5], (i, u, v) => ({ x: [78, 18, 52, 90, 36][i], w: 34 + (i % 2) * 10, dur: 10 + v * 3, delay: -(v * 13), dx: (u - .5) * 30, far: false, y: 25 + v * 55 })),
];
const JELLY_CARD = [{ x: 24, w: 22, y: 80, dur: 14, delay: 0, o: .85 }, { x: 52, w: 16, y: 87, dur: 20, delay: -8, o: .5 }, { x: 78, w: 26, y: 76, dur: 17, delay: -4, o: .7 }];      // nos cartões: três medusas que navegam pela faixa de baixo, por baixo dos números
// Algas e bolhas: algas a balançar (nos cantos da capa, na coluna da direita do cartão) e bolhas a subir
const KELP_W = [3, 94, 9, 87, 15, 80, 21, 73].map((x, i) => ({ x, cx: [95, 72, 88, 80, 92, 76, 84, 68][i], l: [1, 1, 2, 3, 4, 4, 5, 5][i], h: 40 + ((i * 37) % 5) * 6, dur: 3 + ((i * 7) % 5) * .4, k: i % 2 }));
const KELP_B = gen([4, 6, 9, 12, 16], (i, u, v) => ({ x: 4 + u * 92, s: 4 + (i % 3) * 2, dur: 4 + v * 4, delay: -(v * 8) }));
const kelpPath = h => 'M8 ' + h + ' C0 ' + (h * .7) + ' 16 ' + (h * .5) + ' 8 ' + (h * .25) + ' C4 ' + (h * .12) + ' 10 0 8 0';
const JELLY_SVG = (a, b, sc) => `<g transform='scale(${sc})'><path d='M4 24 C4 4 36 4 36 24Z' fill='${a}'/><path d='M10 24 C10 12 30 12 30 24Z' fill='${b}' fill-opacity='.6'/><g stroke='${a}' stroke-width='1.8' fill='none' stroke-linecap='round'><path d='M10 24 Q6 36 10 46'/><path d='M16 24 Q20 38 15 52'/><path d='M24 24 Q20 38 25 52'/><path d='M30 24 Q34 36 30 46'/></g></g>`;
/* Néon (capa e miniaturas): sol e chão em grelha em perspetiva (estilo retro). O nível 1–5 define quantas linhas há; animado, as linhas horizontais avançam para o espetador (CSS, por linha). */
function neonFloor(lvl, anim, A, B, bg) {
  const n = [3, 4, 5, 6, 7][lvl - 1] || 5, m = [5, 7, 9, 11, 13][lvl - 1] || 9, H = 70, ys = Array.from({ length: n + 1 }, (_, k) => H + 80 * Math.pow(k / n, 2));
  const two = (x1, y1, x2, y2, wide, thin, cls = '', sty = '') => `<g${cls ? ` class="${cls}"` : ''}${sty ? ` style="${sty}"` : ''}><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="stroke:${A};stroke-width:${wide};stroke-opacity:.22"/><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="stroke:${A};stroke-width:${thin}"/></g>`;
  const fan = Array.from({ length: m }, (_, j) => { const xe = 170 + (j - (m - 1) / 2) * (740 / (m - 1)); return two(170, H, xe.toFixed(1), 150, 3.6, 1); }).join('');
  const hz = ys.slice(anim ? 0 : 1, n).map((y, i) => { const k = i + (anim ? 0 : 1); return two(0, y.toFixed(1), 340, y.toFixed(1), 3.6, 1, anim ? 'nf-l' : '', anim ? `--dy:${(ys[k + 1] - y).toFixed(2)}px` : ''); }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 150" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs>
    <linearGradient id="nfg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${B}"/><stop offset="1" style="stop-color:${A}"/></linearGradient>
    <linearGradient id="nfh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${A};stop-opacity:0"/><stop offset="1" style="stop-color:${A};stop-opacity:.28"/></linearGradient></defs>
    <rect x="0" y="40" width="340" height="30" fill="url(#nfh)"/>
    <path d="M132 70A38 38 0 0 1 208 70Z" fill="url(#nfg)" fill-opacity=".9"/>
    ${fan}${hz}${two(0, H, 340, H, 4.4, 1.6)}</svg>`;
}
function fluidInner(kind, lvl = fxLevel(appliedTheme), foot = false, card = false) {      // os elementos que se mexem em cada estilo animado
  switch (kind) {
    case 'magma': return upTo(MG_BLOBS, lvl).map(b => '<i class="bl" style="width:' + b.w + 'px;height:' + b.w + 'px;left:' + b.left + '%;margin-left:-' + b.w / 2 + 'px;bottom:' + b.bottom + 'px;animation:mgRise' + b.k + ' ' + b.dur + 's ease-in-out ' + b.delay + 's infinite"></i>').join('')
      + upTo(MG_BUBBLES, lvl).map(b => '<i class="bb" style="width:' + b.w + 'px;height:' + b.w + 'px;left:' + b.left + '%;animation:mgBub ' + b.dur + 's linear ' + b.delay + 's infinite"></i>').join('');
    case 'embers': return upTo(EMBERS, lvl).map(e => '<i class="em" style="left:' + e.left + '%;width:' + e.size + 'px;height:' + e.size + 'px;--dx:' + e.dx + 'px;animation-delay:' + e.delay + 's;animation-duration:' + e.dur + 's"></i>').join('');
    case 'hgrid':
      return (card ? HEARTS_CARD(lvl) : upTo(HEARTS[kind], lvl)).map(h => '<i class="ht" style="left:' + h.x + '%;top:' + h.y + '%;margin:-' + h.s / 2 + 'px 0 0 -' + h.s / 2 + 'px;width:' + h.s + 'px;height:' + h.s + 'px;--dx:' + h.dx + 'px;--r:' + h.r + 'deg;animation-duration:' + h.dur + 's;animation-delay:' + h.delay + 's"></i>').join('');
    case 'bars': return barsFor(lvl).map(b => '<i class="br" style="left:' + b.x + '%;width:' + b.w + '%;margin-left:-' + b.w / 2 + '%;height:' + Math.round(b.h * (foot ? .68 : 1)) + 'px;animation-duration:' + b.dur + 's;animation-delay:' + b.delay + 's"></i>').join('');
    case 'linechart': {                              // duas voltas lado a lado; a faixa desliza uma volta e recomeça sem emenda (a linha sai pela direita e volta a entrar)
      const P = linePts(lvl), PP = [...P, ...P.slice(1).map(p => ({ x: p.x + 300, y: p.y }))], pl = PP.map(p => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
      return '<div class="lc-track"><svg viewBox="0 0 600 150" preserveAspectRatio="none" aria-hidden="true"><path class="ar" d="M0 150 L' + PP.map(p => p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' L') + ' L600 150Z"/><polyline class="ln" points="' + pl + '"/></svg>'
        + PP.map(p => '<i class="dt" style="left:' + (p.x / 6).toFixed(2) + '%;top:' + (p.y / 1.5).toFixed(2) + '%"></i>').join('') + '</div>'; }
    case 'jelly': if (card) return JELLY_CARD.map(j => '<i class="jf" style="width:' + j.w + 'px;height:' + Math.round(j.w * 1.4) + 'px;--o:' + j.o + ';animation-duration:' + j.dur + 's,2.6s;animation-delay:' + j.delay + 's,' + (j.delay / 3) + 's"></i>').join('');
      return upTo(JELLY, lvl).map(j => '<i class="jf ' + (j.far ? 'far' : 'near') + '" style="left:' + j.x.toFixed(1) + '%;margin-left:-' + j.w / 2 + 'px;width:' + j.w + 'px;height:' + Math.round(j.w * 1.4) + 'px;--dx:' + j.dx.toFixed(1) + 'px;--o:' + (j.far ? .25 : .82) + ';animation-duration:' + j.dur + 's,2.6s;animation-delay:' + j.delay + 's,' + (j.delay / 3) + 's"></i>').join('');
    case 'kelp': {
      const k = card ? .62 : 1;
      return KELP_W.filter(w => w.l <= lvl).map(w => { const h = Math.round(w.h * k); return '<svg class="wd" viewBox="0 0 16 ' + h + '" style="left:' + (card ? w.cx : w.x) + '%;width:16px;height:' + h + 'px;animation-duration:' + w.dur + 's;animation-delay:' + (-w.dur * (w.x % 3) / 3) + 's"><path d="' + kelpPath(h) + '" fill="none" stroke-width="5" stroke-linecap="round" style="stroke:var(--kl-' + (w.k ? 'b' : 'a') + ')"/></svg>'; }).join('')
        + upTo(KELP_B, lvl).map(b => '<i class="bb" style="left:' + (card ? 64 + (b.x - 4) / 92 * 33 : b.x).toFixed(1) + '%;width:' + b.s + 'px;height:' + b.s + 'px;animation-duration:' + b.dur + 's;animation-delay:' + b.delay + 's"></i>').join('');
    }
    case 'crust': return '<svg viewBox="0 0 300 150" preserveAspectRatio="none" aria-hidden="true">' + upTo(CRACKS, lvl).map(c => '<g class="' + c.c + '">' + c.p + '</g>').join('') + '</svg>';
    case 'neon': if (card) return '<div class="nx-trk"><i class="nx-bm"></i><i class="nx-bm"></i></div>';      // cartões: só uma linha fina no rodapé com feixes de luz (ver startNeonSweep)
      return neonFloor(lvl, true, 'var(--ne-a)', 'var(--ne-b)', 'var(--ne-cover)');       // capa: sol e chão em grelha
    case 'clouds': return upTo(CLOUDS, lvl).map((c, i) => '<i class="cd" style="top:' + (card ? (i % 2 ? 108 : -6) : c.top) + 'px;width:' + c.w + 'px;height:' + c.h + 'px;animation-duration:' + c.dur + 's;animation-delay:' + c.delay + 's"></i>').join('');
    case 'rain': return upTo(RAIN, lvl).map(d => '<i class="dr' + (d.h > 20 ? ' b' : '') + '" style="left:' + d.x + '%;height:' + d.h + 'px;animation-duration:' + d.dur + 's;animation-delay:' + d.delay + 's"></i>').join('');
    case 'marble': return '<svg viewBox="0 0 300 150" preserveAspectRatio="none" aria-hidden="true">' + upTo(MARBLE, lvl).map(v => '<g class="' + v.c + '"><path class="mv" stroke-width="' + v.w + '" d="' + v.d + '"/></g>').join('') + '</svg>';
    case 'paper': return upTo(SHEENS, lvl).map((s, i) => '<i class="sh" style="left:' + (s.x - 40) + '%;animation-duration:' + (7 + i * 2) + 's;animation-delay:' + (-i * 3) + 's"></i>').join('');
    default: return upTo(WAVES, lvl).map(w => '<svg class="wv w' + w.n + '" viewBox="0 0 800 150" preserveAspectRatio="none" aria-hidden="true"><path class="wp' + w.n + '" d="' + w.d + '"/></svg>').join('');   // ondas
  }
}
const svgUri = s => 'data:image/svg+xml,' + encodeURIComponent(s).replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
const fluidMotion = t => ALWAYS_ANIM.includes(t.style) && !!t.anim && !matchMedia('(prefers-reduced-motion: reduce)').matches;   // este estilo deve mexer-se agora?
const CLASSIC_CARD = ['pixel', 'aurora', 'grid', 'conic'];       // estilos "normais" que também animam nos cartões (a camada roda/desliza como na capa)
const classicCardMotion = t => !!t.cardStyle && !!t.anim && !ALWAYS_ANIM.includes(t.style) && CLASSIC_CARD.includes(t.style) && !matchMedia('(prefers-reduced-motion: reduce)').matches;
const FOOT_KINDS = ['bars', 'linechart'];      // nos cartões não ficam bem a ocupar tudo: têm o seu próprio "rodapé suave" (faixa em baixo, esbatida), sobre o gradiente normal do cartão
/* Fila de pontos no fundo de um cartão de total: [[valor, legenda], …]. Cada cartão mostra primeiro o que mais importa (o número grande) e só depois estes. */
const eq = n => '= ' + nf(n) + ' €';                  // valores equivalentes ou médias (por ano, por mês, por dia): levam "=" em vez do sinal de gasto
const btStats = items => `<div class="bt-stats">${items.filter(Boolean).map(([v, l]) => `<div><strong>${v}</strong><em>${l}</em></div>`).join('')}</div>`;
/* Néon nos cartões: uma linha fina no rodapé, com feixes de luz. Cada ciclo sorteia uma de quatro variações (sem repetir a anterior):
   vai e volta com ritmos diferentes · cor e largura que mudam · dois feixes que se cruzam · tudo sorteado (direção, velocidade, pausa, faísca). */
function startNeonSweep(layer) {
  const trk = layer?.querySelector('.nx-trk'); if (!trk || layer._nx) return; layer._nx = true;
  const bm = [...trk.querySelectorAll('.nx-bm')];
  const COL = ['var(--ne-a)', 'var(--ne-b)', 'color-mix(in srgb, var(--ne-a) 50%, #fff)'], GL = ['var(--ne-ga)', 'var(--ne-gb)', 'var(--ne-ga)'];
  const rnd = (a, b) => a + Math.random() * (b - a), pick = n => Math.floor(Math.random() * n), wait = ms => new Promise(r => setTimeout(r, ms));
  const run = (el, w, ci, dir, d, ease = 'linear') => {                          // uma passagem de um feixe
    el.style.display = 'block'; el.style.width = w + '%'; el.style.background = `linear-gradient(90deg, transparent, ${COL[ci]}, transparent)`; el.style.boxShadow = `0 0 8px ${GL[ci]}`;
    const a = el.animate([{ left: (dir > 0 ? -w : 100) + '%' }, { left: (dir > 0 ? 100 : -w) + '%' }], { duration: d * 1000, easing: ease, fill: 'forwards' });
    a.playbackRate = fxSpeed(appliedTheme);
    return a.finished;
  };
  let last = -1;
  (async () => {
    try {
      while (layer.isConnected) {
        if (!fluidMotion(appliedTheme) || document.hidden) { await wait(800); continue; }
        let m; do m = pick(4); while (m === last); last = m;
        bm[1].style.display = 'none';
        if (m === 0) { await run(bm[0], 35, 0, 1, rnd(3, 3.8), 'ease-in-out'); await run(bm[0], 35, 0, -1, rnd(1.6, 2), 'ease-in-out'); }
        else if (m === 1) { const W = [45, 20, 32], i = pick(3); await run(bm[0], W[i], i, 1, 2.6); }
        else if (m === 2) await Promise.all([run(bm[0], 30, 0, 1, rnd(2.2, 3.4)), run(bm[1], 24, 1, -1, rnd(3, 3.8))]);
        else {
          await run(bm[0], Math.round(rnd(15, 55)), pick(3), Math.random() < .5 ? 1 : -1, rnd(1.4, 4));
          if (Math.random() < .25) await trk.animate([{ filter: 'brightness(1)' }, { filter: 'brightness(3)' }, { filter: 'brightness(1)' }], { duration: 500 }).finished;
          await wait(Math.round(rnd(0, 1100)));
        }
        await wait(250);
      }
    } catch { layer._nx = false; }                                                // a camada foi removida a meio: acaba em silêncio
  })();
}
function decorateTotals() {                         // nos cartões de total, acrescenta a camada do estilo animado e tira-a se o estilo mudar ou as animações se desligarem
  const t = appliedTheme, foot = t.cardStyle && FOOT_KINDS.includes(t.style) ? t.style : null;
  const fk = !foot && t.cardStyle && fluidMotion(t) ? t.style : null, ck = classicCardMotion(t) ? t.style : null;
  const kind = foot || fk || ck, key = foot ? CARD_LEVEL + (t.anim ? 'a' : 's') : fk ? String(CARD_LEVEL) : ck ? t.palette : '';
  document.querySelectorAll('.big-total').forEach(c => {
    const cur = c.querySelector(':scope > .cv-card');
    if (cur && cur.dataset.k === kind && cur.dataset.n === key) return;
    cur?.remove();
    if (foot) c.insertAdjacentHTML('afterbegin', `<div class="cv-card cv-foot" data-k="${foot}" data-n="${key}"${t.anim ? '' : ' data-still="1"'}><div class="ft">${fluidInner(foot, CARD_LEVEL, true)}</div></div>`);
    else if (fk) { c.insertAdjacentHTML('afterbegin', `<div class="cv cv-card cv-${fk}" data-k="${fk}" data-n="${key}">${fluidInner(fk, +key, false, true)}</div>`); if (fk === 'neon') startNeonSweep(c.querySelector(':scope > .cv-card')); }
    else if (ck) { const wr = document.createElement('div'); wr.className = 'cv-card cvw'; wr.dataset.k = ck; wr.dataset.n = key; const d = document.createElement('div'); d.className = 'cvc'; d.dataset.k = ck; d.style.background = coverLayer(ck, palOf(t.palette)); wr.appendChild(d); c.prepend(wr); }
  });
  // Animação padrão do cartão (com as animações ligadas): duas manchas de cor, uma de cada cor da paleta, a deslizar devagar uma contra a outra.
  const drift = !!t.anim && !fk && !ck && !foot && !(t.cardStyle && t.style === 'solid');
  document.querySelectorAll('.big-total').forEach(c => {
    const d = c.querySelector(':scope > .cv-drift');
    if (!drift) { d?.remove(); return; }
    if (!d) c.prepend(Object.assign(document.createElement('div'), { className: 'cv-drift', innerHTML: '<i></i><i></i>' }));
    else if (c.firstElementChild !== d) c.prepend(d);                              // fica sempre por baixo das outras camadas
  });
}
/* Capa animada: em vez de redesenhar o fundo a cada fotograma, há uma camada (.cv) que a placa gráfica roda, desliza ou amplia (só transform).
   `coverLayer` devolve o desenho dessa camada; o CSS (por data-gs) diz como ela se mexe. */
function coverLayer(style, pal) {
  const [c1, c2] = pal.g, w = a => `rgba(255,255,255,${a})`;
  switch (style) {
    case 'pixel': return `url(${pixelLoop(c1, c2)}) 0 0 / 480px 100% repeat-x`;
    case 'aurora': return `radial-gradient(circle at 36% 46%, ${c1} 0, transparent 24%), radial-gradient(circle at 64% 50%, ${c2} 0, transparent 24%), radial-gradient(circle at 50% 62%, ${pal.a2} 0, transparent 22%), ${mixHex(c1, c2)}`;
    case 'grid': return `linear-gradient(${w(.22)} 1px, transparent 1px) 0 0 / 12px 12px, linear-gradient(90deg, ${w(.22)} 1px, transparent 1px) 0 0 / 12px 12px`;
    case 'conic': return `conic-gradient(from 210deg, ${c1}, ${c2}, ${c1})`;
    default: return `linear-gradient(135deg, ${c1} 35%, ${c2} 65%)`;       // gradiente
  }
}
function themeBg(style, pal, small = false, card = false) {     // o "fundo de destaque" de cada estilo (valor de `background`); small = miniatura da lista
  const [c1, c2] = pal.g, lin = `linear-gradient(135deg, ${c1} 0%, ${c2} 100%)`, w = a => `rgba(255,255,255,${a})`;
  const lv = card ? CARD_LEVEL : fxLevel(appliedTheme);       // nos cartões, a quantidade é sempre a padrão
  switch (style) {
    case 'solid': return pal.s;
    case 'pixel': return `url(${pixelGradient(c1, c2)}) center / 100% 100% no-repeat`;
    case 'aurora': return `radial-gradient(circle at 12% 18%, ${c1} 0, transparent 58%), radial-gradient(circle at 88% 22%, ${c2} 0, transparent 58%), radial-gradient(circle at 55% 105%, ${pal.a2} 0, transparent 62%), ${mixHex(c1, c2)}`;
    case 'grid': return `linear-gradient(${w(.22)} 1px, transparent 1px) 0 0 / 12px 12px, linear-gradient(90deg, ${w(.22)} 1px, transparent 1px) 0 0 / 12px 12px, ${lin}`;
    case 'conic': return `conic-gradient(from 210deg at ${card ? 80 : 50}% 50%, ${c1}, ${c2}, ${c1})`;
    // Imagens paradas (miniaturas da lista e cartões/capa sem animações). Os raios das bolhas estão em % do tamanho da caixa, por isso escalam do mosaico pequeno ao cartão grande.
    case 'magma': {      // a mesma imagem do fundo animado: bolhas grandes com brilho no canto, bolinhas pequenas e o mesmo degradê
      const dk = (h, k) => mixHex(h, '#000000', k), mid = mixHex(c1, c2, .5), yb = small ? 92 : 88.5;
      const blobs = upTo(MG_BLOBS, lv).map((b, i) => { const r = b.w / 2 / 1.95, lift = ((i * 37) % 5) / 5 * 60; return `<circle cx='${(b.left * 2).toFixed(1)}' cy='${(yb - (b.bottom + b.w / 2 + lift) / 1.95).toFixed(1)}' r='${r.toFixed(1)}' fill='url(#g)' fill-opacity='.95'/>`; }).join('');
      const bubs = upTo(MG_BUBBLES, lv).map((b, i) => `<circle cx='${(b.left * 2).toFixed(1)}' cy='${(yb - 14 - ((i * 53) % 9) * 6).toFixed(1)}' r='${(b.w / 2 / 1.95 * 1.6).toFixed(1)}' fill='#fff' fill-opacity='.5'/>`).join('');
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 100' preserveAspectRatio='xMidYMid slice'><defs><radialGradient id='g' cx='.35' cy='.3' r='.955'><stop offset='0' stop-color='${c1}'/><stop offset='.38' stop-color='${mid}'/><stop offset='.72' stop-color='${c2}' stop-opacity='0'/></radialGradient></defs>${blobs}${bubs}</svg>`;
      return `url(${svgUri(svg)}) center / 100% 100% no-repeat, linear-gradient(180deg, ${dk(c2, .6)} 0%, ${dk(c2, .2)} 55%, ${mixHex(c1, c2, .4)} 100%)`;
    }
    case 'ocean': {
      const dk = (h, k) => mixHex(h, '#000000', k), rgba = (h, a) => `rgba(${hexRgb(h).join(',')},${a})`;
      const fills = ['rgba(255,255,255,.3)', rgba(dk(c2, .2), .55), rgba(dk(c2, .45), .88)];
      const ws = upTo([{ y: 28, f: 0, l: 4 }, { y: 38, f: 0, l: 3 }, { y: 58, f: 1, l: 2 }, { y: 68, f: 1, l: 5 }, { y: 77, f: 2, l: 1 }], lv);
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 100' preserveAspectRatio='none'>${ws.map(({ y, f }) => `<path fill='${fills[f]}' d='M0 ${y} Q25 ${y - 17} 50 ${y} T100 ${y} T150 ${y} T200 ${y} V100 H0Z'/>`).join('')}</svg>`;
      return `url(${svgUri(svg)}) center / 100% 100% no-repeat, linear-gradient(180deg, ${mixHex(c1, '#ffffff', .2)} 0%, ${c1} 30%, ${c2} 100%)`;
    }
    case 'embers': {
      const dk = (h, k) => mixHex(h, '#000000', k), dot = mixHex(c1, '#ffffff', .4), glow = `rgba(${hexRgb(c1).join(',')},.55)`;
      const e = (x, y, r) => `radial-gradient(circle at ${x}% ${y}%, ${dot} 0 ${r}px, ${glow} ${r + 1}px, transparent ${r + 6}px)`;
      const es = upTo([[33, 40, 1.5, 1], [78, 58, 2, 1], [16, 66, 2, 2], [64, 30, 1.5, 2], [50, 74, 2.5, 3], [90, 22, 1.5, 3], [8, 30, 1.5, 4], [42, 82, 2, 4], [70, 70, 1.5, 4], [24, 18, 1.5, 5], [58, 50, 2, 5], [84, 80, 2, 5]].map(([x, y, r, l]) => ({ x, y, r, l })), lv);
      return `${es.map(q => e(q.x, q.y, q.r)).join(', ')}, radial-gradient(ellipse at 50% 125%, ${mixHex(c1, c2, .35)} 0, ${dk(c2, .35)} 45%, ${dk(c2, .8)} 90%)`;
    }
    case 'hgrid': {      // corações: imagem parada com tantos corações quantos o nível de "Quantidade"
      const dk = (h, k) => mixHex(h, '#000000', k), a = mixHex(c1, '#ffffff', .3), b = mixHex(c1, '#ffffff', .7);
      const items = (card ? HEARTS_CARD(lv) : upTo(HEARTS[style], lv)).filter((p, i) => !small || i % 2 === 0);
      const hs = items.map((p, i) => { const sc = (p.s / 1.95 / 24) * (small ? 1.55 : 1), op = i % 2 ? .45 : .9;
        return `<path fill='${i % 3 ? a : b}' fill-opacity='${op}' transform='translate(${(p.x * 2).toFixed(1)} ${(style === 'hgrid' ? p.y : 6 + p.y * .88).toFixed(1)}) rotate(${Math.round(p.r)}) scale(${sc.toFixed(3)}) translate(-12 -12)' d='${HEART_PATH}'/>`; }).join('');
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 100' preserveAspectRatio='xMidYMid slice'>${hs}</svg>`;
      return `url(${svgUri(svg)}) center / 100% 100% no-repeat, linear-gradient(180deg, ${dk(c2, .82)} 0%, ${dk(mixHex(c1, c2, .5), .45)} 100%)`;
    }
    case 'jelly': {      // miniaturas nítidas, desenhadas em vetor: as de trás apagadas, as da frente nítidas
      const dk = (h, k) => mixHex(h, '#000000', k), a = mixHex(c1, '#ffffff', .45), b = mixHex(c1, '#ffffff', .85);
      const list = card ? JELLY_CARD : upTo(JELLY, lv).sort((p, q) => (q.far ? 1 : 0) - (p.far ? 1 : 0));
      const js = list.map(j => { const sc = (j.w / 1.95 / 40) * (small ? 1.5 : 1); return `<g opacity='${card ? j.o : j.far ? .3 : .9}' transform='translate(${(j.x * 2 - 20 * sc).toFixed(1)} ${card ? j.y : (j.y - 10).toFixed(1)})'>${JELLY_SVG(a, b, sc.toFixed(3))}</g>`; }).join('');
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 100' preserveAspectRatio='xMidYMid slice'>${js}</svg>`;
      return `url(${svgUri(svg)}) center / 100% 100% no-repeat, linear-gradient(180deg, ${dk(mixHex(c1, c2, .5), .45)} 0%, ${dk(c2, .88)} 100%)`;
    }
    case 'kelp': {
      const dk = (h, k) => mixHex(h, '#000000', k), A = mixHex(c1, '#ffffff', .25), B = mixHex(c1, c2, .5), yb = small ? 100 : 88.5, k = card ? .62 : 1, sc = (small ? 1.5 : 1) / 1.95;
      const wd = KELP_W.filter(w => w.l <= lv).map(w => { const h = Math.round(w.h * k); return `<g transform='translate(${((card ? w.cx : w.x) * 2 - 8 * sc).toFixed(1)} ${(yb - h * sc).toFixed(1)}) scale(${sc.toFixed(3)})'><path d='${kelpPath(h)}' fill='none' stroke='${w.k ? B : A}' stroke-width='5' stroke-linecap='round'/></g>`; }).join('');
      const bb = upTo(KELP_B, lv).filter((b, i) => !small || i % 2 === 0).map((b, i) => `<circle cx='${((card ? 64 + (b.x - 4) / 92 * 33 : b.x) * 2).toFixed(1)}' cy='${(yb - 14 - ((i * 53) % 9) * 7).toFixed(1)}' r='${(b.s / 2 * sc).toFixed(2)}' fill='none' stroke='#ffffff' stroke-opacity='.65' stroke-width='.6'/>`).join('');
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 100' preserveAspectRatio='xMidYMid slice'>${wd}${bb}</svg>`;
      return `url(${svgUri(svg)}) center / 100% 100% no-repeat, linear-gradient(180deg, ${dk(mixHex(c1, c2, .5), .45)} 0%, ${dk(c2, .88)} 100%)`;
    }
    case 'bars': case 'linechart': {
      const dk = (h, k) => mixHex(h, '#000000', k), a = c1, b = mixHex(c1, '#ffffff', .5), by = 80;
      let body = '';
      if (style === 'bars') body = barsFor(lv).map((q, i) => { const w = q.w * 2 * .9, h = q.h / 1.95 * (small ? 1.1 : 1); return `<rect x='${(q.x * 2 - w / 2).toFixed(1)}' y='${(by - h).toFixed(1)}' width='${w.toFixed(1)}' height='${h.toFixed(1)}' rx='1' fill='${i % 3 ? a : b}'/>`; }).join('') + `<rect x='0' y='${by}' width='200' height='1.2' fill='${a}'/>`;
      if (style === 'bars') body = `<g transform='translate(10 0) scale(.9 1)'>${body}</g>`;      // as barras ficam afastadas dos cantos redondos
      else { const P = linePts(lv).map(p => [p.x / 1.5, p.y / 1.5]); body = `<path d='M0 100 L${P.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L')} L200 100Z' fill='${a}' fill-opacity='.18'/><polyline points='${P.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}' fill='none' stroke='${a}' stroke-width='${small ? 2.6 : 2.2}' stroke-linejoin='round' stroke-linecap='round'/>` + P.map(p => `<circle cx='${p[0].toFixed(1)}' cy='${p[1].toFixed(1)}' r='${small ? 2.6 : 2}' fill='${b}'/>`).join(''); }
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 100' preserveAspectRatio='xMidYMid slice'>${body}</svg>`;
      return `url(${svgUri(svg)}) center / 100% 100% no-repeat, ${dk(c2, .9)}`;
    }
    case 'crust': {
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 150' preserveAspectRatio='none'><g fill='none' stroke='${c1}' stroke-linecap='round' stroke-linejoin='round'>${upTo(CRACKS, lv).map(c => c.p).join('')}</g></svg>`;
      return `url(${svgUri(svg)}) center / 100% 100% no-repeat, radial-gradient(circle at 50% 60%, ${mixHex(c2, '#000000', .8)}, ${mixHex(c2, '#000000', .93)})`;
    }
    // Estilos novos: imagens paradas (as mesmas das miniaturas), com tantos elementos quantos o nível de "Quantidade"
    case 'neon': {
      const dk = (h, k) => mixHex(h, '#000000', k), A = c1, B = pal.a2;
      if (card) return `linear-gradient(90deg, transparent, ${A} 40%, ${B} 62%, transparent) 18px calc(100% - 12px) / calc(100% - 36px) 2px no-repeat, ${dk(c2, .9)}`;      // cartão parado: só a linha fina do rodapé
      return `url(${svgUri(neonFloor(lv, false, A, B, dk(c2, .9)))}) center / 100% 100% no-repeat, ${dk(c2, .9)}`;       // capa e miniaturas: o mesmo sol e chão em grelha, parados
    }
    case 'clouds': {      // nuvens desenhadas nítidas (círculos e base arredondada, uma só transparência para o conjunto)
      const dk = (h, k) => mixHex(h, '#000000', k);
      const cl = upTo(CLOUDS, lv).map((c, i) => { const w = c.w / 1.95 * (small ? 1.25 : 1), h = c.h / 1.95 * (small ? 1.25 : 1), x = c.cx * 2 - w / 2, y = ((card ? (i % 2 ? 108 : -6) : c.top) + c.h / 2) / 1.5 - h / 2;
        return `<g fill='#ffffff' opacity='${card ? .13 : .3}'><rect x='${x.toFixed(1)}' y='${y.toFixed(1)}' width='${w.toFixed(1)}' height='${h.toFixed(1)}' rx='${(h / 2).toFixed(1)}'/><circle cx='${(x + w * .36).toFixed(1)}' cy='${(y + h * .1).toFixed(1)}' r='${(h * .62).toFixed(1)}'/><circle cx='${(x + w * .62).toFixed(1)}' cy='${(y + h * .2).toFixed(1)}' r='${(h * .5).toFixed(1)}'/></g>`; }).join('');
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 100' preserveAspectRatio='xMidYMid slice'>${cl}</svg>`;
      return `url(${svgUri(svg)}) center / 100% 100% no-repeat, linear-gradient(180deg, ${dk(c2, .55)} 0%, ${dk(mixHex(c1, c2, .5), .25)} 100%)`;
    }
    case 'rain': {
      const dk = (h, k) => mixHex(h, '#000000', k), gap = [38, 29, 22, 17, 13][lv - 1];
      return `repeating-linear-gradient(78deg, transparent 0 ${gap}px, rgba(255,255,255,.38) ${gap}px ${gap + 1}px), repeating-linear-gradient(74deg, transparent 0 ${gap * 1.7}px, rgba(${hexRgb(c1).join(',')},.5) ${gap * 1.7}px ${gap * 1.7 + 1.5}px), linear-gradient(180deg, ${dk(c2, .88)} 0%, ${dk(c2, .62)} 100%)`;
    }
    case 'marble': {
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 150' preserveAspectRatio='none'><g fill='none' stroke='${c1}' stroke-linecap='round'>${upTo(MARBLE, lv).map(v => `<path stroke-width='${v.w}' d='${v.d}'/>`).join('')}</g></svg>`;
      return `url(${svgUri(svg)}) center / 100% 100% no-repeat, ${mixHex(c2, '#000000', .8)}`;
    }
    case 'paper': {
      const dk = (h, k) => mixHex(h, '#000000', k), b = mixHex(c1, c2, .5);
      const sh = upTo(SHEENS, lv).map(s => `linear-gradient(105deg, transparent ${s.x - 4}%, rgba(255,255,255,.16) ${s.x}%, transparent ${s.x + 7}%)`);
      return `${sh.join(', ')}${sh.length ? ', ' : ''}linear-gradient(40deg, transparent 0 38%, rgba(0,0,0,.18) 38% 39%, transparent 39% 64%, rgba(255,255,255,.1) 64% 65%, transparent 65%), linear-gradient(115deg, ${dk(b, .5)} 0 28%, ${dk(b, .38)} 28% 50%, ${dk(b, .62)} 50% 71%, ${dk(b, .5)} 71%)`;
    }
    default: return lin;
  }
}
function coverState(t) {                         // a capa do perfil pode ter o fundo animado (o resto da app fica estático)
  t = validStyle({ ...DEFAULT_THEME, ...t });
  const fluid = ALWAYS_ANIM.includes(t.style), pal = palOf(t.palette);
  // Estilos que só existem animados (Magma, Ondas…): com as animações desligadas (ou "reduzir animações" do sistema) ficam só em IMAGEM (a mesma da miniatura).
  const anim = fluid ? fluidMotion(t) : (!!t.anim && t.style !== 'solid');
  // animada: fundo fixo (gradiente liso) + uma camada .cv por cima, que o CSS mexe só com transform. Magma/Ondas…: o fundo vem do CSS e a camada tem vários elementos.
  return { cls: anim ? 'cover anim' : 'cover', gs: t.style, bg: anim && !fluid ? `linear-gradient(135deg, ${pal.g[0]} 0%, ${pal.g[1]} 100%)` : '',
    layer: anim && !fluid ? coverLayer(t.style, pal) : '', inner: anim && fluid ? fluidInner(t.style, fxLevel(t)) : '' };
}
const coverHTML = s => `<div class="${s.cls}" data-gs="${s.gs}"${s.bg ? ` style="background:${s.bg}"` : ''}>${s.inner ? `<div class="cv cv-${s.gs}">${s.inner}</div>` : s.layer ? `<div class="cv" style="background:${s.layer}"></div>` : ''}</div>`;
function refreshCover(t) {
  const c = document.querySelector('.cover'); if (!c) return;
  const s = coverState(t); c.className = s.cls; c.dataset.gs = s.gs; c.style.background = s.bg;
  c.querySelector('.cv')?.remove();
  if (s.inner) { const cv = document.createElement('div'); cv.className = `cv cv-${s.gs}`; cv.innerHTML = s.inner; c.prepend(cv); }
  else if (s.layer) { const cv = document.createElement('div'); cv.className = 'cv'; cv.style.background = s.layer; c.prepend(cv); }
}
let appliedTheme = DEFAULT_THEME;
function applyTheme(t, opts = {}) {
  t = validStyle({ ...DEFAULT_THEME, ...t }); appliedTheme = t;
  const pal = palOf(t.palette), r = document.documentElement;
  const light = t.mode === 'light' || t.mode === 'autolight';
  const flips = applyTheme.light !== undefined && applyTheme.light !== light;
  applyTheme.light = light;
  const run = () => {
    r.dataset.mode = light ? 'light' : 'dark';
    // Auto escuro / Auto claro: o fundo, as caixas e as linhas ganham um toque leve da cor escolhida (nos outros modos ficam neutros)
    const tint = t.mode === 'autodark' || t.mode === 'autolight', col = !light && pal.tintDark ? pal.tintDark : pal.s;
    const tv = light ? { '--bg': mixHex('#f5f5f6', col, .09), '--surface': mixHex('#ffffff', col, .04), '--surface-2': mixHex('#eeeff1', col, .11), '--line': mixHex('#e2e3e7', col, .14) }
      : { '--bg': mixHex('#0b0b0c', col, .07), '--surface': mixHex('#131314', col, .09), '--surface-2': mixHex('#1c1c1e', col, .105), '--line': mixHex('#27272a', col, .12) };
    for (const [k, v] of Object.entries(tv)) { if (tint) r.style.setProperty(k, v); else r.style.removeProperty(k); }
    const acc = light ? pal.light : pal.dark;
    r.style.setProperty('--accent', acc);
    r.style.setProperty('--on-accent', lumHex(acc) > 0.42 ? '#04130d' : '#ffffff');       // visto/texto por cima da cor de destaque
    r.style.setProperty('--accent-2', pal.a2);
    // --grad: só a cor (gradiente simples, ou a cor sólida) e é o que a app toda usa. --grad-style: o estilo escolhido (píxeis, pontos…), só na capa do perfil
    // O calendário usa sempre a cor (--grad-cal, hoje igual a --grad); os seus próprios estilos virão depois.
    r.style.setProperty('--grad', t.style === 'solid' ? pal.s : `linear-gradient(135deg, ${pal.g[0]} 0%, ${pal.g[1]} 100%)`);
    r.style.setProperty('--c1', pal.g[0]); r.style.setProperty('--c2', pal.g[1]);          // as duas cores do gradiente (cartões de total: sempre gradiente)
    r.classList.toggle('anim', !!t.anim);
    r.style.setProperty('--grad-style', themeBg(t.style, pal));
    r.style.setProperty('--grad-card', themeBg(t.style, pal, false, true));        // a mesma imagem, com a variante pensada para o cartão (efeito afastado do texto)
    const baseL = t.style === 'solid' ? lumHex(pal.s) : lumHex(mixHex(pal.g[0], pal.g[1]));
    r.style.setProperty('--on-grad-g', lumHex(mixHex(pal.g[0], pal.g[1])) > 0.42 ? '#04130d' : '#ffffff');   // texto nos cartões de total (sempre gradiente)
    r.style.setProperty('--on-grad', baseL > 0.42 ? '#04130d' : '#ffffff');       // texto por cima do destaque: escuro em fundos claros, branco nos escuros
    r.classList.toggle('px', t.style === 'pixel');
    // Magma / Ondas do oceano: cores da paleta para o CSS, fundo próprio nos cartões de total e texto sempre claro (o fundo dos cartões é escuro nestes estilos)
    r.dataset.ts = t.style;
    for (const [k, v] of Object.entries(fluidVars(pal))) r.style.setProperty(k, v);
    // Cartões de total: por defeito só a cor (gradiente). Com "Cartões seguem o estilo" ligado usam o estilo escolhido:
    // os de magma/ondas ganham o fundo escuro com o movimento, e os outros o padrão (píxeis, pontos…) em imagem.
    const fl = FLUID_CODE[t.style], cs = !!t.cardStyle;     // fl: os estilos que escurecem o cartão (Barras e Linha incluídas: o cartão leva o mesmo fundo escuro da capa)
    // Regra dos cartões: por defeito, gradiente (parado, ou a rodar se as animações estiverem ligadas). Seguindo o estilo: animado se as animações
    // estiverem ligadas; senão, a imagem parada do estilo (um pouco escurecida nos de magma/ondas para o texto branco se ler em qualquer paleta).
    // Cartões de total (gradiente por defeito): um ponto claro numa ponta e um tom mais fundo na outra, para o relevo se notar tanto no tema claro como no escuro.
    const hi = mixHex(mixHex(pal.g[0], pal.g[1], .18), '#ffffff', .1), lo = mixHex(mixHex(pal.g[0], pal.g[1], .82), '#000000', .12);
    r.style.setProperty('--bt-grad', `linear-gradient(135deg, ${hi} 0%, ${pal.g[0]} 34%, ${pal.g[1]} 68%, ${lo} 100%)`);
    r.style.setProperty('--bt-bg', !cs ? 'var(--bt-grad)'
      : fl ? (FOOT_KINDS.includes(t.style) ? 'var(--bs-card)' : fluidMotion(t) ? `var(--${fl}-card)` : 'linear-gradient(100deg, rgba(0, 0, 0, .34) 0%, rgba(0, 0, 0, .12) 50%, rgba(0, 0, 0, 0) 85%), radial-gradient(ellipse at 80% -10%, rgba(255, 255, 255, .18), rgba(255, 255, 255, 0) 58%), var(--grad-card)')
      : classicCardMotion(t) ? 'linear-gradient(135deg, var(--c1) 0%, var(--c2) 100%)' : t.style === 'pixel' ? 'linear-gradient(100deg, color-mix(in srgb, var(--c1) 50%, var(--c2)) 0%, color-mix(in srgb, var(--c1) 50%, var(--c2)) 36%, transparent 80%), var(--grad-style)' : t.style === 'conic' ? 'var(--grad-card)' : 'var(--grad-style)');       // Píxeis, Aurora, Quadrículas, Cónico: base lisa + camada que se mexe
    if (cs && fl) r.style.setProperty('--on-grad-g', '#ffffff');                       // fundo escuro: texto claro
    else if (cs && t.style === 'solid') r.style.setProperty('--on-grad-g', baseL > 0.42 ? '#04130d' : '#ffffff');
    if (cs) r.dataset.cardstyle = '1'; else delete r.dataset.cardstyle;
    if (cs && fl) r.dataset.fluid = '1'; else delete r.dataset.fluid;
    refreshCover(t);
    decorateTotals();
    r.dataset.cal = CAL_STYLES.some(c => c[0] === t.cal) ? t.cal : 'soft';
    if (t.day && t.day !== 'default' && DAY_STYLES.some(d => d[0] === t.day) && r.dataset.cal !== 'min') r.dataset.day = t.day; else delete r.dataset.day;     // o Minimalista não leva estes marcadores
    try { localStorage.setItem('konto.theme', JSON.stringify(t)); } catch {}                // para o arranque já nascer com o último tema
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', getComputedStyle(r).getPropertyValue('--bg').trim() || '#0b0b0c');
  };
  // Claro ↔ escuro: a troca é imediata, mas fica tapada por uma película da cor antiga que desvanece (uma só animação de opacidade, quase de graça
  // para o telemóvel). Experimentei esbater as cores de todos os elementos e depois um círculo a abrir: ambos obrigam a redesenhar a página a cada
  // fotograma e ficavam a ~2 fps num telemóvel modesto. Com "reduzir animações", a troca é imediata.
  if (opts.animate && flips && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.querySelectorAll('.theme-fade').forEach(o => o.remove());
    const ov = document.createElement('div'); ov.className = 'theme-fade';
    ov.style.background = getComputedStyle(r).getPropertyValue('--bg').trim() || '#0b0b0c';           // a cor de fundo ANTIGA
    document.body.appendChild(ov);
    r.classList.add('no-tr');                                                                         // sem as pequenas transições de cor de cada elemento durante a troca
    run(); void ov.offsetWidth;                                                                       // o ecrã novo fica por baixo, já com o tema novo
    ov.classList.add('go'); setTimeout(() => ov.remove(), 600);
    const free = () => r.classList.remove('no-tr');
    requestAnimationFrame(() => requestAnimationFrame(free)); setTimeout(free, 350);                  // (a segunda é salvaguarda)
    return;
  }
  run();
}

/* Módulos que o utilizador pode escolher gerir. */
const MODULES = [
  { id: 'subs',  icon: 'subs',  name: 'Subscrições',        short: 'Subscrições', desc: 'Streaming, apps, serviços recorrentes', ready: true },
  { id: 'spend', icon: 'spend', name: 'Gastos do dia a dia', short: 'Dia-a-dia',   desc: 'Para gastos diários', ready: true },
  { id: 'fuel',  icon: 'car',   name: 'Automóvel', short: 'Automóvel', desc: 'Combustível, outras despesas, lembretes e custo por km', ready: true },
  { id: 'vices', icon: 'vices', name: 'Vícios', short: 'Vícios', desc: 'Sem julgamentos: Todos temos algum…', ready: true },
  { id: 'house', icon: 'home',  name: 'Casa', short: 'Casa',    desc: 'Renda, luz, água, internet… com faturas reais', ready: true },
];

/* Categorias dos lançamentos (também usadas nas cores do calendário). */
const CATS = [
  { id: 'subs',      icon: 'subs',      name: 'Subscrições', color: '#6366f1' },
  { id: 'fuel',      icon: 'fuel',      name: 'Combustível', color: '#f59e0b' },
  { id: 'vices',     icon: 'vices',     name: 'Vícios',      color: '#ef4444' },
  { id: 'home',      icon: 'home',      name: 'Casa',        color: '#0ea5e9' },
  { id: 'food',      icon: 'food',      name: 'Comida',      color: '#10b981' },
  { id: 'transport', icon: 'transport', name: 'Transportes', color: '#8b5cf6' },
  { id: 'casino',    icon: 'dice',      name: 'Casino',      color: '#06b6d4' },   // só no resumo: o casino aparece sempre numa linha própria
  { id: 'shop',      icon: 'car',       name: 'Automóvel', color: '#f97316' },
  { id: 'other',     icon: 'other',     name: 'Outros',      color: '#8b93a3' },
];
const catOf = id => CATS.find(c => c.id === id) || CATS[CATS.length - 1];
/* Categorias que vão ter separador próprio: já não se oferecem nos Gastos do dia a dia,
   mas os registos antigos com estas categorias continuam a aparecer e a poder editar-se. */
const OWN_TAB = ['vices', 'home', 'casino', 'shop'];

/* Ícones SVG (iguais em todos os dispositivos, ao contrário dos emojis). */
const ICONS = {
  subs: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  spend: '<path d="M4 7a2 2 0 0 1 2-2h11v4"/><path d="M4 7v10a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1V10a1 1 0 0 0-1-1H6a2 2 0 0 1-2-2z"/><circle cx="16" cy="14" r="1.2"/>',
  fuel: '<path d="M5 20V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15"/><path d="M3 20h14M8 8h4"/><path d="M15 10h2a2 2 0 0 1 2 2v4a1.5 1.5 0 0 0 3 0V8l-3-3"/>',
  play: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9.5v5l4-2.5z"/>',
  tv: '<rect x="2" y="7" width="20" height="13" rx="3"/><path d="M17 2l-5 5-5-5"/>',
  music: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  chat: '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
  sparkle: '<path d="M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8z"/><path d="M19 16v5M16.5 18.5h5"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.5-8A5.5 5.5 0 0 1 17 8.5 4.5 4.5 0 0 1 17 18z"/>',
  brush: '<path d="M18 3l3 3-9 9-3-3z"/><path d="M9 12c-3 0-4 2-4 4s-1 3-2 4c3 0 7 0 7-4 0-1.5-.5-3-1-4"/>',
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M3 4h2.5l2.2 11h10.6l2-8H6.5"/>',
  book: '<path d="M5 4a2 2 0 0 1 2-2h12v17H7a2 2 0 0 0-2 2z"/><path d="M5 21V4M10 7h6"/>',
  dumbbell: '<path d="M6 7v10M18 7v10M3 10v4M21 10v4M6 12h12"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="3"/><path d="M11 18h2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.01"/>',
  cig: '<path d="M3 16h13v4H3z"/><path d="M19 16v4M22 16v4"/><path d="M17 12c0-2 2-2 2-4s-2-2-2-4"/>',
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  food: '<path d="M7 3v8M4 3v5a3 3 0 0 0 6 0V3M7 11v10"/><path d="M17 3c-2 1.5-3 4-3 7h3v11"/>',
  transport: '<rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M8 21v-3M16 21v-3"/><circle cx="8" cy="14.5" r=".6"/><circle cx="16" cy="14.5" r=".6"/>',
  other: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  drop: '<path d="M12 3c-3 4-6 7-6 10.5a6 6 0 0 0 12 0C18 10 15 7 12 3z"/>',
  flame: '<path d="M12 3c1 3.5 4 5 4 9a4 4 0 0 1-8 0c0-1.7.6-2.8 1.6-3.8.2 1.3.9 2.1 1.6 2.1 0-3.2.4-4.6.8-7.3z"/>',
  wifi: '<path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r=".8"/>',
  building: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/>',
  shield: '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z"/>',
  coffee: '<path d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3v2M12 3v2"/>',
  glass: '<path d="M6 4h9l-1 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z"/><path d="M15 7h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="9" cy="15" r="1"/><circle cx="15" cy="15" r="1"/>',
  minus: '<path d="M5 12h14"/>',
  gamepad: '<path d="M7 8h10a4 4 0 0 1 4 4v1a3 3 0 0 1-5.2 2L14 13h-4l-1.8 2A3 3 0 0 1 3 13v-1a4 4 0 0 1 4-4z"/><path d="M8 10.5v3M6.5 12h3"/><circle cx="16" cy="11.5" r=".7"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  hourglass: '<path d="M6 3h12M6 21h12"/><path d="M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="3"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="3"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  offline: '<path d="M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r=".8"/><path d="M3 3l18 18"/>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18c1.5 0 2-1 1.5-2s0-2 1.5-2h2a4 4 0 0 0 4-4c0-5-4-10-9-10z"/><circle cx="8" cy="10" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="16" cy="10" r="1"/>',
  swap: '<path d="M7 7h13l-3-3M17 17H4l3 3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  backspace: '<path d="M21 5H9l-6 7 6 7h12z"/><path d="M13 9l4 6M17 9l-4 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  logout: '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"/><path d="M16 8l4 4-4 4M20 12H9"/>',
  euroCoin: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.8a4 4 0 1 0 0 6.4M8 11h5.5M8 13.2h5.5"/>',
  wrench: '<path d="M7 10h3V7L6.5 3.5a6 6 0 0 1 8 8l6 6a2 2 0 0 1-3 3l-6-6a6 6 0 0 1-8-8L7 10z"/>',
  car: '<path d="M5 16l1.5-5.5A2 2 0 0 1 8.4 9h7.2a2 2 0 0 1 1.9 1.5L19 16"/><rect x="3" y="16" width="18" height="4" rx="1.5"/><circle cx="7.5" cy="18" r=".8"/><circle cx="16.5" cy="18" r=".8"/>',
  moto: '<circle cx="6" cy="16" r="3"/><circle cx="18" cy="16" r="3"/><path d="M6 16l4-6h5l3 6M10 10L9 7H7"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5"/><path d="M5 20h14"/>',
  upload: '<path d="M12 16V5M7 9l5-5 5 5"/><path d="M5 20h14"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  down: '<path d="M5 9.5l7 7 7-7"/>',
  left: '<path d="M14.5 5l-7 7 7 7"/>',
  right: '<path d="M9.5 5l7 7-7 7"/>',
};
/* O ícone dos vícios (separador, resumo, módulos) é escolhido por perfil em Definições. */
const VICE_ICONS = [['cig', 'Cigarro'], ['coffee', 'Café'], ['glass', 'Bebida'], ['dice', 'Casino'], ['gamepad', 'Jogos'], ['flame', 'Chama']];
const viceIcon = () => {
  const id = (typeof current === 'function' && typeof db !== 'undefined' && current())?.viceIcon;
  return VICE_ICONS.some(v => v[0] === id) ? id : 'flame';
};
const ico = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name === 'vices' ? viceIcon() : name] || ''}</svg>`;

/* Ícones das subscrições: logótipo de uma marca conhecida, ícone genérico ou a letra inicial.
   s.icon: '' = automático (sugerido pelo nome) · 'letter' = só a letra · 'brand:id' · id de ícone genérico. */
const SUB_ICONS = [['play', 'Vídeo'], ['tv', 'TV'], ['music', 'Música'], ['gamepad', 'Jogos'], ['chat', 'Chat'], ['sparkle', 'IA'], ['cloud', 'Nuvem'],
  ['brush', 'Arte'], ['cart', 'Compras'], ['book', 'Leitura'], ['dumbbell', 'Ginásio'], ['shield', 'Segurança'], ['phone', 'Telemóvel'], ['wifi', 'Internet']];
const SUB_ICON_KEYS = {
  play: ['video', 'filme', 'serie', 'stream', 'play'], tv: ['tv', 'canal', 'sport'], music: ['music', 'musica', 'radio', 'podcast'],
  gamepad: ['game', 'jogo', 'gaming', 'bundle', 'pass'], chat: ['chat', 'messenger', 'mensagem'], sparkle: ['ai', 'ia', 'gpt', 'bot'],
  cloud: ['cloud', 'drive', 'storage', 'backup', 'nuvem'], brush: ['paint', 'draw', 'design', 'foto', 'photo', 'arte'],
  book: ['book', 'livro', 'jornal', 'revista', 'news', 'leitura'], dumbbell: ['gym', 'ginasio', 'fitness', 'sport'],
  shield: ['vpn', 'antivirus', 'password', 'seguranca'], phone: ['telemovel', 'mobile', 'tarifario'], wifi: ['internet', 'fibra', 'wifi'], cart: ['shop', 'loja', 'club'],
};
const normName = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const brandOf = id => (typeof BRANDS !== 'undefined' ? BRANDS : []).find(b => b.id === id);
function autoIcon(name) {                       // sugere a partir do nome: marca primeiro (a palavra-chave mais comprida ganha), depois tipo de serviço
  const n = normName(name), flat = n.replace(/[^a-z0-9+]/g, ''), words = n.split(/[^a-z0-9]+/).filter(Boolean);
  if (!flat) return '';
  const has = k => k.length <= 3 ? words.includes(k) : flat.includes(k);
  let best = null, len = 0;
  for (const b of (typeof BRANDS !== 'undefined' ? BRANDS : [])) for (const k of b.k) if (k.length > len && has(k)) { best = b; len = k.length; }
  if (best) return 'brand:' + best.id;
  for (const [id, keys] of Object.entries(SUB_ICON_KEYS)) if (keys.some(has)) return id;
  return '';
}
const subIconOf = s => (s.icon && s.icon !== 'auto') ? s.icon : autoIcon(s.name);
function subIc(s, name = s?.name || '', iconId) {          // o quadrado do ícone da subscrição
  const id = iconId !== undefined ? iconId : subIconOf(s), letter = esc(String(name).trim()[0]?.toUpperCase() || '?');
  const b = id.startsWith('brand:') ? brandOf(id.slice(6)) : null;
  if (b) return `<div class="ic" style="background:${b.bg};color:${b.fg}"><svg class="brand-logo" viewBox="0 0 24 24" aria-hidden="true"><path d="${b.p}"/></svg></div>`;
  if (ICONS[id] && id !== 'letter') return `<div class="ic" style="background:${colorOf(name)}">${ico(id)}</div>`;
  return `<div class="ic" style="background:${colorOf(name)}">${letter}</div>`;
}

/* Estado de interface (não persistido) */
const ui = {
  screen: 'welcome',  // welcome | ask | picker | form | profile
  tab: 'home',        // home | subs | spend | manage
  profileId: null,
  draft: null,
  firstRun: false,
  period: 'month',    // day | week | month | year (resumo do Início)
  cal: { y: new Date().getFullYear(), m: new Date().getMonth(), sel: new Date().getDate(), open: null, openM: {}, limit: 20 },
  vperiod: 'month',   // período da visão geral do separador Vícios
  spendDays: 10,      // quantos dias mostrar no separador Gastos
  fuelLimit: 10,      // quantos abastecimentos mostrar no separador Combustível
};

/* ───────────── 2. UTILITÁRIOS ───────────── */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const eur = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' });
const cost = n => eur.format(n ? -Math.abs(n) : 0);   // gastos a negativo: -15,00 €
const dim = (y, m) => new Date(y, m + 1, 0).getDate();
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today0 = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; };
const MESES = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const DOW = ['S','T','Q','Q','S','S','D'];
const COLORS = ['#6366f1','#10b981','#f59e0b','#ec4899','#06b6d4','#8b5cf6','#ef4444','#14b8a6'];
const colorOf = str => COLORS[[...str].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const current = () => db.profiles.find(p => p.id === ui.profileId);

/* @utilizador: identifica cada perfil e distingue os que têm o mesmo nome. Único, em minúsculas, sem espaços nem acentos. */
const cleanHandle = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/^@+/, '').replace(/[^a-z0-9._]/g, '').slice(0, 20);
const handleTaken = (h, selfId) => db.profiles.some(p => p.id !== selfId && p.handle === h);
function uniqueHandle(base, selfId) {                        // "filipe" → "filipe", e "filipe2", "filipe3"… se já existir
  const h = cleanHandle(base) || 'perfil';
  let out = h, n = 2;
  while (handleTaken(out, selfId)) out = `${h.slice(0, 20 - String(n).length)}${n++}`;
  return out;
}
function ensureHandles(d) {                                  // perfis antigos ainda não têm @: dá-lhes um, a partir do nome
  let changed = false;
  for (const p of d.profiles) if (!p.handle) { p.handle = uniqueHandle(p.name, p.id); changed = true; }
  return changed;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}

/* SHA-256 em JavaScript puro: dá o mesmo resultado em qualquer sítio (browser em HTTP, app, PC).
 * Antes usava crypto.subtle, que não existe em páginas sem HTTPS, e as senhas deixavam de coincidir. */
const SHA_K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
];
function sha256hex(str) {
  const bytes = new TextEncoder().encode(str), len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes); padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, (len * 8) >>> 0);
  let h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15], b = w[t - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + SHA_K[t] + w[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h = [h[0] + a, h[1] + b, h[2] + c, h[3] + d, h[4] + e, h[5] + f, h[6] + g, h[7] + hh].map(x => x | 0);
  }
  return h.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
async function hashPin(pin) { return sha256hex('konto:' + pin); }

/* Verifica a senha. Aceita também o formato antigo (btoa) e converte-o para o atual. */
async function checkPin(p, pin) {
  const h = await hashPin(pin);
  if (h === p.pin) return true;
  if (p.pin === btoa(pin + 'konto')) { p.pin = h; saveDB(); return true; }
  return false;
}

function readPhoto(file) {
  return new Promise(res => {
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
        const k = Math.max(S / img.width, S / img.height), w = img.width * k, h = img.height * k;
        c.getContext('2d').drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
        res(c.toDataURL('image/jpeg', 0.8));
      };
      img.src = r.result;
    };
    r.readAsDataURL(file);
  });
}

/* ───────────── 3. LANÇAMENTOS ───────────── */
/* Subscrições */
/* Frequência da cobrança: de quantos em quantos meses. Nas que não são mensais, s.month é o mês de uma das cobranças
 * (as outras seguem de "every" em "every" meses). Os valores antigos "month" e "year" continuam a significar o mesmo. */
const FREQ = {
  month:    { every: 1,  label: 'Todos os meses' },
  bimonth:  { every: 2,  label: 'De 2 em 2 meses' },
  quarter:  { every: 3,  label: 'Trimestral' },
  semester: { every: 6,  label: 'Semestral' },
  year:     { every: 12, label: 'Anual' },
};
const everyOf = s => FREQ[s.period]?.every || 1;
const isChargeMonth = (s, m) => { const ev = everyOf(s); return ev === 1 || (((m - (s.month - 1)) % ev) + ev) % ev === 0; };
function freqText(s) {                                       // "de 2 em 2 meses (jan, mar, …), dia 5"
  const ev = everyOf(s);
  if (ev === 1) return `todos os meses, dia ${s.day}`;
  if (ev === 12) return `todos os anos, ${s.day} de ${MESES[s.month - 1]}`;
  const ms = [...Array(12 / ev)].map((_, i) => (s.month - 1 + i * ev) % 12).sort((a, b) => a - b).map(i => MESES[i].slice(0, 3));
  return `${FREQ[s.period].label.toLowerCase()} (${ms.join(', ')}), dia ${s.day}`;
}
/* Histórico de valores: quando o valor de uma subscrição ou conta muda, os meses anteriores mantêm o valor antigo.
 * s.prices = [{from:'AAAA-MM', amount}] (por ordem); s.amount é sempre o último valor registado. Sem s.prices, vale s.amount para sempre. */
const ymOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
function priceAt(s, ym) {                                    // valor que vale no mês "ym"
  const list = s.prices;
  if (!list?.length) return s.amount;
  let v = list[0].amount; for (const x of list) if (x.from <= ym) v = x.amount;
  return v;
}
const curAmount = s => priceAt(s, ymOf(new Date()));         // valor que vale hoje
function applyPriceChange(item, newAmount, fromYm) {         // fromYm = null corrige o valor desde sempre
  if (fromYm === null) delete item.prices;
  else {
    const base = item.prices?.length ? item.prices : [{ from: ymOf(new Date(item.created)), amount: item.amount }];
    item.prices = [...base.filter(x => x.from < fromYm), { from: fromYm, amount: newAmount }];
  }
  item.amount = newAmount;
}
function pricesText(s) {                                     // "500 € desde jan 2026 · 520 € desde nov 2026"
  if (!s.prices || s.prices.length < 2) return '';
  return s.prices.map(x => { const [y, m] = x.from.split('-'); return `${nf(x.amount)} € desde ${MESES[+m - 1].slice(0, 3)} ${y}`; }).join(' · ');
}

/* Casa: contas que se repetem (renda, luz, água…). Fixas, ou variáveis com a fatura real registada de cada vez. */
const BILL_TYPES = [
  { id: 'rent',      name: 'Renda',         icon: 'home',     color: '#0ea5e9', variable: false },
  { id: 'light',     name: 'Luz',           icon: 'bolt',     color: '#f59e0b', variable: true },
  { id: 'water',     name: 'Água',          icon: 'drop',     color: '#06b6d4', variable: true },
  { id: 'gas',       name: 'Gás',           icon: 'flame',    color: '#ef4444', variable: true },
  { id: 'net',       name: 'Internet e TV', icon: 'wifi',     color: '#8b5cf6', variable: false },
  { id: 'condo',     name: 'Condomínio',    icon: 'building', color: '#14b8a6', variable: false },
  { id: 'insurance', name: 'Seguro',        icon: 'shield',   color: '#10b981', variable: false },
  { id: 'other',     name: 'Outros',        icon: 'other',    color: '#8b93a3', variable: false },
];
const billTypeOf = id => BILL_TYPES.find(t => t.id === id) || BILL_TYPES[BILL_TYPES.length - 1];
function billReals(p, b) {                                   // faturas reais registadas, da mais antiga para a mais recente
  const pre = b.id + ':', out = [];
  for (const k in p.billLog) if (k.startsWith(pre)) out.push({ ym: k.slice(pre.length), v: p.billLog[k] });
  return out.sort((a, c) => a.ym.localeCompare(c.ym));
}
function billInfo(p, b) {
  const reals = billReals(p, b), last3 = reals.slice(-6);
  const last = reals[reals.length - 1], prev = reals[reals.length - 2];
  // Renda, condomínio, seguro e internet costumam ficar iguais e mudar de uma vez: o melhor palpite é o último valor.
  // Luz, água e gás oscilam todos os meses: a média das últimas faturas.
  const stable = ['rent', 'condo', 'insurance', 'net'].includes(b.type);
  const typical = b.variable && last3.length ? (stable ? last.v : last3.reduce((a, r) => a + r.v, 0) / last3.length) : curAmount(b);   // sem faturas, conta a estimativa
  return { reals, typical, monthly: typical / everyOf(b), last, diff: last && prev ? last.v - prev.v : null };
}
function pendingInvoices(p, items = p.bills) {               // faturas variáveis já vencidas e ainda sem valor real (contas de casa, ou pagamentos fixos do automóvel)
  const t = today0(), out = [];
  for (const b of items) if (b.variable) {
    for (let k = 0; k < 14; k++) {
      const dt = new Date(t.getFullYear(), t.getMonth() - k, 1), y = dt.getFullYear(), m = dt.getMonth();
      if (y * 12 + m < startIndex(b) || !isChargeMonth(b, m)) continue;
      const due = new Date(y, m, Math.min(b.day, dim(y, m))), ym = `${y}-${pad(m + 1)}`;
      if (due <= t && p.billLog[`${b.id}:${ym}`] === undefined) out.push({ b, ym, due });
    }
  }
  return out.sort((a, c) => c.due - a.due);
}

/* Uma subscrição só conta a partir do mês em que foi criada (inclusive). */
const startIndex = s => { const d = new Date(s.created); return d.getFullYear() * 12 + d.getMonth(); };

function chargesOn(p, y, m) {            // cobranças de subscrições num mês: [{sub, day}]
  const out = [];
  for (const s of p.subs) {
    if (y * 12 + m < startIndex(s)) continue;
    if (isChargeMonth(s, m)) out.push({ sub: s, day: Math.min(s.day, dim(y, m)) });
  }
  return out.sort((a, b) => a.day - b.day);
}
const afterToday = () => { const t = today0(); return new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1); };      // "próximo" começa amanhã: o que cobra hoje já conta como pago
function nextCharge(s, from) {                               // primeira cobrança em ou depois de "from"
  for (let i = 0; i <= 12; i++) {
    const dt = new Date(from.getFullYear(), from.getMonth() + i, 1), y = dt.getFullYear(), m = dt.getMonth();
    if (!isChargeMonth(s, m)) continue;
    const d = new Date(y, m, Math.min(s.day, dim(y, m)));
    if (d >= from) return d;
  }
}
function dueReminders(p) {
  const now = today0();
  return [...p.subs, ...p.bills, ...p.carFix].filter(s => s.remind).map(s => {      // subscrições e contas de casa têm os mesmos campos
    const next = nextCharge(s, now);
    return { sub: s, days: Math.round((next - now) / 864e5), amount: priceAt(s, ymOf(next)) };
  }).filter(r => r.days <= r.sub.remindDays).sort((a, b) => a.days - b.days);
}
const whenText = d => d === 0 ? 'hoje' : d === 1 ? 'amanhã' : `em ${d} dias`;
const subEntry = s => ({ kind: 'sub', id: s.id, name: s.name, amount: curAmount(s), cat: 'subs', sub: s });

/* Primeiro mês com registos: o calendário não recua para antes disto. */
function firstMonthIndex(p) {
  const n = new Date();
  let min = n.getFullYear() * 12 + n.getMonth();
  for (const s of [...p.subs, ...p.bills, ...p.carFix]) min = Math.min(min, startIndex(s));
  for (const s of p.spends) min = Math.min(min, +s.date.slice(0, 4) * 12 + (+s.date.slice(5, 7) - 1));
  for (const i of p.incomes) min = Math.min(min, startIndex(i));
  for (const g of p.earnings) min = Math.min(min, +g.date.slice(0, 4) * 12 + (+g.date.slice(5, 7) - 1));
  for (const k in p.hlog) { const d = k.slice(k.indexOf(':') + 1); min = Math.min(min, +d.slice(0, 4) * 12 + (+d.slice(5, 7) - 1)); }
  return min;
}

/* Todos os lançamentos de um mês (subscrições + gastos avulsos), por dia. */
function entriesOn(p, y, m) {
  const out = chargesOn(p, y, m).map(c => ({ ...subEntry(c.sub), amount: priceAt(c.sub, `${y}-${pad(m + 1)}`), day: c.day }));   // o valor que valia nesse mês
  const pre = `${y}-${pad(m + 1)}-`;                       // comparação de texto: bem mais rápida com muitos dados
  for (const s of p.spends) {
    if (s.date.startsWith(pre))
      out.push({ kind: 'spend', id: s.id, day: +s.date.slice(8), amount: s.amount, name: s.note || (s.cat === 'shop' ? shopTypeOf(s.type).name : catOf(s.cat).name), cat: s.cat, spend: s });      // despesa do automóvel sem nota: o tipo (Óleo e filtros, Pneus…)
  }
  for (const b of p.bills) {                                 // casa: o que conta é a fatura real; sem ela, a estimativa
    if (y * 12 + m < startIndex(b) || !isChargeMonth(b, m)) continue;
    const ym = `${y}-${pad(m + 1)}`, real = p.billLog[`${b.id}:${ym}`];
    out.push({ kind: 'bill', id: `${b.id}:${ym}`, day: Math.min(b.day, dim(y, m)), amount: real ?? priceAt(b, ym), estimated: b.variable && real === undefined, name: b.name, cat: 'home', bill: b });
  }
  for (const c of p.carFix) {                                // automóvel: pagamentos fixos (seguro, IUC…)
    if (y * 12 + m < startIndex(c) || !isChargeMonth(c, m)) continue;
    const ym = `${y}-${pad(m + 1)}`, real = p.billLog[`${c.id}:${ym}`];             // variável: o valor real do mês; sem ele, a estimativa
    out.push({ kind: 'carfix', id: `${c.id}:${ym}`, day: Math.min(c.day, dim(y, m)), amount: real ?? priceAt(c, ym), estimated: c.variable && real === undefined, name: c.name, cat: 'shop', carfix: c });
  }
  for (const h of p.habits) {                                // hábitos: só os que o utilizador quer ver no calendário e no resumo
    if (!h.show) continue;
    const hp = `${h.id}:${pre}`;
    for (const k in p.hlog) if (k.startsWith(hp)) {
      const r = p.hlog[k];
      // jogos e casino: o que conta é a diferença (gasto menos reembolsos / depósitos menos ganhos).
      // Se os ganhos passam os depósitos, o dia é um ganho (gain) e não um gasto.
      const net = h.kind === 'games' || h.tpl === 'casino' ? (r.spent || 0) - (r.won || 0) : null;
      const amount = net === null ? (r.spent || 0) : Math.max(0, net);
      const gain = h.tpl === 'casino' ? Math.max(0, -net) : 0;
      out.push({ kind: 'habit', id: k, day: +k.slice(-2), amount, gain, name: h.name, cat: 'vices', habit: h, rec: r });
    }
  }
  return out.sort((a, b) => a.day - b.day);
}

/* Casino: as contas fazem-se por período, não depósito a depósito. Os ganhos que passam os depósitos
 * são um ganho (à parte) e nunca abatem os gastos dos outros vícios; se ficam abaixo, o gasto é só a diferença. */
const isCasinoEntry = e => e.kind === 'habit' && e.habit.tpl === 'casino';
function casinoNet(p, fromStr, toStr) {
  let loss = 0, gain = 0;
  for (const h of p.habits) if (h.tpl === 'casino' && h.show) {
    let net = 0;
    for (const r of habitRecs(p, h)) if (r.date >= fromStr && r.date <= toStr) net += r.won - r.spent;
    if (net < 0) loss -= net; else gain += net;
  }
  return { loss, gain };
}
/* Gasto de uma lista de lançamentos no período [fromStr, toStr]: tudo, menos o casino, que se calcula pelo saldo do período. */
function spendOf(p, list, fromStr, toStr) {
  return list.reduce((a, e) => isCasinoEntry(e) ? a : a + e.amount, 0) + casinoNet(p, fromStr, toStr).loss;
}
const amtText = e => e.gain > 0 ? `+${nf(e.gain)} €` : cost(e.amount);
function entriesBetween(p, from, to) {   // intervalo inclusivo
  const out = []; let y = from.getFullYear(), m = from.getMonth();
  while (y * 12 + m <= to.getFullYear() * 12 + to.getMonth()) {
    for (const e of entriesOn(p, y, m)) {
      const d = new Date(y, m, e.day);
      if (d >= from && d <= to) out.push({ ...e, date: d });
    }
    if (++m > 11) { m = 0; y++; }
  }
  return out;
}
function periodRange(kind) {             // de que dia até hoje
  const t = today0();
  if (kind === 'day') return [t, t];
  if (kind === 'week') return [new Date(t.getFullYear(), t.getMonth(), t.getDate() - ((t.getDay() + 6) % 7)), t];
  if (kind === 'month') return [new Date(t.getFullYear(), t.getMonth(), 1), t];
  return [new Date(t.getFullYear(), 0, 1), t];
}
const PERIODS = [['day', 'Hoje', 'hoje'], ['week', 'Semana', 'esta semana'], ['month', 'Mês', 'este mês'], ['year', 'Ano', 'este ano']];

/* ───────────── 4. ECRÃS ───────────── */
function avatarHTML(p, size = 'md') {
  if (p.avatar) return `<div class="avatar ${size}"><img src="${p.avatar}" alt=""></div>`;
  return `<div class="avatar ${size}" style="background:${colorOf(p.name)}">${esc(p.name.trim()[0]?.toUpperCase() || '?')}</div>`;
}

function render() {
  const app = $('#app');
  const views = { welcome: vWelcome, ask: vAsk, picker: vPicker, form: vForm, profile: vProfile };
  const y = window.scrollY, view = ui.screen + ':' + ui.tab;
  const same = render.last === view;                         // mesmo ecrã e separador: mantém onde estavas
  if (!same) ui.page = {};                                   // ao sair das Definições (ou de qualquer ecrã), esquece a página: ao voltar, abre na página da cor e do estilo escolhidos
  let html, failed = false;
  try { html = views[ui.screen](); }
  catch (e) {                                                 // nunca deixar a app sem botões: mostra uma saída
    failed = true;
    console.error('Konto: erro a desenhar o ecrã', e);
    html = `<section class="screen center"><h1 class="title" style="font-size:26px">Algo correu mal</h1>
      <p class="lead">Os teus dados estão seguros. Volta ao menu de perfis e tenta outra vez.</p>
      <div class="stack"><button class="btn primary" data-act="to-picker">Voltar aos perfis</button>
      <button class="btn ghost" data-act="to-welcome">Ir para o início</button></div></section>`;
  }
  app.innerHTML = html;
  if (same) app.querySelector('.screen')?.classList.add('no-anim');   // o mesmo ecrã redesenhado não repete a animação de entrada (era isso que piscava)
  else {                                                      // ecrã novo: os cartões entram um a seguir ao outro (só nesta altura, para as atualizações parciais não "recomeçarem")
    const scr = app.querySelector('.screen');
    if (scr) {
      scr.classList.add('enter');
      scr.querySelectorAll('.card, .big-total, .reminder, .module, .set-profile').forEach((c, i) => c.style.setProperty('--i', Math.min(i, 8)));
      clearTimeout(render.enterTimer); render.enterTimer = setTimeout(() => scr.classList.remove('enter'), 1100);
    }
  }
  if (ui.screen === 'profile' && !failed) afterProfileRender();
  window.scrollTo(0, same ? y : 0);                           // outro ecrã ou separador: volta ao topo
  render.last = view;
  syncSegs(); syncNav(); syncAnims();                         // posições certas logo no primeiro fotograma
}
function go(screen, extra = {}) { Object.assign(ui, { screen }, extra); render(); }

/* iPhone: a app corre no Safari. Instalada no ecrã principal comporta-se como uma app e guarda melhor os dados; este aviso explica como. */
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
function iosHint() {
  if (!isIOS() || isStandalone() || window.Capacitor?.isNativePlatform?.()) return '';
  try { if (localStorage.getItem('konto.hint.ios')) return ''; } catch {}
  return `<div class="reminder ios-hint">${ico('download')} <span><b>Instala o Konto no iPhone.</b> No Safari, toca em <b>Partilhar</b> e depois em <b>Adicionar ao ecrã principal</b>. Assim a app abre sozinha e os teus dados ficam mais seguros. <button class="linkbtn accent" data-act="hide-ios-hint">Percebi</button></span></div>`;
}
function dataGuideSheet() {                         // guia curto dentro da app (o completo está em iphone/GUIA-DADOS.md)
  const ios = isIOS(), where = ios ? 'a app Ficheiros ou o iCloud Drive' : 'o Google Drive ou a pasta Transferências', first = ios ? 'o iCloud Drive' : 'o Google Drive';
  openSheet(`
    <h2>Guardar os dados em segurança</h2>
    <div class="guide">
      <p>Os teus dados só existem <b>neste telemóvel</b>. Não há servidor nem conta: se perderes o telemóvel ou apagares a app, só uma cópia te salva.</p>
      <h4>1. Faz uma cópia</h4>
      <p>Em <b>Definições → Dados → Exportar perfil</b>, escolhe onde guardar: ${where}.</p>
      <h4>2. Guarda em dois sítios</h4>
      <p>Por exemplo ${first} e o teu email ou o computador. Uma só cópia não chega.</p>
      <h4>3. Repete todos os meses</h4>
      <p>E depois de registares muita coisa. A app avisa quando passam 2 semanas sem cópia.</p>
      <h4>4. Mudar de telemóvel</h4>
      <p>Exporta no antigo, passa o ficheiro para o novo e usa <b>Importar perfil</b>.</p>
      <h4>5. Cuidados</h4>
      <ul>
        <li>O ficheiro <b>não é cifrado</b>: guarda-o num local privado.</li>
        <li>Experimenta importar uma vez, para saberes que funciona antes de precisares.</li>
        ${ios ? '<li>No iPhone, instala a app no ecrã principal <b>antes</b> de criares perfis: os dados do Safari e os da app instalada são separados. Se já tens perfis no Safari, exporta-os e importa-os na app instalada.</li><li>Evita "Limpar dados dos sites" no Safari, e lembra-te que remover a app apaga os dados.</li>' : ''}
      </ul>
    </div>
    <div class="stack"><button class="btn primary" data-act="close-btn">Percebi</button></div>`);
}

function vWelcome() {
  return `<section class="screen center welcome">
    <div class="logo"><svg viewBox="0 0 120 120" aria-label="Konto" role="img"><g transform="translate(-3 0)"><path d="M36 33V87M72 33L45 61L72 87"/><circle cx="88" cy="83" r="7" fill="currentColor" stroke="none"/></g></svg></div>
    <h1 class="title">Konto</h1>
    <p class="lead">As tuas contas, simples e só tuas. Sem complicações, sem internet, sem anúncios.</p>
    <div class="features">
      <div class="feature">${ico('lock')} <span><b>Privado</b> — os dados nunca saem do telemóvel</span></div>
      <div class="feature">${ico('offline')} <span><b>Offline</b> — funciona em qualquer lado</span></div>
      <div class="feature">${ico('palette')} <span><b>Teu</b> — escolhes o que queres gerir</span></div>
    </div>
    ${iosHint()}
    <div class="spacer"></div>
    <div class="stack">
      <button class="btn primary" data-act="start">Começar</button>
    </div>
  </section>`;
}

function vAsk() {
  return `<section class="screen center">
    <h1 class="title">Queres criar um perfil?</h1>
    <p class="lead">Os perfis permitem gerir os gastos de várias pessoas no mesmo telemóvel — cada um com a sua foto e, se quiser, uma senha. É opcional.</p>
    <div class="stack">
      <button class="btn primary" data-act="new-profile">Criar perfil</button>
      <button class="btn ghost" data-act="skip-profile">Agora não</button>
    </div>
  </section>`;
}

function vPicker() {
  const cards = db.profiles.map(p => `
    <button class="profile-card" data-act="open-profile" data-id="${p.id}">
      ${avatarHTML(p)}<span>${esc(p.name)}</span>
      ${p.handle ? `<span class="handle">@${esc(p.handle)}</span>` : ''}
      ${p.pin ? `<span class="lock">${ico('lock')} com senha</span>` : ''}
    </button>`).join('');
  return `<section class="screen">
    <button class="back" data-act="to-welcome">${ico('left')} Início</button>
    <h1 class="page-title">Quem és tu?</h1>
    <p class="muted">Escolhe o teu perfil para continuar.</p>
    ${iosHint()}
    <div class="profiles">${cards}
      <button class="profile-card add" data-act="new-profile"><div class="plus-circle">${ico('plus')}</div><span>Novo perfil</span></button>
    </div>
    <button class="btn ghost" data-act="import-backup">${ico('upload')} Importar perfil</button>
  </section>`;
}

function vForm() {
  const d = ui.draft;
  const canBack = db.profiles.length > 0;
  const preview = d.avatar ? `<div class="avatar md"><img src="${d.avatar}" alt=""></div>`
    : `<div class="avatar md add-photo">${ico('plus')}</div>`;
  return `<section class="screen">
    ${canBack ? `<button class="back" data-act="to-picker">${ico('left')} Voltar</button>` : ''}
    <h1 class="page-title">Novo perfil</h1>
    <p class="muted">Tudo aqui é opcional, exceto o nome.</p>
    <div class="form-head">
      <label class="photo-pick" data-act="pick-photo" aria-label="Escolher foto de perfil">
        <span id="photo-preview">${preview}</span>
        <input id="photo-input" type="file" accept="image/*" hidden>
      </label>
      <div class="field">
        <input class="input" id="f-name" maxlength="24" aria-label="Nome" placeholder="Nome (ex.: Filipe)" value="${esc(d.name)}"></div>
    </div>
    <div class="field"><label>@ utilizador</label>
      <div class="at-field"><span>@</span><input class="input" id="f-handle" maxlength="20" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="filipe" value="${esc(d.handle || '')}"></div>
      <span class="hint">Distingue perfis com o mesmo nome. Só letras, números, ponto e _.</span></div>
    <div class="field"><label>Senha (4 dígitos)</label>
      <input class="input" id="f-pin" inputmode="numeric" maxlength="4" pattern="[0-9]*" placeholder="Deixa vazio para não usar" value="${esc(d.pin)}">
      <span class="hint">Protege este perfil quando houver mais pessoas no telemóvel.</span></div>
    <button class="btn primary" data-act="save-profile">Criar perfil</button>
  </section>`;
}

/* Perfil + navegação */
function navIcons() {                                   // os ícones da barra de baixo (e do "Mais")
  return {
    home: `<svg viewBox="0 0 24 24">${ICONS.calendar}</svg>`,
    subs: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
    spend: '<svg viewBox="0 0 24 24"><path d="M4 7a2 2 0 0 1 2-2h11v4"/><path d="M4 7v10a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1V10a1 1 0 0 0-1-1H6a2 2 0 0 1-2-2z"/><circle cx="16" cy="14" r="1.2"/></svg>',
    fuel: `<svg viewBox="0 0 24 24">${ICONS.car}</svg>`,
    vices: `<svg viewBox="0 0 24 24">${ICONS[viceIcon()]}</svg>`,
    house: `<svg viewBox="0 0 24 24">${ICONS.home}</svg>`,
    manage: `<svg viewBox="0 0 24 24">${ICONS.gear}</svg>`,
    more: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/></svg>',
  };
}
function vProfile() {
  const p = current();
  const mods = MODULES.filter(m => m.ready && p.modules.includes(m.id));
  const navItem = (id, label, svg) => `<button class="${ui.tab === id ? 'on' : ''}" data-act="tab" data-tab="${id}"${id === 'vices' ? ` data-ic="${viceIcon()}"` : ''}>${svg}${label}</button>`;
  const icons = navIcons();
  const body = ui.tab === 'subs' ? vSubs(p) : ui.tab === 'spend' ? vSpend(p) : ui.tab === 'fuel' ? vCar(p) : ui.tab === 'vices' ? vHabits(p) : ui.tab === 'house' ? vHouse(p) : ui.tab === 'manage' ? vManage(p) : vHome(p);
  const plus = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  let fab = '';
  if (ui.tab === 'subs') fab = `<button class="fab" data-act="add-sub" aria-label="Adicionar subscrição">${plus}</button>`;
  else if (ui.tab === 'fuel') fab = ui.carTab === 'shop' ? `<button class="fab" data-act="add-shop" aria-label="Nova despesa do automóvel">${plus}</button>` : `<button class="fab" data-act="add-fuel" aria-label="Novo abastecimento">${plus}</button>`;
  else if (ui.tab === 'vices') fab = `<button class="fab" data-act="add-habit" aria-label="Novo hábito">${plus}</button>`;
  else if (ui.tab === 'house') fab = `<button class="fab" data-act="add-bill" aria-label="Nova conta de casa">${plus}</button>`;
  else if (ui.tab === 'spend' && p.modules.includes('spend'))
    fab = `<button class="fab" data-act="add-spend" aria-label="Registar gasto">${plus}</button>`;
  const shown = mods.length > 3 ? mods.slice(0, 2) : mods, hidden = mods.length > 3 ? mods.slice(2) : [];     // com mais de 3 módulos, os outros ficam em "Mais"
  return `${body}${fab}
    <nav class="nav">
      ${navItem('home', 'Início', icons.home)}
      ${shown.map(m => navItem(m.id, m.short, icons[m.id])).join('')}
      ${hidden.length ? `<button class="${hidden.some(m => m.id === ui.tab) ? 'on' : ''}" data-act="more-nav" data-tab="more">${icons.more}Mais</button>` : ''}
      ${navItem('manage', 'Definições', icons.manage)}
    </nav>`;
}

/* Início: perfil, resumo por período, lembretes, calendário */
function vHome(p) {
  const rem = dueReminders(p).map(r => `
    <div class="reminder">${ico('bell')} <span><b>${esc(r.sub.name)}</b> cobra ${whenText(r.days)} · ${cost(r.amount)}</span></div>`).join('')
    + carDueReminders(p).map(c => `<div class="reminder">${ico('wrench')} <span><b>${esc(c.name)}</b> do automóvel: ${c.text}</span></div>`).join('');
  const n = entriesBetween(p, ...periodRange('month')).length;
  const nudge = needsBackup(p) ? `<button class="reminder nudge" data-act="export-backup">${ico('download')} <span>Já passaram 2 semanas sem cópia de segurança. <b>Exportar agora</b></span></button>` : '';
  return `<section class="screen">
    ${coverHTML(coverState(themeOf(p)))}
    <div class="me">
      <div class="actions">
        <button class="icon-btn" data-act="go-appearance" aria-label="Mudar a aparência">${ico('palette')}</button>
        <button class="icon-btn" data-act="logout" data-kind="swap" aria-label="Trocar de perfil">${ico('swap')}</button>
      </div>
      <button class="avatar-edit" data-act="edit-profile" aria-label="Editar perfil e foto">${avatarHTML(p, 'lg')}<span class="badge">${ico('edit')}</span></button>
      <h1>${esc(p.name)}</h1>
      <p>${p.handle ? `<span class="handle">@${esc(p.handle)}</span> · ` : ''}${n ? `${n} gasto${n === 1 ? '' : 's'} este mês` : 'Ainda sem gastos registados'}</p>
    </div>
    <div id="resta">${restaHTML(p)}</div>
    <div id="summary">${summaryHTML(p)}</div>
    ${balanceNoticeHTML(p)}${nudge}${rem}
    <div id="calendar"></div>
  </section>`;
}

function summaryHTML(p) {
  const [from, to] = periodRange(ui.period);
  const cas = casinoNet(p, ymd(from), ymd(to));                         // casino: saldo do período (ganho ou perda)
  const list = entriesBetween(p, from, to).filter(e => !isCasinoEntry(e));
  const total = list.reduce((a, e) => a + e.amount, 0) + cas.loss;
  const by = {}; list.forEach(e => { const k = e.cat === 'fuel' ? 'shop' : e.cat; by[k] = (by[k] || 0) + e.amount; });      // o combustível conta como Automóvel, a "pasta" principal
  if (cas.loss > 0) by.casino = cas.loss;
  const rows = Object.entries(by).sort((a, b) => b[1] - a[1]);
  const bar = rows.length ? `<div class="stackbar">${rows.map(([c, v]) => `<i style="width:${v / total * 100}%;background:${catOf(c).color}"></i>`).join('')}</div>` : '';
  const legend = rows.map(([c, v]) => `<div class="lg"><i style="background:${catOf(c).color}"></i><span>${ico(catOf(c).icon)} ${catOf(c).name}${c === 'other' ? ' <span class="muted small">(Dia-a-dia)</span>' : ''}</span><b>${cost(v)}</b></div>`).join('');
  const casinoGain = cas.gain > 0 ? `<div class="lg"><i style="background:var(--good)"></i><span>${ico('dice')} Casino</span><b class="pos">+${nf(cas.gain)} €</b></div>` : '';

  const t = today0();
  const tomorrow = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
  // "Ainda por vir": do que falta até ao fim do período escolhido (nada em "Hoje")
  const periodEnd = { week: new Date(t.getFullYear(), t.getMonth(), t.getDate() + (6 - (t.getDay() + 6) % 7)),   // até domingo
    month: new Date(t.getFullYear(), t.getMonth(), dim(t.getFullYear(), t.getMonth())),
    year: new Date(t.getFullYear(), 11, 31) }[ui.period];
  const coming = periodEnd && tomorrow <= periodEnd ? entriesBetween(p, tomorrow, periodEnd).reduce((a, e) => a + e.amount, 0) : 0;
  // "próxima" começa amanhã: o que cobra hoje já está contado nos gastos
  const nxt = [...p.subs, ...p.bills, ...p.carFix].map(s => ({ s, d: nextCharge(s, tomorrow) })).sort((a, b) => a.d - b.d)[0];
  const label = PERIODS.find(x => x[0] === ui.period)[2];

  return `<div class="card summary">
    <div class="seg four">${PERIODS.map(([k, l]) => `<button data-act="period-sum" data-v="${k}" class="${ui.period === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="sum-top"><span class="muted small">Gasto ${label}</span><b class="sum-total neg" data-v="${total}">${cost(total)}</b></div>
    ${bar}${legend}${casinoGain}${!legend && !casinoGain ? '<p class="muted small" style="margin-top:10px">Sem gastos neste período.</p>' : ''}
    ${coming ? `<div class="coming"><span>${ico('hourglass')} Ainda por vir ${label}</span><b class="neg">${cost(coming)}</b></div>` : ''}
    ${nxt ? `<div class="coming"><span>${ico('calendar')} Próxima cobrança: <b>${esc(nxt.s.name)}</b> · ${nxt.d.getDate()} ${MESES[nxt.d.getMonth()].slice(0, 3)}</span><b class="neg">${cost(priceAt(nxt.s, ymOf(nxt.d)))}</b></div>` : ''}
  </div>`;
}

/* Resumo do Início: muda de período (Hoje/Semana/Mês/Ano) com animação, a tocar ou a deslizar para o lado. */
function countUp(el, from) {                       // o total "corre" do valor anterior até ao novo
  const to = Number(el?.dataset.v); if (!el || !isFinite(to) || from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const t0 = performance.now(), D = 380;
  const step = now => {
    const k = Math.min(1, (now - t0) / D), e = 1 - Math.pow(1 - k, 3);
    el.textContent = cost(from + (to - from) * e);
    if (k < 1 && el.isConnected) requestAnimationFrame(step); else if (el.isConnected) el.textContent = cost(to);
  };
  requestAnimationFrame(step);
}
/* ── Quanto resta ──
   Um rendimento recebe-se de uma de três maneiras: num dia do mês (fixo, ou "o N-ésimo dia útil do fim do mês"), num dia da semana, ou em ganhos soltos
   ("+ Ganho": por dia, avulsos). Podem juntar-se. Com um ordenado, o ciclo vai do último pagamento até ao dia antes do próximo (Hoje, Semana e Mês usam o ciclo;
   o Ano usa o ano de calendário). Só com ganhos soltos, o ciclo é o mês ou a semana, à escolha. Resta = o que entrou − o que já saiu − o que ainda vem.
   Se o valor do ordenado varia, a app pergunta quanto recebeste quando o dia passa; até lá usa o último valor real (dobrado nos meses dos subsídios). */
const INCOME_DEFAULT = { name: '', amount: '', rule: 'day', day: '', nth: 1, wday: 5, sub14: false, mFer: 6, mNat: 11, variable: false };
const NTH_LABEL = ['', 'último', 'penúltimo', 'antepenúltimo'];
const WDAY_NAMES = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const incomeName = i => i.name || 'Ordenado';
function bizEndDate(y, m, nth) {                                    // nth: 1 = último dia útil do mês, 2 = penúltimo, 3 = antepenúltimo
  let n = 0;
  for (let d = dim(y, m); d >= 1; d--) { const wd = new Date(y, m, d).getDay(); if (wd !== 0 && wd !== 6 && ++n === nth) return new Date(y, m, d); }
}
const payDate = (i, y, m) => i.rule === 'bizend' ? bizEndDate(y, m, i.nth || 3) : new Date(y, m, Math.min(i.day || 1, dim(y, m)));
function payDatesIn(i, from, to) {                                  // as datas em que um rendimento é pago entre duas datas
  const out = [];
  if (i.rule === 'weekly') {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    d.setDate(d.getDate() + ((i.wday - d.getDay() + 7) % 7));
    for (; d <= to; d.setDate(d.getDate() + 7)) out.push(new Date(d));
    return out;
  }
  for (let k = from.getFullYear() * 12 + from.getMonth() - 1; k <= to.getFullYear() * 12 + to.getMonth() + 1; k++) {
    const d = payDate(i, Math.floor(k / 12), k % 12); if (d >= from && d <= to) out.push(d);
  }
  return out;
}
const isSubMonth = (i, m1) => !!i.sub14 && i.rule !== 'weekly' && (m1 === i.mFer || m1 === i.mNat);          // m1 = mês de 1 a 12
function incomeBase(p, i, ym) {                                      // o valor "normal": o último valor real de um mês sem subsídio; sem ele, o valor do ordenado
  const regs = billReals(p, i).filter(r => r.ym < ym && !isSubMonth(i, +r.ym.slice(5)));
  return regs.length ? regs[regs.length - 1].v : priceAt(i, ym);
}
function incomeEstimate(p, i, ym) { return incomeBase(p, i, ym) * (isSubMonth(i, +ym.slice(5)) ? 2 : 1); }
function payEvents(p, from, to) {                                    // os ordenados que caem entre duas datas
  const out = [];
  for (const i of p.incomes) for (const d of payDatesIn(i, from, to)) {
    const ym = ymOf(d), weekly = i.rule === 'weekly', real = weekly ? undefined : p.billLog[`${i.id}:${ym}`];
    out.push({ inc: i, date: d, ym, real: real !== undefined, v: real ?? (weekly ? priceAt(i, ym) : incomeEstimate(p, i, ym)) });
  }
  return out.sort((a, b) => a.date - b.date);
}
const earnedBetween = (p, from, to) => p.earnings.filter(e => e.date >= ymd(from) && e.date <= ymd(to)).reduce((a, e) => a + e.amount, 0);
function cycleOf(p, t) {                                             // o ciclo do primeiro ordenado: do último pagamento até ao dia antes do próximo
  const a = p.incomes[0]; let start = null, next = null;
  if (a.rule === 'weekly') {
    const back = (t.getDay() - a.wday + 7) % 7;
    start = new Date(t.getFullYear(), t.getMonth(), t.getDate() - back); next = new Date(t.getFullYear(), t.getMonth(), t.getDate() - back + 7);
  } else {
    const k0 = t.getFullYear() * 12 + t.getMonth();
    for (let k = k0 - 1; k <= k0 + 1; k++) { const d = payDate(a, Math.floor(k / 12), k % 12); if (d <= t) start = d; else if (!next) next = d; }
  }
  return { start, next, end: new Date(next.getFullYear(), next.getMonth(), next.getDate() - 1) };
}
function spentBetween(p, from, to) {                                // o que já saiu (o casino conta pelo saldo do período)
  const cas = casinoNet(p, ymd(from), ymd(to));
  return entriesBetween(p, from, to).filter(e => !isCasinoEntry(e)).reduce((a, e) => a + e.amount, 0) + cas.loss;
}
function restaInfo(p) {
  const t = today0(), y = t.getFullYear(), year = ui.period === 'year', tom = afterToday();
  let start, end, next = null, mode = 'cycle';
  if (year) { start = new Date(y, 0, 1); end = new Date(y, 11, 31); }
  else if (p.incomes.length) { const c = cycleOf(p, t); start = c.start; end = c.end; next = c.next; }
  else { mode = p.earnCycle; [start, end] = periodOf(mode, t); next = nextPeriod(mode, end); }       // só ganhos soltos: o mês ou a semana
  const income = payEvents(p, start, end).filter(e => !year || e.date.getFullYear() * 12 + e.date.getMonth() >= startIndex(e.inc)).reduce((a, e) => a + e.v, 0) + earnedBetween(p, start, end);
  const spent = spentBetween(p, start, t), coming = tom <= end ? entriesBetween(p, tom, end).reduce((a, e) => a + e.amount, 0) : 0;
  return { year, y, mode, income, spent, coming, left: income - spent - coming, days: Math.round((end - t) / DAY) + 1, next };
}
function pendingIncomes(p) {                                        // ordenados de valor variável do ciclo atual que já caíram e ainda não têm o valor real
  if (!p.incomes.length) return [];
  const t = today0();
  return payEvents(p, cycleOf(p, t).start, t).filter(e => e.inc.variable && !e.real && e.inc.rule !== 'weekly');
}
const dayMon = d => `${d.getDate()} ${MESES[d.getMonth()].slice(0, 3)}`;
function restaHTML(p) {
  if (!p.incomes.length && !p.earnings.length) return `<div class="card resta-empty"><p class="muted">Descobre quanto te resta. Regista o ordenado ou os teus ganhos.</p>
    <div class="resta-btns"><button class="btn primary" data-act="add-income">Adicionar ordenado</button><button class="btn ghost" data-act="add-earning">${ico('plus')} Ganho</button></div></div>`;
  const r = restaInfo(p), full = Math.max(r.income, r.spent + r.coming, 1);
  const pct = n => Math.max(0, Math.min(100, n / full * 100)).toFixed(1);
  const neg = r.left < 0, perDay = r.days > 0 ? r.left / r.days : 0, pend = pendingIncomes(p);
  const title = r.year ? 'Resta em ' + r.y : r.mode === 'week' ? 'Resta esta semana' : r.mode === 'month' ? 'Resta este mês' : 'Resta até ao próximo ordenado';
  const until = r.year ? 'até ao fim do ano' : r.mode === 'week' ? 'até ao fim da semana' : r.mode === 'month' ? 'até ao fim do mês' : 'até ao próximo ordenado, a ' + dayMon(r.next);
  const pendHTML = pend.length ? `<div class="card resta-pend">${pend.map(e => `<button class="item" data-act="invoice" data-id="${e.inc.id}:${e.ym}"><div class="ic pillow shine">${ico('euroCoin')}</div>
      <div class="grow"><b>Quanto recebeste em ${MESES[e.date.getMonth()]}?</b><span>${esc(incomeName(e.inc))} · estimativa ${nf(e.v)} €</span></div></button>`).join('')}</div>` : '';
  return `${pendHTML}<div class="big-total resta-card">
      <button class="rest-add" data-act="add-earning">${ico('plus')} Ganho</button>
      <button class="rest-edit" data-act="income-menu" aria-label="Ordenados e ganhos">${ico('edit')}</button>
      <span>${title}</span><b data-v="${r.left}">= ${nf(r.left)} €</b>
      <div class="rbar2"><i class="g" style="width:${pct(r.spent)}%"></i><i class="p" style="width:${pct(r.coming)}%"></i></div>
      ${btStats([[nf(r.income) + ' €', r.year ? 'entrou' : 'recebido'], [cost(r.spent), 'gasto'], [cost(r.coming), 'por vir']])}
    </div>
    <div class="card resta-day">${neg
      ? `<div class="rd-row"><span>Já gastaste mais do que entrou em</span><b class="neg">${nf(-r.left)} €</b></div>`
      : `<div class="rd-row"><span>Podes gastar</span><b class="pos">≈ ${nf(perDay)} € por dia</b></div><div class="rd-row sub"><span>${until}</span><span>${r.days} dia${r.days === 1 ? '' : 's'}</span></div>`}</div>`;
}
function refreshResta() {
  const box = document.getElementById('resta'), p = current(); if (!box || !p) return;
  const prev = Number(box.querySelector('.big-total b')?.dataset.v) || 0;
  swapBox(box, restaHTML(p));
  countUp(box.querySelector('.big-total b'), prev);
}
const payText = i => i.rule === 'weekly' ? `toda a ${WDAY_NAMES[i.wday]}` : i.rule === 'bizend' ? `${NTH_LABEL[i.nth || 3]} dia útil do mês` : `dia ${i.day}`;
/* O que entrou num mês (ordenados e ganhos): para o calendário e para o balanço. Fica à parte dos gastos: nunca entra nos totais de gastos. */
function incomesOn(p, y, m) {
  const out = [];
  for (const e of payEvents(p, new Date(y, m, 1), new Date(y, m, dim(y, m)))) {
    if (e.date.getFullYear() * 12 + e.date.getMonth() < startIndex(e.inc)) continue;               // só conta desde o mês em que o ordenado foi criado
    out.push({ kind: 'income', act: 'edit-income', id: e.inc.id, date: e.date, day: e.date.getDate(), amount: e.v, name: incomeName(e.inc), est: e.inc.variable && !e.real });
  }
  for (const g of p.earnings) if (g.date.startsWith(`${y}-${pad(m + 1)}-`)) out.push({ kind: 'earning', act: 'edit-earning', id: g.id, date: parseYmd(g.date), day: +g.date.slice(8), amount: g.amount, name: g.note || 'Ganho', est: false });
  return out.sort((a, b) => a.day - b.day);
}
function monthBalance(p, y, m) {                                     // entrou − saiu num mês de calendário; o mês em curso é provisório ("até agora"); sem rendimento registado, não há balanço
  const t = today0(), k = y * 12 + m, kt = t.getFullYear() * 12 + t.getMonth();
  if (k > kt) return null;
  const upto = k === kt ? t : new Date(y, m, dim(y, m));
  const income = incomesOn(p, y, m).filter(i => i.date <= upto).reduce((a, i) => a + i.amount, 0);
  if (!(income > 0)) return null;
  const spent = spentBetween(p, new Date(y, m, 1), upto);
  return { income, spent, diff: income - spent, open: k === kt };
}
const capital = t => t[0].toUpperCase() + t.slice(1);
const balanceVerdict = (mes, d) => d > 0.004 ? `${mes} fechou a positivo: sobraram ${nf(d)} €.` : d < -0.004 ? `${mes} fechou a negativo: gastaste mais ${nf(-d)} € do que entrou.` : `${mes} fechou certo: gastaste o que entrou.`;
function balanceHTML(p, y, m) {                                      // o balanço do mês, por baixo do calendário
  const b = monthBalance(p, y, m); if (!b) return '';
  const mes = capital(MESES[m]), cls = b.diff > 0.004 ? 'pos' : b.diff < -0.004 ? 'neg' : '';
  const totals = `Entrou ${nf(b.income)} € · saiu ${nf(b.spent)} €`;
  return b.open
    ? `<div class="cal-bal open"><div class="t"><span>Balanço de ${MESES[m]}</span><span class="v1">até agora ${signed(b.diff)}</span></div><div class="sub">${totals}</div></div>`
    : `<div class="cal-bal"><div class="t"><span>Balanço de ${MESES[m]}</span><b class="${cls}">${signed(b.diff)}</b></div><div class="sub">${balanceVerdict(mes, b.diff)}</div><div class="sub">${totals}</div></div>`;
}
function balanceNoticeHTML(p) {                                      // aviso opcional (Definições): nos primeiros dias do mês, como fechou o mês anterior
  if (!p.balanceNotice) return '';
  const t = today0(); if (t.getDate() > 5) return '';
  const pm = new Date(t.getFullYear(), t.getMonth() - 1, 1), ym = ymOf(pm);
  if (p.noticeSeen === ym) return '';
  const b = monthBalance(p, pm.getFullYear(), pm.getMonth()); if (!b || b.open) return '';
  const mes = capital(MESES[pm.getMonth()]), good = b.diff >= 0;
  return `<button class="balance-note ${good ? 'good' : 'bad'}" data-act="dismiss-balance" data-v="${ym}"><span class="bn-ic">${ico(good ? 'check' : 'warn')}</span>
    <span><b>${mes} fechou a ${good ? 'positivo' : 'negativo'}</b><br>${good ? `Sobraram ${nf(b.diff)} €.` : `Gastaste mais ${nf(-b.diff)} € do que entrou.`}</span></button>`;
}
function incomeMenuSheet() {                                         // ordenados e ganhos: tocar para editar, ou juntar outro
  const p = current(), recent = p.earnings.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  openSheet(`<h2>Ordenados e ganhos</h2>
    ${p.incomes.map(i => `<button class="item" data-act="edit-income" data-id="${i.id}"><div class="ic pillow shine">${ico('euroCoin')}</div>
      <div class="grow"><b>${esc(incomeName(i))}</b><span>${nf(curAmount(i))} € · ${payText(i)}${i.sub14 && i.rule !== 'weekly' ? ' · subsídios' : ''}</span></div></button>`).join('')}
    ${recent.length ? `<p class="hint" style="margin:14px 0 4px">Ganhos recentes</p>${recent.map(e => { const d = parseYmd(e.date);
      return `<button class="item" data-act="edit-earning" data-id="${e.id}"><div class="ic pillow">${ico('plus')}</div>
      <div class="grow"><b>${esc(e.note || 'Ganho')}</b><span>${d.getDate()} ${MESES[d.getMonth()].slice(0, 3)}</span></div><div class="amt pos">+${nf(e.amount)} €</div></button>`; }).join('')}` : ''}
    ${p.incomes.length ? '' : `<div class="field" style="margin-top:14px"><label>O resta conta</label><div class="chips">${[['month', 'O mês'], ['week', 'A semana']].map(([k, l]) => `<button type="button" class="chip ${p.earnCycle === k ? 'on' : ''}" data-act="earn-cycle" data-v="${k}" style="--c:var(--accent)">${l}</button>`).join('')}</div></div>`}
    <div class="stack"><button class="btn primary" data-act="add-earning">${ico('plus')} Registar ganho</button><button class="btn ghost" data-act="add-income">${ico('plus')} Adicionar ordenado</button></div>`);
}
function incomeSheet(inc) {
  const s = inc || INCOME_DEFAULT;
  ui.editId = inc?.id || null; ui.incSub = !!s.sub14; ui.incVar = !!s.variable; ui.incRule = s.rule || 'day';
  const mon = (id, v) => `<select class="input" id="${id}">${MESES.map((n, k) => `<option value="${k + 1}" ${v === k + 1 ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
  const monthly = () => ui.incRule !== 'weekly';
  openSheet(`
    <h2>${inc ? 'Editar ordenado' : 'Novo ordenado'}</h2>
    <div class="field"><label>Nome (opcional)</label><input class="input" id="in-name" maxlength="30" placeholder="Ordenado" value="${esc(s.name)}"></div>
    <div class="field"><label>Valor líquido (€) *</label><input class="input big" id="in-amount" inputmode="decimal" placeholder="0,00" value="${s.amount === '' ? '' : String(inc ? curAmount(inc) : s.amount).replace('.', ',')}">${inc && pricesText(inc) ? `<span class="hint">${pricesText(inc)}</span>` : ''}</div>
    <div class="field"><label>Quando recebes</label>
      <div class="chips">${[['day', 'Um dia fixo'], ['bizend', 'Dia útil do fim do mês'], ['weekly', 'Toda a semana']].map(([k, l]) => `<button type="button" class="chip ${ui.incRule === k ? 'on' : ''}" data-act="in-rule" data-v="${k}" style="--c:var(--accent)">${l}</button>`).join('')}</div>
      <span class="hint">Se ganhas por dia ou de forma irregular, usa o botão "+ Ganho" no cartão do resta.</span></div>
    <div class="field" id="in-day-wrap" style="${ui.incRule === 'day' ? '' : 'display:none'}"><label>Dia do mês</label><input class="input" id="in-day" type="number" min="1" max="31" value="${s.day}"></div>
    <div class="field" id="in-nth-wrap" style="${ui.incRule === 'bizend' ? '' : 'display:none'}"><label>Qual dia útil</label>
      <select class="input" id="in-nth">${[1, 2, 3].map(n => `<option value="${n}" ${(s.nth || 3) === n ? 'selected' : ''}>${NTH_LABEL[n][0].toUpperCase() + NTH_LABEL[n].slice(1)} dia útil</option>`).join('')}</select>
      <span class="hint">Conta de segunda a sexta. Os feriados não são considerados.</span></div>
    <div class="field" id="in-wday-wrap" style="${ui.incRule === 'weekly' ? '' : 'display:none'}"><label>Que dia da semana</label>
      <select class="input" id="in-wday">${WDAY_NAMES.map((n, k) => `<option value="${k}" ${(s.wday ?? 5) === k ? 'selected' : ''}>${n[0].toUpperCase() + n.slice(1)}</option>`).join('')}</select></div>
    <div id="in-monthly" style="${monthly() ? '' : 'display:none'}">
      <div class="switch-row" data-act="in-var"><div><b>O valor muda todos os meses</b><div class="hint">Quando o ordenado cai, a app pergunta quanto recebeste. Até lá usa o último valor.</div></div><div class="switch ${s.variable ? 'on' : ''}" id="in-var-switch"></div></div>
      <div class="switch-row" data-act="in-sub"><div><b>Subsídios de férias e de Natal</b><div class="hint">Em dois meses do ano recebes mais ou menos o dobro</div></div><div class="switch ${s.sub14 ? 'on' : ''}" id="in-sub-switch"></div></div>
      <div class="row2" id="in-sub-wrap" style="${s.sub14 ? '' : 'display:none'}">
        <div class="field"><label>Mês do subsídio de férias</label>${mon('in-fer', s.mFer)}</div>
        <div class="field"><label>Mês do subsídio de Natal</label>${mon('in-nat', s.mNat)}</div>
      </div>
    </div>
    <div class="stack">
      <button class="btn primary" data-act="save-income">Guardar</button>
      ${inc ? '<button class="btn danger" data-act="del-income">Eliminar</button>' : ''}
    </div>`);
}
function earningSheet(e) {                                           // um ganho solto: valor, data e nota
  const s = e || { amount: '', date: ymd(today0()), note: '' };
  ui.editId = e?.id || null;
  openSheet(`
    <h2>${e ? 'Editar ganho' : 'Registar ganho'}</h2>
    <div class="field"><label>Valor (€) *</label><input class="input big" id="ea-amount" inputmode="decimal" placeholder="0,00" value="${s.amount === '' ? '' : String(s.amount).replace('.', ',')}"></div>
    <div class="row2">
      <div class="field"><label>Data</label><input class="input" id="ea-date" type="date" value="${s.date}"></div>
      <div class="field"><label>Nota (opcional)</label><input class="input" id="ea-note" maxlength="40" placeholder="Ex.: Cliente" value="${esc(s.note || '')}"></div>
    </div>
    <span class="hint" style="display:block;margin:-4px 0 14px">Podes registar todos os dias, ou o total da semana no último dia.</span>
    <div class="stack">
      <button class="btn primary" data-act="save-earning">Guardar</button>
      ${e ? '<button class="btn danger" data-act="del-earning">Eliminar</button>' : ''}
    </div>`);
}
function setPeriod(k, slide) {                    // slide = true só quando vem de um deslize; ao tocar nos botões o cartão fica no sítio
  const p = current(), old = PERIODS.findIndex(x => x[0] === ui.period), nu = PERIODS.findIndex(x => x[0] === k);
  if (!p || nu < 0 || old === nu) return;
  const prev = Number(document.querySelector('#summary .sum-total')?.dataset.v) || 0;
  const oldSeg = document.querySelector('#summary .seg'), ox = oldSeg?.style.getPropertyValue('--sx'), ow = oldSeg?.style.getPropertyValue('--sw');
  ui.period = k; $('#summary').innerHTML = summaryHTML(p); refreshResta();
  const newSeg = document.querySelector('#summary .seg');
  if (newSeg && ox) { newSeg.style.setProperty('--sx', ox); newSeg.style.setProperty('--sw', ow); newSeg.classList.add('ready'); void newSeg.offsetWidth; }   // parte da posição antiga: o destaque desliza até à nova
  const card = document.querySelector('#summary .summary');
  if (slide) card.classList.add(nu > old ? 'from-r' : 'from-l');
  countUp(card.querySelector('.sum-total'), prev);
}
/* Troca o conteúdo de uma caixa que tem um cartão grande (#vsummary, #subsbox) sem recriar o cartão: as camadas do estilo (medusas, algas, barras…)
   não são apagadas e a animação continua sem voltar ao início; o destaque do seletor desliza do botão antigo para o novo. */
function swapBox(box, html) {
  const oldSeg = box.querySelector('.seg'), ox = oldSeg?.style.getPropertyValue('--sx'), ow = oldSeg?.style.getPropertyValue('--sw');
  const bt = box.querySelector('.big-total'), keep = bt ? [...bt.querySelectorAll(':scope > .cv-card, :scope > .cv-drift')] : [];
  const tpl = document.createElement('template'); tpl.innerHTML = html;
  const nbt = tpl.content.querySelector('.big-total');
  if (bt && nbt && keep.length) {
    [...bt.children].forEach(c => { if (!keep.includes(c)) c.remove(); });
    bt.append(...nbt.childNodes); nbt.remove();
    [...box.children].forEach(c => { if (c !== bt) c.remove(); });
    box.append(tpl.content);
  } else box.innerHTML = html;
  const seg = box.querySelector('.seg');
  if (seg && ox) { seg.style.setProperty('--sx', ox); seg.style.setProperty('--sw', ow); seg.classList.add('ready'); void seg.offsetWidth; }
  syncAnims();
}
/* Visão geral dos Vícios (#vsummary): muda de período só ao tocar em Hoje / Semana / Mês / Ano (sem deslizar o cartão); o total "corre" até ao valor novo. */
function refreshVSummary(p) {                       // chamado ao mudar de período e a cada +1 / −1 num hábito
  const box = document.getElementById('vsummary'); if (!box) return;
  const prev = Number(box.querySelector('.big-total b')?.dataset.v) || 0;
  swapBox(box, vSummaryHTML(p));
  countUp(box.querySelector('.big-total b'), prev);
}
function setVPeriod(k) {
  const p = current(), old = PERIODS.findIndex(x => x[0] === ui.vperiod), nu = PERIODS.findIndex(x => x[0] === k);
  if (!p || nu < 0 || old === nu) return;
  ui.vperiod = k; refreshVSummary(p);
}
function swipePeriod(dir) {                         // dir: +1 = próximo (deslizar para a esquerda), -1 = anterior (só o resumo do Início)
  const i = PERIODS.findIndex(x => x[0] === ui.period) + dir;
  if (i >= 0 && i < PERIODS.length) return setPeriod(PERIODS[i][0], true);
  const card = document.querySelector('#summary .summary');                       // já está no fim: um pequeno "abanão"
  if (card) { card.classList.remove('edge-l', 'edge-r', 'slide-r', 'slide-l'); void card.offsetWidth; card.classList.add(dir > 0 ? 'edge-l' : 'edge-r'); }
}
// Deslizar entre períodos em tempo real: o cartão acompanha o dedo (com resistência no fim da lista) e, ao largar, ou muda de período ou volta ao sítio.
let swipe0 = null, swipedAt = 0;
const swipeCard = () => document.querySelector('#summary .summary');
const swipeValid = dir => { const i = PERIODS.findIndex(x => x[0] === ui.period) + dir; return i >= 0 && i < PERIODS.length; };
const swipeBack = c => {
  if (!c) return;
  c.style.transition = 'transform .38s cubic-bezier(.2, .8, .2, 1), opacity .38s ease'; c.style.transform = ''; c.style.opacity = '';
  setTimeout(() => { if (c.isConnected) c.style.transition = ''; }, 420);
};
document.addEventListener('touchstart', e => {
  const t = e.touches.length === 1 && e.target.closest?.('#summary .summary');
  if (!t || e.target.closest('button, a, input, select, .seg')) { swipe0 = null; return; }       // quem toca nos botões (Hoje, Semana…) não agarra o cartão
  swipe0 = { x: e.touches[0].clientX, y: e.touches[0].clientY, c: swipeCard(), lock: null };
}, { passive: true });
document.addEventListener('touchmove', e => {
  if (!swipe0) return;
  const t = e.touches[0], dx = t.clientX - swipe0.x, dy = t.clientY - swipe0.y;
  if (!swipe0.lock) {                                                              // decide cedo: gesto horizontal (arrastar o cartão) ou vertical (scroll da página)
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.3) swipe0.lock = 'h'; else if (Math.abs(dy) > 10) swipe0.lock = 'v';
  }
  if (swipe0.lock !== 'h' || !swipe0.c) return;
  const off = Math.max(-140, Math.min(140, dx * (swipeValid(dx < 0 ? 1 : -1) ? .8 : .25)));
  swipe0.c.style.transition = 'none'; swipe0.c.style.transform = `translateX(${off}px)`; swipe0.c.style.opacity = String(1 - Math.min(.35, Math.abs(off) / 300));
}, { passive: true });
document.addEventListener('touchend', e => {
  if (!swipe0) return;
  const s = swipe0, t = e.changedTouches[0], dx = t.clientX - s.x, dy = t.clientY - s.y; swipe0 = null;
  if (s.lock !== 'h') return;
  swipedAt = Date.now();
  const dir = dx < 0 ? 1 : -1;
  if (Math.abs(dx) >= 48 && Math.abs(dx) >= Math.abs(dy) * 1.5 && swipeValid(dir)) {
    if (s.c) { s.c.style.transition = ''; s.c.style.transform = ''; s.c.style.opacity = ''; }
    swipePeriod(dir);
  } else swipeBack(s.c);                                                           // curto demais, ou já no fim: volta ao sítio
}, { passive: true });
document.addEventListener('touchcancel', () => { if (swipe0?.lock === 'h') swipeBack(swipe0.c); swipe0 = null; }, { passive: true });

const calNoMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function calOpen(el) {                              // abre devagar: altura, margens e opacidade crescem a partir de zero
  if (!el || calNoMotion()) return;
  const cs = getComputedStyle(el), to = { height: el.offsetHeight + 'px', paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, marginTop: cs.marginTop, marginBottom: cs.marginBottom, opacity: 1 };
  el.style.overflow = 'hidden';
  el.animate([{ height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px', opacity: 0 }, to], { duration: 300, easing: 'cubic-bezier(.2, .8, .2, 1)' }).onfinish = () => { el.style.overflow = ''; };
}
function calClose(el, done) {                       // fecha devagar e só depois tira o conteúdo
  if (!el || calNoMotion()) return done();
  const cs = getComputedStyle(el); el.style.overflow = 'hidden';
  const an = el.animate([{ height: el.offsetHeight + 'px', paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, marginTop: cs.marginTop, marginBottom: cs.marginBottom, opacity: 1 },
    { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px', opacity: 0 }], { duration: 240, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' });
  an.onfinish = done;
}
function refreshCalSummary(p) {                    // abrir/fechar as listas do histórico só mexe na zona do histórico (o resto do calendário não se refaz nem repete as animações)
  const tmp = document.createElement('div'); tmp.innerHTML = vCalendar(p);
  const novo = tmp.querySelector('#cal-sum'), velho = document.getElementById('cal-sum');
  if (novo && velho) velho.innerHTML = novo.innerHTML; else $('#calendar').innerHTML = tmp.innerHTML;
}
function vCalendar(p) {
  const { y, m } = ui.cal;
  const calAnim = ui.calAnim || '', calPop = ui.calPop; ui.calAnim = ''; ui.calPop = null;   // animações de uma só vez: mudar de mês / escolher um dia
  const first = (new Date(y, m, 1).getDay() + 6) % 7;       // segunda = 0
  const entries = entriesOn(p, y, m), incs = incomesOn(p, y, m), incByDay = {};
  incs.forEach(i => incByDay[i.day] = true);
  const byDay = {}; entries.forEach(e => (byDay[e.day] ||= []).push(e));
  const now = new Date();
  let cells = DOW.map(d => `<div class="dow">${d}</div>`).join('') + '<div class="day empty"></div>'.repeat(first);
  for (let d = 1; d <= dim(y, m); d++) {
    const isToday = now.getFullYear() === y && now.getMonth() === m && now.getDate() === d;
    const cats = [...new Set((byDay[d] || []).map(e => e.cat === 'fuel' ? 'shop' : e.cat))].slice(0, 3);
    const dots = cats.map(c => `<i class="dot" style="background:${catOf(c).color}"></i>`).join('') + '';
    cells += `<button class="day ${isToday ? 'today' : ''} ${ui.cal.sel === d ? 'sel' : ''} ${calPop === d ? 'pop' : ''}" data-act="sel-day" data-d="${d}">${d}<span class="dots${cats.length + (incByDay[d] ? 1 : 0) > 3 ? ' many' : ''}">${incByDay[d] ? '<i class="dot inc"></i>' : ''}${dots}</span></button>`;
  }
  const dstr = d => `${y}-${pad(m + 1)}-${pad(d)}`;
  const shown = ui.cal.sel ? (byDay[ui.cal.sel] || []) : entries;
  // total do dia (se selecionado) ou do mês; o casino entra pelo saldo do período
  const headTotal = spendOf(p, shown, dstr(ui.cal.sel || 1), dstr(ui.cal.sel || dim(y, m)));
  let summary = '';
  if (ui.cal.sel) {                             // acumulado até ao dia selecionado
    const upTo = ui.cal.sel;
    const monthList = entries.filter(e => e.day <= upTo);
    const inMonth = spendOf(p, monthList, dstr(1), dstr(upTo));
    const yearGroups = [];                                  // [{mm, list}] só meses com gastos
    for (let mm = 0; mm <= m; mm++) {
      const list = entriesOn(p, y, mm).filter(e => mm < m || e.day <= upTo);
      if (list.length) yearGroups.push({ mm, list });
    }
    const inYear = spendOf(p, yearGroups.flatMap(g => g.list), `${y}-01-01`, dstr(upTo));
    const monthSpend = g => spendOf(p, g.list, `${y}-${pad(g.mm + 1)}-01`, g.mm < m ? `${y}-${pad(g.mm + 1)}-${pad(dim(y, g.mm))}` : dstr(upTo));
    const srcOf = e => e.kind === 'sub' ? 'Subscrições' : e.kind === 'bill' ? 'Casa' : e.kind === 'carfix' || e.cat === 'fuel' || e.cat === 'shop' ? 'Automóvel' : e.kind === 'habit' ? 'Vícios' : 'Dia-a-dia';      // de que separador vem cada linha
    const hline = e => `<div class="hline"><i style="background:${catOf(e.cat === 'fuel' ? 'shop' : e.cat).color}"></i><span class="d">${e.day}</span><span class="n"><span class="nm">${esc(e.name)}</span><small class="src">${srcOf(e)}</small></span><b class="${e.gain > 0 ? 'pos' : ''}">${amtText(e)}</b></div>`;
    const openM = ui.cal.open === 'month', openY = ui.cal.open === 'year';
    summary = `<button class="total hist-toggle" data-act="toggle-hist" data-v="month" aria-expanded="${openM}">
        <span>Gastos em ${MESES[m]} até dia ${upTo} ${ico('down', openM ? 'flip' : '')}</span><span class="neg">${cost(inMonth)}</span></button>
      ${openM ? `<div class="hist">${monthList.map(hline).join('') || '<p class="muted small">Sem gastos.</p>'}</div>` : ''}
      <button class="total hist-toggle" data-act="toggle-hist" data-v="year" aria-expanded="${openY}">
        <span>Gastos em ${y} ${ico('down', openY ? 'flip' : '')}</span><span class="neg">${cost(inYear)}</span></button>
      ${openY ? `<div class="hist">${yearGroups.map(g => {
        const mOpen = ui.cal.openM[g.mm] ?? (g.mm === m);   // o mês atual abre por defeito
        return `<button class="hmonth" data-act="toggle-hm" data-mm="${g.mm}"><span>${ico('down', mOpen ? 'flip' : '')} ${MESES[g.mm]} <small>· ${g.list.length}</small></span><span>${cost(monthSpend(g))}</span></button>${mOpen ? '<div class="hm-body">' + g.list.map(hline).join('') + '</div>' : ''}`;
      }).join('') || '<p class="muted small">Sem gastos.</p>'}</div>` : ''}
      <p class="hint" style="margin-top:10px">Só conta desde o mês em que começaste a registar.</p>`;
  }
  const title = ui.cal.sel ? `${ui.cal.sel} de ${MESES[m]}` : `Gastos de ${MESES[m]}`;
  const lim = ui.cal.limit || 20;                           // listas longas: mostra 20 de cada vez
  const more = shown.length > lim ? `<button class="more" data-act="more-cal">Ver mais (${shown.length - lim})</button>` : '';
  const incRows = (ui.cal.sel ? incs.filter(i => i.day === ui.cal.sel) : incs).map(i => `<button class="item" data-act="${i.act}" data-id="${i.id}"><div class="ic pillow${i.kind === 'income' ? ' shine' : ''}">${ico(i.kind === 'income' ? 'euroCoin' : 'plus')}</div>
    <div class="grow"><b>${esc(i.name)}</b><span>${[i.kind === 'income' ? 'Ordenado' : i.name !== 'Ganho' ? 'Ganho' : '', i.est ? 'estimativa' : '', ui.cal.sel ? '' : 'Dia ' + i.day].filter(Boolean).join(' · ')}</span></div><div class="amt pos">+${nf(i.amount)} €</div></button>`).join('');
  const list = incRows + (shown.length ? shown.slice(0, lim).map(e => entryHTML(e, ui.cal.sel ? '' : `Dia ${e.day}`)).join('') + more
    : incRows ? '' : `<p class="muted small" style="padding:8px 0">Sem gastos ${ui.cal.sel ? 'neste dia' : 'neste mês'}.</p>`);
  return `<div class="card">
      <div class="cal-nav">
        <button data-act="cal-prev" aria-label="Mês anterior" ${y * 12 + m <= firstMonthIndex(p) ? 'disabled' : ''}>${ico('left')}</button>
        <button class="cal-title" data-act="cal-pick" aria-label="Escolher mês e ano"><h3>${MESES[m]} ${y}</h3>${ico('down')}</button>
        <button data-act="cal-next" aria-label="Mês seguinte">${ico('right')}</button>
      </div>
      <div class="cal-grid ${calAnim}">${cells}</div>
      ${balanceHTML(p, y, m)}
    </div>
    <div class="card">
      <div class="card-h"><h3>${title}</h3>${ui.cal.sel && shown.length < 2 ? '' : `<span class="neg" style="font-weight:700">${cost(headTotal)}</span>`}</div>
      ${list}
      <div id="cal-sum">${summary}</div>
    </div>`;
}

/* Linha de um lançamento (subscrição ou gasto avulso) */
function entryHTML(e, extra) {
  const c = catOf(e.cat);
  const isSub = e.kind === 'sub', isHabit = e.kind === 'habit', isBill = e.kind === 'bill', isCar = e.kind === 'carfix';
  const bt = isBill ? billTypeOf(e.bill.type) : null;
  const ic = isSub ? subIc(e.sub, e.name)
           : isBill ? `<div class="ic" style="background:${bt.color}">${ico(bt.icon)}</div>`
           : isCar ? `<div class="ic" style="background:${carFixTypeOf(e.carfix.type).color}">${ico(carFixTypeOf(e.carfix.type).icon)}</div>`
           : isHabit ? `<div class="ic" style="background:${e.habit.color}">${ico(e.habit.icon)}</div>`
                     : `<div class="ic" style="background:${c.color}">${ico(c.icon)}</div>`;
  const sp = e.spend, PR = current();
  const vname = sp?.veh && (PR?.vehicles.length || 0) > 1 ? PR.vehicles.find(v => v.id === sp.veh)?.name : '';     // o veículo só aparece se houver mais do que um
  const fuelInfo = [vname, sp?.liters > 0 ? `${nf(sp.liters, 2)} L · ${nf(sp.amount / sp.liters, 3)} €/L` : ''].filter(Boolean).join(' · ');
  const games = isHabit && e.habit.kind === 'games';
  const habitInfo = isHabit ? [
    e.habit.kind === 'unit' ? `${e.rec.n} un.` : games ? `${e.rec.n} jogo${e.rec.n === 1 ? '' : 's'}` : '',
    e.habit.tpl === 'alcool' && e.rec.ua > 0 ? `${nf(e.rec.ua, 1)} UA` : '',
    e.habit.tpl === 'casino' && e.rec.spent > 0 ? `depositou ${nf(e.rec.spent)} €` : '',
    e.rec.won > 0 ? (games ? `reembolso ${nf(e.rec.won)} €` : `ganhou ${nf(e.rec.won)} €`) : '',
  ].filter(Boolean).join(' · ') : '';
  const billInfoTxt = isBill ? (e.estimated ? 'estimativa' : e.bill.variable ? 'fatura real' : '') : isCar ? (e.estimated ? 'estimativa' : e.carfix.variable ? 'valor real' : '') : '';
  const subtitle = [isSub ? 'Subscrição' : isHabit ? 'Vícios' : isBill ? 'Casa' : isCar ? 'Automóvel · ' + carFixTypeOf(e.carfix.type).name : c.name, fuelInfo, habitInfo, billInfoTxt, extra].filter(Boolean).join(' · ');
  return `<button class="item" data-act="${isSub ? 'edit-sub' : isCar ? 'edit-carfix' : isBill ? 'edit-bill-entry' : isHabit ? (games ? 'goto-habits' : 'edit-hday') : 'edit-spend'}" data-id="${e.id}">
    ${ic}
    <div class="grow"><b>${esc(e.name)}</b><span>${subtitle}${(isSub && e.sub.remind) || (isCar && e.carfix.remind) ? ' · ' + ico('bell') : ''}</span></div>
    <div class="amt ${e.gain > 0 ? 'pos' : 'neg'}">${amtText(e)}</div>
  </button>`;
}

/* Para quem não paga todos os meses: "Paga a 9 set · próxima a 9 set 2027" (a última cobrança e a próxima).
 * Serve para subscrições e contas de casa, que têm os mesmos campos. */
function subStatus(s) {
  const t = today0(), start = startIndex(s);
  let last = null;
  for (let i = 0; i <= 12; i++) {
    const dt = new Date(t.getFullYear(), t.getMonth() - i, 1), y = dt.getFullYear(), m = dt.getMonth();
    if (y * 12 + m < start) break;                                   // antes de a criares não conta
    if (!isChargeMonth(s, m)) continue;
    const d = new Date(y, m, Math.min(s.day, dim(y, m)));
    if (d <= t) { last = d; break; }
  }
  const next = nextCharge(s, afterToday());
  const f = d => `${d.getDate()} ${MESES[d.getMonth()].slice(0, 3)}${d.getFullYear() !== t.getFullYear() ? ' ' + d.getFullYear() : ''}`;
  return `${last ? `${everyOf(s) === 12 ? 'Paga' : 'Última'} a ${f(last)} · ` : ''}próxima a ${f(next)}`;
}
function subRow(s) {
  return `<button class="item" data-act="edit-sub" data-id="${s.id}">
    ${subIc(s)}
    <div class="grow"><b>${esc(s.name)}</b><span>${freqText(s)}${s.remind ? ' · ' + ico('bell') : ''}</span>${everyOf(s) > 1 ? `<div class="bill-trend">${subStatus(s)}</div>` : ''}</div>
    <div class="amt neg">${cost(curAmount(s))}</div>
  </button>`;
}

/* Subscrições: um separador por periodicidade da cobrança (Mês, 2 meses, Trimestral, Semestral, Anual).
   Cada período tem o seu número grande: nos mensais é o total por mês; nos outros, o que se paga de cada vez, com os equivalentes por baixo. */
const SUB_TABS = [['month', 'Mês'], ['bimonth', '2 meses'], ['quarter', 'Trim.'], ['semester', 'Sem.'], ['year', 'Ano']];
const SUB_LABEL = { month: 'Todos os meses', bimonth: 'De 2 em 2 meses', quarter: 'A cada trimestre', semester: 'A cada semestre', year: 'Por ano' };
const subPeriodOf = s => FREQ[s.period] ? s.period : 'month';
function subsBoxHTML(p) {
  const k = SUB_TABS.some(t => t[0] === ui.sper) ? ui.sper : 'month';
  const from = afterToday(), list = p.subs.filter(s => subPeriodOf(s) === k).sort((a, b) => nextCharge(a, from) - nextCharge(b, from));
  const ev = FREQ[k].every, per = list.reduce((a, s) => a + curAmount(s), 0), nx = list[0] && nextCharge(list[0], from);
  const count = [list.length, list.length === 1 ? 'subscrição' : 'subscrições'], next = [nx ? `${nx.getDate()} ${MESES[nx.getMonth()].slice(0, 3)}` : '—', 'próxima'];
  const stats = k === 'month' ? [[eq(per * 12), 'por ano'], count, next] : k === 'year' ? [[eq(per / 12), 'por mês'], count, next] : [[eq(per / ev), 'por mês'], [eq(per * 12 / ev), 'por ano'], next];
  return `<div class="big-total">
      <div class="seg five on-grad">${SUB_TABS.map(([id, l]) => `<button data-act="sper-sum" data-v="${id}" class="${k === id ? 'on' : ''}">${l}</button>`).join('')}</div>
      <span>${SUB_LABEL[k]}</span><b data-v="${per}">${cost(per)}</b>
      ${btStats(stats)}
    </div>
    ${p.subs.length ? (list.length ? `<div class="card"><div class="card-h"><h3>${SUB_LABEL[k]}</h3><span class="muted small">${list.length}</span></div>${list.map(subRow).join('')}</div>`
      : `<div class="card"><div class="empty-state"><div class="emoji">${ico('subs')}</div>Sem subscrições neste período.</div></div>`)
      : `<div class="card"><div class="empty-state"><div class="emoji">${ico('subs')}</div>Ainda não tens subscrições.<br>Toca em <b>+</b> para adicionar a primeira.</div></div>`}`;
}
function refreshSubs() {                            // muda de período no sítio, sem recriar o cartão
  const box = document.getElementById('subsbox'); if (!box) return render();
  const prev = Number(box.querySelector('.big-total b')?.dataset.v) || 0;
  swapBox(box, subsBoxHTML(current()));
  countUp(box.querySelector('.big-total b'), prev);
}
function vSubs(p) {
  return `<section class="screen">
    <h1 class="page-title">Subscrições</h1>
    <div id="subsbox" style="margin-top:16px">${subsBoxHTML(p)}</div>
  </section>`;
}

/* ── Combustível: preço por litro, tendência e consumo ── */
const nf = (n, d = 2) => n.toLocaleString('pt-PT', { minimumFractionDigits: d, maximumFractionDigits: d });
const isFuel = s => s.cat === 'fuel' && s.liters > 0 && s.km > 0;   // só conta com litros e km
const VEHICLE_TYPES = [{ id: 'car', name: 'Carro', icon: 'car' }, { id: 'moto', name: 'Mota', icon: 'moto' }, { id: 'van', name: 'Carrinha', icon: 'car' }, { id: 'other', name: 'Outros', icon: 'fuel' }];
const vehTypeOf = id => VEHICLE_TYPES.find(t => t.id === id) || VEHICLE_TYPES[0];
function fuelKmHint(vid, excludeId) {                        // "Último registo: 84 500 km" — os km são sempre de um veículo
  const k = Math.max(0, ...current().spends.filter(x => isFuel(x) && x.veh === vid && x.id !== excludeId).map(x => x.km));
  return `${k ? `Último registo: ${nf(k, 0)} km. ` : ''}Opcional: com os km, a app calcula o consumo e o custo por km.`;
}

function fuelStats(p, vid) {                                 // a análise é por veículo: o consumo de uma mota não se mistura com o de um carro
  const list = p.spends.filter(s => s.cat === 'fuel' && s.liters > 0 && s.veh === vid);       // o preço por litro não precisa de km
  if (!list.length) return null;
  const price = s => s.amount / s.liters;
  const byDate = list.slice().sort((a, b) => a.date.localeCompare(b.date) || a.km - b.km);
  const series = byDate.map(s => ({ date: s.date, v: price(s) }));
  const last = series[series.length - 1], prev = series[series.length - 2] || null;
  const cut = ymd(new Date(Date.now() - 90 * DAY));                 // média dos últimos 3 meses, sem o último
  const recent = series.slice(0, -1).filter(x => x.date >= cut);
  const avg = recent.length >= 2 ? recent.reduce((a, x) => a + x.v, 0) / recent.length : null;

  /* Consumo pelo método "depósito cheio → depósito cheio": os litros de todos os
     abastecimentos desde o último cheio, divididos pelos km desde esse cheio. */
  const byKm = list.filter(s => s.km > 0).sort((a, b) => a.km - b.km || a.date.localeCompare(b.date));       // o consumo só usa os que têm km
  let lastFull = null, liters = 0, cost = 0, totL = 0, totC = 0, totD = 0, lastL100 = null;
  for (const s of byKm) {
    if (lastFull !== null) { liters += s.liters; cost += s.amount; }
    if (s.full) {
      if (lastFull !== null && s.km > lastFull) {
        const d = s.km - lastFull;
        lastL100 = liters / d * 100; totL += liters; totC += cost; totD += d;
      }
      lastFull = s.km; liters = 0; cost = 0;
    }
  }
  return {
    n: list.length, series, last, prev, avg, lastL100,
    l100: totD ? totL / totD * 100 : null,
    costKm: totD ? totC / totD : null,
    range: byKm.length ? byKm[byKm.length - 1].km - byKm[0].km : 0,
  };
}

function sparkline(series) {
  const pts = series.slice(-12);
  if (pts.length < 2) return '';
  const W = 300, H = 64, pad = 7;
  const vs = pts.map(p => p.v), min = Math.min(...vs), max = Math.max(...vs), span = max - min || 1;
  const xy = pts.map((p, i) => [pad + i * (W - 2 * pad) / (pts.length - 1), H - pad - (p.v - min) / span * (H - 2 * pad)]);
  const dots = xy.map((q, i) => `<circle cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" r="${i === xy.length - 1 ? 4.5 : 3}" fill="${i === xy.length - 1 ? 'var(--accent)' : 'var(--surface)'}" stroke="var(--accent)" stroke-width="1.8"/>`).join('');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolução do preço por litro"><polyline points="${xy.map(q => q.map(n => n.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>${dots}</svg>`;
}

function fuelCard(p, v) {
  const st = v && fuelStats(p, v.id);
  if (!st) return '';
  const diff = st.prev ? st.last.v - st.prev.v : null;
  const trend = diff === null ? '<em>1.º registo</em>'
    : `<em class="${diff > 0 ? 'up' : diff < 0 ? 'dn' : ''}">${diff > 0 ? ico('arrowUp') : diff < 0 ? ico('arrowDown') : ''} ${diff > 0 ? '+' : diff < 0 ? '−' : ''}${nf(Math.abs(diff), 3)} €/L vs. anterior</em>`;
  let sentence = 'Regista mais abastecimentos para veres a tendência do preço.';
  if (st.series.length >= 2) {
    if (st.avg) {
      const pct = (st.last.v - st.avg) / st.avg * 100;
      sentence = Math.abs(pct) < 1 ? 'O último preço está em linha com a tua média dos últimos 3 meses.'
        : `O último preço está ${nf(Math.abs(pct), 1)} % ${pct > 0 ? 'acima' : 'abaixo'} da tua média dos últimos 3 meses.`;
    } else sentence = diff > 0 ? 'O preço subiu desde o último abastecimento.' : diff < 0 ? 'O preço desceu desde o último abastecimento.' : 'O preço manteve-se.';
  }
  return `<div class="card fuel">
    <div class="card-h"><h3>${p.vehicles.length > 1 ? esc(v.name) : 'Combustível'}</h3><span class="muted small">${st.n} abastecimento${st.n === 1 ? '' : 's'}</span></div>
    <div class="fuel-grid">
      <div><span>Último preço</span><b>${nf(st.last.v, 3)} €/L</b>${trend}</div>
      <div><span>Consumo médio</span><b>${st.l100 ? nf(st.l100, 1) + ' L/100 km' : '—'}</b><em>${st.lastL100 ? 'último: ' + nf(st.lastL100, 1) : 'precisa de 2 depósitos cheios'}</em></div>
      <div><span>Custo por km</span><b>${st.costKm ? nf(st.costKm, 3) + ' €/km' : '—'}</b></div>
      <div><span>Km registados</span><b>${nf(st.range, 0)} km</b></div>
    </div>
    ${sparkline(st.series)}
    <p class="hint">${sentence}</p>
  </div>`;
}

/* ── Oficina (dentro do separador Carro): despesas do carro, lembretes por km ou por data e o custo real por km ──
 * As despesas são gastos normais (p.spends) com cat 'shop', tipo (type), km (opcional), local (place) e veículo (veh): entram no calendário e nos totais.
 * Os lembretes (p.shopRems) contam a partir do último registo do mesmo tipo e do mesmo veículo. */
const SHOP_ALL = [
  { id: 'service',    name: 'Revisão',        icon: 'wrench',    color: '#f97316', km: 15000, months: 12 },
  { id: 'oil',        name: 'Óleo e filtros', icon: 'drop',      color: '#f59e0b', km: 15000, months: 12 },
  { id: 'tires',      name: 'Pneus',          icon: 'car',       color: '#64748b', km: 40000, months: 0 },
  { id: 'brakes',     name: 'Travões',        icon: 'warn',      color: '#ef4444', km: 30000, months: 0 },
  { id: 'battery',    name: 'Bateria',        icon: 'bolt',      color: '#eab308', km: 0, months: 48 },
  { id: 'repair',     name: 'Reparação',      icon: 'wrench',    color: '#8b5cf6' },
  { id: 'inspection', name: 'Inspeção',       icon: 'shield',    color: '#10b981', km: 0, months: 12 },
  { id: 'insurance',  name: 'Seguro',         icon: 'shield',    color: '#0ea5e9', km: 0, months: 12 },
  { id: 'tax',        name: 'IUC',            icon: 'building',  color: '#14b8a6', km: 0, months: 12 },
  { id: 'wash',       name: 'Lavagem',        icon: 'drop',      color: '#06b6d4' },
  { id: 'toll',       name: 'Portagens',      icon: 'transport', color: '#6366f1' },
  { id: 'parking',    name: 'Estacionamento', icon: 'car',       color: '#0ea5e9' },
  { id: 'fine',       name: 'Multas',         icon: 'warn',      color: '#f43f5e' },
  { id: 'parts',      name: 'Acessórios',     icon: 'cart',      color: '#a855f7' },
  { id: 'other',      name: 'Outros',         icon: 'other',     color: '#8b93a3' },
];
/* Seguro e IUC repetem-se: passam para os Pagamentos fixos. Continuam em SHOP_ALL só para os registos antigos se verem bem. */
const SHOP_TYPES = SHOP_ALL.filter(t => t.id !== 'insurance' && t.id !== 'tax');
const KM_TYPES = ['service', 'oil', 'tires', 'brakes', 'repair'];       // só nestes faz sentido pedir os km
const REM_DEFAULTS = ['oil', 'service', 'tires', 'inspection'];
const CAR_FIX_TYPES = [
  { id: 'insurance', name: 'Seguro', icon: 'shield',   color: '#0ea5e9', period: 'year', hint: 'Seguradora' },
  { id: 'tax',       name: 'IUC',    icon: 'building', color: '#14b8a6', period: 'year', hint: 'Imposto de circulação' },
  { id: 'leasing',   name: 'Leasing', icon: 'car',     color: '#8b5cf6', period: 'month', hint: 'Banco ou marca' },
  { id: 'other',     name: 'Outros', icon: 'other',    color: '#8b93a3', period: 'month', hint: 'Garagem, Via Verde…' },
];
const carFixTypeOf = id => CAR_FIX_TYPES.find(t => t.id === id) || CAR_FIX_TYPES[CAR_FIX_TYPES.length - 1];      // os lembretes sugeridos quando ainda não há nenhum
const shopTypeOf = id => SHOP_ALL.find(t => t.id === id) || SHOP_ALL[SHOP_ALL.length - 1];
const isShop = s => s.cat === 'shop';
const carKm = (p, vid) => Math.max(0, ...p.spends.filter(s => s.veh === vid && s.km > 0).map(s => s.km));      // o último valor real dos km do veículo (combustível ou outras despesas)
function carKmNow(p, vid) {                                    // os km de hoje: o último valor real, mais o que o carro terá feito desde então (pela tua média por dia, ou pelos "km por ano" do veículo)
  const pts = p.spends.filter(s => s.veh === vid && s.km > 0).sort((a, b) => a.date.localeCompare(b.date) || a.km - b.km);
  if (!pts.length) return { km: 0, est: false };
  const last = pts[pts.length - 1];
  let perDay = null;
  if (pts.length >= 2) { const d = (parseYmd(last.date) - parseYmd(pts[0].date)) / DAY; if (d >= 14 && last.km > pts[0].km) perDay = (last.km - pts[0].km) / d; }
  if (perDay === null) { const v = p.vehicles.find(x => x.id === vid); if (v?.kmYear > 0) perDay = v.kmYear / 365; }
  const days = Math.round((today0() - parseYmd(last.date)) / DAY);
  return perDay && days > 0 ? { km: Math.round(last.km + perDay * days), est: true } : { km: last.km, est: false };
}

function shopKmHint(vid) {
  const P = current(), k = carKm(P, vid), kn = carKmNow(P, vid);
  return `${k ? `Último registo: ${nf(k, 0)} km${kn.est ? ` (agora ≈ ${nf(Math.round(kn.km / 50) * 50, 0)} km, estimado)` : ''}. ` : ''}Os km são opcionais: servem para os lembretes e para o custo real por km.`;
}
function remStatus(p, r) {                                    // estado de um lembrete: ok, perto (soon), atrasado (late) ou sem registo (none)
  const veh = r.veh && p.vehicles.some(x => x.id === r.veh) ? r.veh : p.vehicles[0]?.id;
  const last = p.spends.filter(s => isShop(s) && s.type === r.type && (!veh || s.veh === veh)).sort((a, b) => b.date.localeCompare(a.date) || (b.km || 0) - (a.km || 0))[0];
  if (!last) return { level: 'none', text: 'Sem registo ainda. Regista a última vez.', frac: 0 };
  const kn = veh ? carKmNow(p, veh) : { km: 0, est: false }, km = kn.km, parts = [], fr = [];
  const kmTxt = n => kn.est ? '≈ ' + nf(Math.round(n / 50) * 50, 0) : nf(n, 0);              // com km estimados, o valor é arredondado e leva ≈
  let level = 'ok';
  if (r.everyKm > 0 && last.km > 0) {
    const left = last.km + r.everyKm - km; fr.push(1 - left / r.everyKm);
    if (left < 0) { level = 'late'; parts.push(`atrasado ${kmTxt(-left)} km`); }
    else { if (left <= r.everyKm * .1) level = 'soon'; parts.push(`faltam ${kmTxt(left)} km`); }
  }
  if (r.everyMonths > 0) {
    const due = parseYmd(last.date); due.setMonth(due.getMonth() + r.everyMonths);
    const days = Math.round((due - today0()) / DAY); fr.push(1 - days / (r.everyMonths * 30.4));
    if (days < 0) { level = 'late'; parts.push(`atrasado ${-days} dia${-days === 1 ? '' : 's'}`); }
    else { if (days <= 30 && level === 'ok') level = 'soon'; parts.push(days === 0 ? 'é hoje' : `faltam ${days} dia${days === 1 ? '' : 's'}`); }
  }
  if (!parts.length) return { level: 'none', text: 'Define os km ou os meses do lembrete.', frac: 0 };
  return { level, text: parts.join(' · '), frac: Math.max(0, Math.min(1, Math.max(...fr))) };
}
function carDueReminders(p) {                                 // os lembretes do carro que já estão perto ou atrasados, para o Início
  if (!p.modules.includes('fuel')) return [];
  return p.shopRems.map(r => ({ r, st: remStatus(p, r) })).filter(x => x.st.level === 'soon' || x.st.level === 'late').map(x => ({ name: shopTypeOf(x.r.type).name, text: x.st.text }));
}
function carCostPerKm(p, vid) {                               // combustível + oficina a dividir pelos km entre o primeiro e o último registo com km
  const recs = p.spends.filter(s => s.veh === vid && s.km > 0 && (isShop(s) || isFuel(s))).sort((a, b) => a.km - b.km);
  if (recs.length < 2) return null;
  const dist = recs[recs.length - 1].km - recs[0].km; if (dist < 300) return null;
  return (recs.reduce((a, s) => a + s.amount, 0) - (isFuel(recs[0]) ? recs[0].amount : 0)) / dist;       // o 1.º abastecimento paga km anteriores; uma despesa da oficina conta sempre
}
function shopRow(s) {
  const tp = shopTypeOf(s.type), d = parseYmd(s.date), P = current();
  const vn = P.vehicles.length > 1 && s.veh ? P.vehicles.find(v => v.id === s.veh)?.name : '';
  const sub = [`${d.getDate()} ${MESES[d.getMonth()].slice(0, 3)}${d.getFullYear() !== today0().getFullYear() ? ' ' + d.getFullYear() : ''}`, s.km > 0 ? nf(s.km, 0) + ' km' : '', vn].filter(Boolean).join(' · ');
  return `<button class="item" data-act="edit-shop" data-id="${s.id}"><div class="ic" style="background:${tp.color}">${ico(tp.icon)}</div>
    <div class="grow"><b>${esc(tp.name)}${s.place ? ' · ' + esc(s.place) : ''}</b><span>${sub}</span></div><div class="amt neg">${cost(s.amount)}</div></button>`;
}
function carFixRow(c) {
  const tp = carFixTypeOf(c.type), P = current();
  const vn = P.vehicles.length > 1 && c.veh ? P.vehicles.find(v => v.id === c.veh)?.name : '';
  return `<button class="item" data-act="edit-carfix" data-id="${c.id}"><div class="ic" style="background:${tp.color}">${ico(tp.icon)}</div>
    <div class="grow"><b>${esc(c.name)}</b><span>${freqText(c)}${c.variable ? ' · variável' : ''}${c.remind ? ' · ' + ico('bell') : ''}${vn ? ' · ' + esc(vn) : ''}</span><div class="bill-trend">${subStatus(c)}</div></div>
    <div class="amt neg">${c.variable ? '≈ ' : ''}${cost(billInfo(P, c).typical)}</div></button>`;
}
function carFixCard(p, v) {
  const list = p.carFix.filter(c => !c.veh || !v || c.veh === v.id).sort((a, b) => nextCharge(a, afterToday()) - nextCharge(b, afterToday()));
  const pend = pendingInvoices(p, list).slice(0, 4);                                  // pagamentos variáveis já vencidos e sem valor real
  const pendHTML = pend.length ? `<div class="pend-box"><b>Por registar</b>${pend.map(x => { const tp = carFixTypeOf(x.b.type);
    return `<button class="item" data-act="invoice" data-id="${x.b.id}:${x.ym}"><div class="ic" style="background:${tp.color}">${ico(tp.icon)}</div>
      <div class="grow"><b>${esc(x.b.name)}</b><span>${MESES[+x.ym.slice(5) - 1]} · venceu a ${x.due.getDate()}</span></div><div class="amt muted">${nf(priceAt(x.b, x.ym))} € est.</div></button>`; }).join('')}
    <p class="hint" style="margin:4px 0 10px">Toca para indicar o valor real. Até lá conta a estimativa.</p></div>` : '';
  return `<div class="card"><div class="card-h"><h3>Pagamentos fixos</h3><button class="linkbtn accent" data-act="add-carfix">${ico('plus')} Adicionar</button></div>${pendHTML}${list.length
    ? list.map(carFixRow).join('')
    : `<p class="hint" style="margin:0 0 12px">O que pagas sempre à mesma data: seguro, IUC… Entra no calendário e podes ter um lembrete.</p>
       <div class="chips">${CAR_FIX_TYPES.map(t => `<button type="button" class="chip" data-act="add-carfix" data-v="${t.id}" style="--c:${t.color}">${ico(t.icon)} ${t.name}</button>`).join('')}</div>`}</div>`;
}
function shopBody(p) {
  const t = today0(), y = t.getFullYear(), mpre = `${y}-${pad(t.getMonth() + 1)}-`;
  const v = p.vehicles.find(x => x.id === ui.fuelVeh) || p.vehicles[0];
  if (v) ui.fuelVeh = v.id;
  const list = p.spends.filter(s => isShop(s) && (!v || s.veh === v.id)).sort((a, b) => b.date.localeCompare(a.date) || (b.km || 0) - (a.km || 0));
  const upto = ymd(t);
  const fixed = (m0, m1) => { let a = 0;                                          // pagamentos fixos deste veículo já cobrados (até hoje) entre dois meses
    for (let m = m0; m <= m1; m++) for (const e of entriesOn(p, y, m)) if (e.kind === 'carfix' && (!e.carfix.veh || !v || e.carfix.veh === v.id) && ymd(new Date(y, m, e.day)) <= upto) a += e.amount;
    return a; };
  const year = list.filter(s => s.date.startsWith(`${y}-`) && s.date <= upto).reduce((a, s) => a + s.amount, 0) + fixed(0, 11);
  const month = list.filter(s => s.date.startsWith(mpre) && s.date <= upto).reduce((a, s) => a + s.amount, 0) + fixed(t.getMonth(), t.getMonth());
  const cpk = v ? carCostPerKm(p, v.id) : null;
  const lim = ui.shopLimit || 10;
  const vehChips = p.vehicles.length > 1 ? `<div class="chips" style="margin:16px 0 0">${p.vehicles.map(x =>
    `<button class="chip ${v && x.id === v.id ? 'on' : ''}" data-act="fuel-veh" data-v="${x.id}" style="--c:var(--accent)">${ico(vehTypeOf(x.type).icon)} ${esc(x.name)}</button>`).join('')}</div>` : '';
  const rems = p.shopRems.filter(r => !r.veh || !v || r.veh === v.id);
  const remRow = r => {
    const tp = shopTypeOf(r.type), st = remStatus(p, r), col = st.level === 'late' ? 'var(--danger)' : st.level === 'soon' ? '#f59e0b' : st.level === 'ok' ? 'var(--good)' : 'var(--muted)';
    return `<button class="item" data-act="edit-shoprem" data-id="${r.id}"><div class="ic" style="background:${tp.color}">${ico(tp.icon)}</div>
      <div class="grow"><b>${esc(tp.name)}</b><span style="color:${col}">${st.text}</span><i class="rbar"><u style="width:${Math.round(st.frac * 100)}%;background:${col}"></u></i></div></button>`;
  };
  const noRems = `<p class="hint" style="margin:0 0 12px">Os lembretes avisam quando falta pouco, por km ou por data. Começa por um destes:</p>
    <div class="chips">${REM_DEFAULTS.map(id => { const tp = shopTypeOf(id); return `<button type="button" class="chip" data-act="quick-rem" data-v="${id}" style="--c:${tp.color}">${ico(tp.icon)} ${tp.name}</button>`; }).join('')}</div>`;
  const more = list.length > lim ? `<button class="more" data-act="more-shop">Ver mais (${list.length - lim})</button>` : '';
  const fx = p.carFix.filter(c => !c.veh || !v || c.veh === v.id);                           // o mesmo formato da Casa: o que sai todos os meses, as outras frequências e o total por ano
  const fxMonthly = fx.filter(c => everyOf(c) === 1).reduce((a, c) => a + billInfo(p, c).typical, 0);
  const fxOthers = fx.filter(c => everyOf(c) > 1);
  const fxOthersYear = fxOthers.reduce((a, c) => a + billInfo(p, c).typical * 12 / everyOf(c), 0);
  return `<div class="big-total" style="margin-top:16px">
      <span>Gasto em ${MESES[t.getMonth()]}</span><b>${cost(month)}</b>
      ${btStats([[cost(fxMonthly), 'por mês'], [cost(year), 'este ano'], [eq(fxMonthly * 12 + fxOthersYear), 'por ano']])}
      ${cpk ? `<span class="bt-sub">Custo real: ${nf(cpk, 3)} €/km (com combustível)</span>` : ''}
    </div>
    ${vehChips}
    ${carFixCard(p, v)}
    <div class="card"><div class="card-h"><h3>Lembretes</h3><button class="linkbtn accent" data-act="add-shoprem">${ico('plus')} Adicionar</button></div>${rems.length ? rems.map(remRow).join('') : noRems}</div>
    ${list.length ? `<div class="card"><div class="card-h"><h3>Histórico</h3><span class="muted small">${list.length}</span></div>${list.slice(0, lim).map(shopRow).join('')}${more}</div>`
      : `<div class="card"><div class="empty-state"><div class="emoji">${ico('wrench')}</div>Toca em <b>+</b> para registar outra despesa.</div></div>`}`;
}
/* Separador Carro: um seletor Combustível | Oficina. O + de baixo muda conforme o que está aberto. */
function vCar(p) {
  const tab = ui.carTab === 'shop' ? 'shop' : 'fuel';
  return `<section class="screen">
    <h1 class="page-title">Automóvel <button class="help-btn" data-act="car-help" aria-label="Como funciona o Automóvel">?</button></h1>
    <div class="seg two" style="margin-top:14px"><button data-act="car-tab" data-v="fuel" class="${tab === 'fuel' ? 'on' : ''}">Combustível</button><button data-act="car-tab" data-v="shop" class="${tab === 'shop' ? 'on' : ''}">Outras despesas</button></div>
    <div id="car-body" class="car-body">${tab === 'shop' ? shopBody(p) : fuelBody(p)}</div>
  </section>`;
}
/* Mudar entre Combustível e Oficina: o seletor desliza e só o conteúdo de baixo muda, numa única transição (sai um pouco para um lado, entra do outro).
   Não se redesenha o ecrã todo, por isso os cartões não repetem a sua própria animação de entrada. */
function carSwitch(to) {
  const p = current(), from = ui.carTab === 'shop' ? 'shop' : 'fuel';
  if (!p || to === from) return;
  const body = document.getElementById('car-body');
  if (!body) { ui.carTab = to; render(); return; }
  const tok = carSwitch.tok = (carSwitch.tok || 0) + 1, dir = to === 'shop' ? 1 : -1;
  ui.carTab = to;
  document.querySelectorAll('[data-act=car-tab]').forEach(b => b.classList.toggle('on', b.dataset.v === to)); syncSegs();          // o seletor desliza
  const fab = document.querySelector('.fab');
  if (fab) { fab.dataset.act = to === 'shop' ? 'add-shop' : 'add-fuel'; fab.setAttribute('aria-label', to === 'shop' ? 'Nova despesa do automóvel' : 'Novo abastecimento'); }
  const troca = () => { body.innerHTML = to === 'shop' ? shopBody(current()) : fuelBody(current()); decorateTotals(); syncAnims(); };
  body.getAnimations().forEach(a => a.cancel());
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return troca();
  body.classList.add('swapping');
  const saida = body.animate([{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(' + (-dir * 28) + 'px)' }], { duration: 140, easing: 'ease-in', fill: 'forwards' });
  saida.onfinish = () => {
    if (tok !== carSwitch.tok) return;
    troca(); saida.cancel();
    body.animate([{ opacity: 0, transform: 'translateX(' + (dir * 28) + 'px)' }, { opacity: 1, transform: 'translateX(0)' }], { duration: 260, easing: 'cubic-bezier(.2, .8, .2, 1)' }).onfinish = () => { if (tok === carSwitch.tok) body.classList.remove('swapping'); };
  };
}
function shopSheet(sp) {
  const t = today0(), P = current();
  const s = sp || { amount: '', date: ymd(t), type: ui.shopType || 'service', km: '', place: '', note: '' };
  ui.editId = sp?.id || null; ui.shopType = s.type;
  if (!P.vehicles.length) { P.vehicles.push({ id: uid(), name: 'O meu carro', type: 'car' }); saveDB(); }          // a primeira despesa cria o primeiro veículo
  ui.sheetVeh = (s.veh && P.vehicles.some(x => x.id === s.veh)) ? s.veh : (P.vehicles.find(x => x.id === ui.fuelVeh) || P.vehicles[0]).id;
  openSheet(`
    <h2>${sp ? 'Editar despesa' : 'Nova despesa do automóvel'}</h2>
    ${P.vehicles.length > 1 ? `<div class="field"><label>Veículo</label><div class="chips">${P.vehicles.map(x =>
      `<button type="button" class="chip ${x.id === ui.sheetVeh ? 'on' : ''}" data-act="sveh" data-v="${x.id}" style="--c:var(--accent)">${ico(vehTypeOf(x.type).icon)} ${esc(x.name)}</button>`).join('')}</div></div>` : ''}
    <div class="field"><label>Tipo</label><div class="chips">${SHOP_TYPES.map(tp =>
      `<button type="button" class="chip ${s.type === tp.id ? 'on' : ''}" data-act="shop-type" data-v="${tp.id}" style="--c:${tp.color}">${ico(tp.icon)} ${tp.name}</button>`).join('')}</div></div>
    <div class="field"><label>Valor (€) *</label><input class="input big" id="s-amount" inputmode="decimal" placeholder="0,00" value="${s.amount === '' ? '' : String(s.amount).replace('.', ',')}"></div>
    <div class="row2">
      <div class="field"><label>Data</label><input class="input" id="s-date" type="date" value="${s.date}"></div>
      <div class="field" id="s-km-wrap" style="${KM_TYPES.includes(s.type) ? '' : 'display:none'}"><label>Quilómetros (opcional)</label><input class="input" id="s-km" inputmode="numeric" placeholder="Ex.: 84500" value="${s.km > 0 ? s.km : ''}"></div>
    </div>
    <span class="hint" id="s-km-hint" style="display:${KM_TYPES.includes(s.type) ? 'block' : 'none'};margin:-6px 0 16px">${shopKmHint(ui.sheetVeh)}</span>
    <div class="field"><label>Local (opcional)</label><input class="input" id="s-place" maxlength="40" value="${esc(s.place || '')}"></div>
    <div class="field"><label>Nota (opcional)</label><input class="input" id="s-note" maxlength="80" value="${esc(s.note || '')}"></div>
    <div class="stack">
      <button class="btn primary" data-act="save-shop">Guardar</button>
      ${sp ? '<button class="btn danger" data-act="del-spend">Eliminar</button>' : ''}
    </div>`);
}
function carFixSheet(c, type) {
  const P = current(), t0 = carFixTypeOf(type || 'insurance'), n = new Date();
  const s = c || { type: t0.id, name: '', amount: '', period: t0.period, day: n.getDate(), month: n.getMonth() + 1, remind: true, remindDays: 7, variable: false };
  ui.editId = c?.id || null; ui.cfType = s.type; ui.cfPeriod = s.period; ui.cfRemind = s.remind; ui.cfVar = !!s.variable;
  if (!P.vehicles.length) { P.vehicles.push({ id: uid(), name: 'O meu carro', type: 'car' }); saveDB(); }
  ui.sheetVeh = (s.veh && P.vehicles.some(x => x.id === s.veh)) ? s.veh : (P.vehicles.find(x => x.id === ui.fuelVeh) || P.vehicles[0]).id;
  const monthLabel = per => per === 'year' ? 'Mês' : 'Mês de um pagamento';
  openSheet(`
    <h2>${c ? 'Editar pagamento fixo' : 'Novo pagamento fixo'}</h2>
    ${P.vehicles.length > 1 ? `<div class="field"><label>Veículo</label><div class="chips">${P.vehicles.map(x =>
      `<button type="button" class="chip ${x.id === ui.sheetVeh ? 'on' : ''}" data-act="rveh" data-v="${x.id}" style="--c:var(--accent)">${ico(vehTypeOf(x.type).icon)} ${esc(x.name)}</button>`).join('')}</div></div>` : ''}
    <div class="field"><label>Tipo</label><div class="chips">${CAR_FIX_TYPES.map(t =>
      `<button type="button" class="chip ${s.type === t.id ? 'on' : ''}" data-act="cf-type" data-v="${t.id}" style="--c:${t.color}">${ico(t.icon)} ${t.name}</button>`).join('')}</div></div>
    <div class="field"><label>Nome (opcional)</label><input class="input" id="cf-name" maxlength="30" placeholder="Ex.: ${carFixTypeOf(s.type).hint}" value="${esc(s.name === carFixTypeOf(s.type).name ? '' : s.name)}"></div>
    <div class="switch-row" data-act="cf-var"><div><b>Valor variável</b><div class="hint">Para quando o valor muda de mês para mês. Indicas o valor real quando chega o recibo; até lá conta a estimativa.</div></div><div class="switch ${s.variable ? 'on' : ''}" id="cf-var-switch"></div></div>
    <div class="field"><label id="cf-amount-label">${s.variable ? 'Estimativa de cada pagamento (€) *' : 'Valor de cada pagamento (€) *'}</label>
      <input class="input big" id="cf-amount" inputmode="decimal" placeholder="0,00" value="${s.amount === '' ? '' : String(curAmount(s)).replace('.', ',')}">
      ${c && pricesText(s) ? `<span class="hint">${pricesText(s)}</span>` : ''}</div>
    <div class="field"><label>Paga-se</label>
      <div class="chips">${Object.entries(FREQ).filter(([k]) => k !== 'bimonth').map(([k, f]) => `<button type="button" class="chip ${s.period === k ? 'on' : ''}" data-act="cf-period" data-v="${k}" style="--c:var(--accent)">${f.label.replace('Todos os meses', 'Mensal')}</button>`).join('')}</div></div>
    <div class="row2">
      <div class="field"><label>Dia do mês</label><input class="input" id="cf-day" type="number" min="1" max="31" value="${s.day}"></div>
      <div class="field" id="cf-month-wrap" style="${s.period === 'month' ? 'display:none' : ''}"><label id="cf-month-label">${monthLabel(s.period)}</label>
        <select class="input" id="cf-month">${MESES.map((nm, i) => `<option value="${i + 1}" ${s.month === i + 1 ? 'selected' : ''}>${nm}</option>`).join('')}</select></div>
    </div>
    <div class="switch-row" data-act="cf-remind"><div><b>Lembrar-me</b><div class="hint">Avisar antes do pagamento (e da renovação)</div></div><div class="switch ${s.remind ? 'on' : ''}" id="cf-rswitch"></div></div>
    <div class="field" id="cf-rd-wrap" style="${s.remind ? '' : 'display:none'}"><label>Quanto tempo antes?</label>
      <select class="input" id="cf-rd">${[1, 3, 7, 15, 30].map(k => `<option value="${k}" ${s.remindDays === k ? 'selected' : ''}>${k} dia${k > 1 ? 's' : ''} antes</option>`).join('')}</select></div>
    <div class="stack">
      <button class="btn primary" data-act="save-carfix">Guardar</button>
      ${c ? '<button class="btn danger" data-act="del-carfix">Eliminar</button>' : ''}
    </div>`);
}
function shopRemSheet(r) {
  const P = current(), s = r || { type: 'oil', everyKm: 15000, everyMonths: 12 };
  ui.editId = r?.id || null; ui.remType = s.type;
  ui.sheetVeh = (s.veh && P.vehicles.some(x => x.id === s.veh)) ? s.veh : ((P.vehicles.find(x => x.id === ui.fuelVeh) || P.vehicles[0])?.id || '');
  openSheet(`
    <h2>${r ? 'Editar lembrete' : 'Novo lembrete'}</h2>
    ${P.vehicles.length > 1 ? `<div class="field"><label>Veículo</label><div class="chips">${P.vehicles.map(x =>
      `<button type="button" class="chip ${x.id === ui.sheetVeh ? 'on' : ''}" data-act="rveh" data-v="${x.id}" style="--c:var(--accent)">${ico(vehTypeOf(x.type).icon)} ${esc(x.name)}</button>`).join('')}</div></div>` : ''}
    <div class="field"><label>O quê</label><div class="chips">${SHOP_TYPES.filter(tp => tp.km || tp.months).map(tp =>
      `<button type="button" class="chip ${s.type === tp.id ? 'on' : ''}" data-act="rem-type" data-v="${tp.id}" style="--c:${tp.color}">${ico(tp.icon)} ${tp.name}</button>`).join('')}</div></div>
    <div class="row2">
      <div class="field"><label>A cada (km)</label><input class="input" id="r-km" inputmode="numeric" placeholder="Ex.: 15000" value="${s.everyKm > 0 ? s.everyKm : ''}"></div>
      <div class="field"><label>A cada (meses)</label><input class="input" id="r-mo" inputmode="numeric" placeholder="Ex.: 12" value="${s.everyMonths > 0 ? s.everyMonths : ''}"></div>
    </div>
    <span class="hint" style="display:block;margin:-6px 0 16px">Preenche um dos dois, ou os dois: avisa pelo que chegar primeiro. Conta a partir do último registo deste tipo nas Outras despesas. Sem km? Usa só os meses, ou indica no veículo quantos km fazes por ano e a app estima.</span>
    <div class="stack">
      <button class="btn primary" data-act="save-shoprem">Guardar</button>
      ${r ? '<button class="btn danger" data-act="del-shoprem">Eliminar</button>' : ''}
    </div>`);
}
function carHelpSheet() {                                       // mini guia do separador Automóvel
  openSheet(`
    <h2>Como funciona</h2>
    <div class="help-sec"><b>Combustível</b><p>Regista cada abastecimento com o valor e os litros. A app mostra o preço por litro e a tendência e, se juntares os km, o consumo médio e o custo por km.</p></div>
    <div class="help-sec"><b>Outras despesas</b><p>Revisão, pneus, inspeção, portagens… cada uma com valor e data. O <b>seguro</b> e o <b>IUC</b> ficam em <b>Pagamentos fixos</b>: indicas o valor e de quanto em quanto tempo pagas (mensal, trimestral, semestral ou anual) e entram sozinhos no calendário. Podes criar <b>lembretes</b> (por exemplo, óleo a cada 15 000 km ou 12 meses) e a app avisa quando falta pouco.</p></div>
    <div class="help-sec"><b>E os quilómetros?</b><p>Servem para o consumo, para os lembretes por km e para o custo real por km. <b>Nunca são obrigatórios.</b> Se não os souberes, a app estima-os pela tua média por dia (aparecem com ≈) e corrige quando puseres um valor real. Também podes indicar, no veículo, mais ou menos quantos km fazes por ano.</p></div>
    <div class="help-sec"><b>Prefiro uma coisa mais simples</b><p>Podes ignorar tudo isto e usar só os <b>Gastos do dia a dia</b>: escolhes a categoria Combustível ou Transportes e registas apenas o valor. Os totais e o calendário contam na mesma.</p></div>
    <div class="stack"><button class="btn primary" data-act="close-btn">Percebi</button></div>`);
}
function moreNavSheet() {                                     // o botão "Mais" da barra de baixo: os módulos que não cabem na barra
  const P = current(), mods = MODULES.filter(m => m.ready && P.modules.includes(m.id)), hidden = mods.length > 3 ? mods.slice(2) : [], ic = navIcons();
  openSheet(`<h2>Mais</h2><div class="more-grid">${hidden.map(m => `<button class="more-tile${ui.tab === m.id ? ' on' : ''}" data-act="more-go" data-id="${m.id}">${ic[m.id]}<span>${m.short}</span></button>`).join('')}</div>`);
}

/* Combustível (dentro do Carro): análise, abastecimentos detalhados e registos simples por completar */
function fuelBody(p) {
  const t = today0(), pre = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-`;
  const fuels = p.spends.filter(s => s.cat === 'fuel');
  const monthTotal = fuels.filter(s => s.date.startsWith(pre) && s.date <= ymd(t)).reduce((a, s) => a + s.amount, 0);
  const v = p.vehicles.find(x => x.id === ui.fuelVeh) || p.vehicles[0];             // veículo escolhido
  if (v) ui.fuelVeh = v.id;
  const detailed = fuels.filter(s => s.liters > 0 && v && s.veh === v.id).sort((a, b) => b.date.localeCompare(a.date) || (b.km || 0) - (a.km || 0));
  const pending = fuels.filter(s => !(s.liters > 0)).sort((a, b) => b.date.localeCompare(a.date));
  const lim = ui.fuelLimit;
  const fst = v ? fuelStats(p, v.id) : null, upToday = ymd(t), yearFuel = fuels.filter(x => x.date.startsWith(`${t.getFullYear()}-`) && x.date <= upToday).reduce((a, x) => a + x.amount, 0);
  const vehChips = p.vehicles.length > 1 ? `<div class="chips" style="margin-bottom:16px">${p.vehicles.map(x =>
    `<button class="chip ${v && x.id === v.id ? 'on' : ''}" data-act="fuel-veh" data-v="${x.id}" style="--c:var(--accent)">${ico(vehTypeOf(x.type).icon)} ${esc(x.name)}</button>`).join('')}</div>` : '';
  const vehCard = `<div class="card"><div class="card-h"><h3>Veículos</h3><button class="linkbtn accent" data-act="add-vehicle">${ico('plus')} Adicionar</button></div>
    ${p.vehicles.length ? p.vehicles.map(x => { const n = fuels.filter(s => s.veh === x.id).length;
      return `<button class="item" data-act="edit-vehicle" data-id="${x.id}"><div class="ic" style="background:#f59e0b">${ico(vehTypeOf(x.type).icon)}</div>
        <div class="grow"><b>${esc(x.name)}</b><span>${vehTypeOf(x.type).name} · ${n} abastecimento${n === 1 ? '' : 's'}</span></div></button>`; }).join('')
      : '<p class="muted small">Ainda não tens veículos. Ao registares o primeiro abastecimento, a app cria o teu primeiro veículo; podes mudar-lhe o nome aqui.</p>'}
  </div>`;
  const row = s => {
    const d = parseYmd(s.date);
    const extra = `${d.getDate()} ${MESES[d.getMonth()].slice(0, 3)}${s.km ? ' · ' + nf(s.km, 0) + ' km' : ''}`;
    return entryHTML({ kind: 'spend', id: s.id, name: s.note || 'Abastecimento', amount: s.amount, cat: 'fuel', spend: s }, extra)
      .replace('data-act="edit-spend"', 'data-act="edit-fuel"');            // aqui abre sempre o formulário detalhado
  };
  const more = detailed.length > lim ? `<button class="more" data-act="more-fuel">Ver mais (${detailed.length - lim})</button>` : '';
  return `<div class="big-total" style="margin-top:16px">
      <span>Gasto em ${MESES[t.getMonth()]}</span><b>${cost(monthTotal)}</b>
      ${btStats([[cost(yearFuel), 'este ano'], fst ? [nf(fst.last.v, 3) + ' €', 'último preço/L'] : null, [fuels.length, fuels.length === 1 ? 'abastecimento' : 'abastecimentos']])}
    </div>
    ${vehChips}
    ${fuelCard(p, v) || `<div class="card"><div class="empty-state"><div class="emoji">${ico('fuel')}</div>Ainda sem abastecimentos com detalhe.<br>Toca em <b>+</b> e regista os litros para veres o preço por litro; com os km, vês também o consumo.</div></div>`}
    ${detailed.length ? `<div class="card"><div class="card-h"><h3>Abastecimentos</h3></div>${detailed.slice(0, lim).map(row).join('')}${more}</div>` : ''}
    ${pending.length ? `<div class="card"><div class="card-h"><h3>Por completar</h3><span class="muted small">${pending.length}</span></div>
      <p class="hint" style="margin:-6px 0 6px">Registos só com o valor (feitos nos Gastos do dia a dia). Toca para juntar os litros (e, se quiseres, os km).</p>
      ${pending.slice(0, 10).map(row).join('')}</div>` : ''}
    ${vehCard}`;
}

/* ── Vícios: hábitos criados pelo utilizador ──
 * Cada hábito regista-se por UNIDADE (+1, com preço) ou por VALOR (€ por ocasião, com ganhos opcionais).
 * Guardamos um registo por hábito e por dia (p.hlog["idHábito:AAAA-MM-DD"] = {n, spent, won}),
 * para a app continuar rápida ao fim de anos (20 cigarros/dia não geram 20 registos). */
const HABIT_TPLS = [
  { id: 'tabaco', name: 'Tabaco',         icon: 'cig', kind: 'unit',  wins: false, color: '#ef4444' },
  // café e álcool têm "tipos" (cada um com o seu preço; no álcool também as unidades de álcool, UA). Os valores são só ponto de partida: ajusta aos teus.
  { id: 'cafe',   name: 'Café',           icon: 'coffee', kind: 'unit',  wins: false, color: '#f59e0b',
    types: [{ name: 'Bica', price: 0.8, ua: 0 }, { name: 'Galão', price: 1.2, ua: 0 }, { name: 'Cappuccino', price: 1.8, ua: 0 }, { name: 'Em casa', price: 0.2, ua: 0 }] },
  { id: 'alcool', name: 'Álcool',         icon: 'glass',  kind: 'unit',  wins: false, color: '#8b5cf6',
    types: [{ name: 'Cerveja', price: 1.5, ua: 1.3 }, { name: 'Vinho (copo)', price: 2, ua: 1.4 }, { name: 'Shot', price: 2, ua: 1 }, { name: 'Cocktail', price: 6, ua: 1.5 }] },
  { id: 'casino', name: 'Casino',         icon: 'dice',   kind: 'value', wins: true,  color: '#06b6d4' },   // apostas: ganhos, saldo, limite e pausa
  { id: 'jogos',  name: 'Jogos',          icon: 'gamepad', kind: 'games', wins: false, color: '#10b981' },  // compras de videojogos, com reembolsos
  { id: 'outro',  name: '',               icon: 'other',  kind: 'unit',  wins: false, color: '#8b93a3' },
];
const hkey = (hid, date) => `${hid}:${date}`;
const tplOf = id => HABIT_TPLS.find(t => t.id === id) || HABIT_TPLS[HABIT_TPLS.length - 1];
const freshTypes = id => (tplOf(id).types || []).map(t => ({ ...t, id: uid() }));      // cópia dos tipos do modelo, com ids novos
const parseExpr = v => {                                    // aceita "0,275" ou "5,50/20" (maço de 20)
  const parts = String(v).replace(/,/g, '.').split('/'), a = parseFloat(parts[0]);
  if (parts.length === 2) { const b = parseFloat(parts[1]); return b > 0 ? a / b : NaN; }
  return a;
};

function habitRecs(p, h) {
  const pre = h.id + ':', out = [];
  for (const k in p.hlog) if (k.startsWith(pre)) { const r = p.hlog[k]; out.push({ key: k, date: k.slice(pre.length), n: r.n || 0, spent: r.spent || 0, won: r.won || 0, ua: r.ua || 0, by: r.by || {}, hr: r.hr || {} }); }
  return out;
}

function habitStats(p, h) {
  const recs = habitRecs(p, h), t = today0();
  const sum = (a, b) => { const list = recs.filter(r => r.date >= a && r.date <= b); return { n: list.reduce((x, r) => x + r.n, 0), spent: list.reduce((x, r) => x + r.spent, 0), won: list.reduce((x, r) => x + r.won, 0), ua: list.reduce((x, r) => x + r.ua, 0) }; };
  const R = k => periodRange(k).map(ymd);
  const day = sum(...R('day')), week = sum(...R('week')), month = sum(...R('month')), year = sum(...R('year'));
  const created = ymd(new Date(h.created)), todayStr = ymd(t);
  // projeção anual: média dos últimos 30 dias (ou desde que começaste), só com pelo menos 7 dias de histórico
  const span = Math.min(30, Math.round((t - parseYmd(created)) / DAY) + 1);
  const from = ymd(new Date(t.getFullYear(), t.getMonth(), t.getDate() - span + 1));
  const seg = sum(from, todayStr), base = h.tpl === 'casino' ? Math.max(0, seg.spent - seg.won) : seg.spent;   // casino: perda líquida
  const proj = span >= 7 ? base / span * 365 : null;
  // dias sem registo: desde o último dia com consumo (ou desde que criaste o hábito)
  const last = recs.filter(r => r.n > 0 || r.spent > 0).map(r => r.date).sort().pop();
  const daysFree = Math.max(0, Math.round((t - parseYmd(last || created)) / DAY));
  return { day, week, month, year, proj, daysFree, recent: recs.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5) };
}

function genericCard(p, h) {
  const st = habitStats(p, h), unit = h.kind === 'unit';
  const today = unit
    ? `<div><b class="h-big">${st.day.n}</b> <span class="muted small">hoje</span><div class="muted small">${cost(st.day.spent)}</div></div>
       <div class="h-btns"><button class="h-minus" data-act="habit-minus" data-id="${h.id}" aria-label="Menos um" ${st.day.n ? '' : 'disabled'}>${ico('minus')}</button>
       <button class="h-plus" data-act="habit-plus" data-id="${h.id}" aria-label="Mais um">${ico('plus')}</button></div>`
    : `<div><b class="h-big neg">${cost(st.day.spent)}</b> <span class="muted small">hoje</span>${h.wins ? `<div class="muted small">ganho: ${nf(st.day.won)} €</div>` : ''}</div>
       <button class="h-add" data-act="habit-add" data-id="${h.id}">${ico('plus')} Registar</button>`;
  const cell = (label, s) => `<div><span>${label}</span><b>${cost(s.spent)}</b>${unit ? `<em>${s.n} un.</em>` : ''}</div>`;
  const net = st.month.won - st.month.spent;
  const rows = [
    st.proj !== null ? `<div class="h-row"><span>Projeção anual</span><b>${cost(st.proj)}</b></div>` : `<div class="h-row"><span>Projeção anual</span><em class="muted small">precisa de 7 dias de registos</em></div>`,
    `<div class="h-row"><span>Dias sem registo</span><b>${st.daysFree}</b></div>`,
    h.wins ? `<div class="h-row"><span>Saldo do mês (ganho − gasto)</span><b class="${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : '−'}${nf(Math.abs(net))} €</b></div>` : '',
  ].join('');
  const recent = st.recent.length ? `<div class="h-recent"><span class="muted small">Últimos registos</span>${st.recent.map(r => {
    const d = parseYmd(r.date);
    return `<button class="h-rec" data-act="edit-hday" data-id="${r.key}"><span>${d.getDate()} ${MESES[d.getMonth()].slice(0, 3)}</span><span>${unit ? r.n + ' un.' : ''}${r.won > 0 ? ' · ganho ' + nf(r.won) + ' €' : ''}</span><b>${cost(r.spent)}</b></button>`;
  }).join('')}</div>` : '';
  return `<div class="card habit" id="hcard-${h.id}">
    <button class="h-head" data-act="edit-habit" data-id="${h.id}">
      <span class="ic" style="background:${h.color}">${ico(h.icon)}</span>
      <span class="grow"><b>${esc(h.name)}</b>${h.show ? '' : '<span class="tag">só aqui</span>'}</span>
      <span class="edit-tag">${ico('edit')} Editar</span>
    </button>
    <div class="h-today">${today}</div>
    <div class="h-stats">${cell('Semana', st.week)}${cell('Mês', st.month)}${cell('Ano', st.year)}</div>
    ${rows}${recent}
  </div>`;
}

/* ── Cartões por modelo: cada vício mostra o que mais interessa nele ── */
const habitHead = h => `<button class="h-head" data-act="edit-habit" data-id="${h.id}">
    <span class="ic" style="background:${h.color}">${ico(h.icon)}</span>
    <span class="grow"><b>${esc(h.name)}</b>${h.show ? '' : '<span class="tag">só aqui</span>'}</span>
    <span class="edit-tag">${ico('edit')} Editar</span></button>`;
const periodCells = (st, withUnits) => ['week', 'month', 'year'].map((k, i) =>
  `<div><span>${['Semana', 'Mês', 'Ano'][i]}</span><b>${cost(st[k].spent)}</b>${withUnits ? `<em>${st[k].n} un.</em>` : ''}</div>`).join('');
const signed = n => `${n >= 0 ? '+' : '−'}${nf(Math.abs(n))} €`;
const pickRow = (label, val) => `<div class="h-row"><span>${label}</span><b>${val}</b></div>`;
const dateShort = s => { const d = parseYmd(s); return `${d.getDate()} ${MESES[d.getMonth()].slice(0, 3)}`; };
function sinceText(iso) {                                   // "há 2 h 15 min"
  const min = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 1) return 'agora mesmo';
  if (min < 60) return `há ${min} min`;
  if (min < 1440) return `há ${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
  const d = Math.floor(min / 1440); return `há ${d} dia${d === 1 ? '' : 's'}`;
}
const recentHTML = (st, unit, wonLabel = 'ganho') => st.recent.length ? `<div class="h-recent"><span class="muted small">Últimos registos</span>${st.recent.map(r => {
  const parts = [unit ? r.n + ' un.' : '', r.won > 0 ? `${wonLabel} ${nf(r.won)} €` : ''].filter(Boolean).join(' · ');
  return `<button class="h-rec" data-act="edit-hday" data-id="${r.key}"><span>${dateShort(r.date)}</span><span>${parts}</span><b>${r.spent > 0 ? cost(r.spent) : ''}</b></button>`;
}).join('')}</div>` : '';

const nOnDay = (p, h, date) => p.hlog[hkey(h.id, date)]?.n || 0;
const daysAgo = i => { const t = today0(); return ymd(new Date(t.getFullYear(), t.getMonth(), t.getDate() - i)); };

/* TABACO: +1 por cigarro, meta diária, tempo desde o último, maços e poupança. */
function tabacoCard(p, h) {
  const st = habitStats(p, h), t = today0(), price = h.price || 0, pack = h.pack?.size || 0;
  const created = parseYmd(ymd(new Date(h.created)));
  const daysSince = Math.round((t - created) / DAY) + 1;                // o dia de criação conta como 1
  const span7 = Math.min(7, daysSince);
  let n7 = 0; for (let i = 0; i < span7; i++) n7 += nOnDay(p, h, daysAgo(i));
  const goalBar = h.goal > 0 ? `<div class="h-goal"><div class="h-goal-top"><span>Meta de hoje</span><b>${st.day.n} / ${h.goal}</b></div>
      <div class="h-bar"><i class="${st.day.n > h.goal ? 'over' : ''}" style="width:${Math.min(100, st.day.n / h.goal * 100)}%"></i></div></div>` : '';
  // poupança em relação ao que fumavas por dia antes
  let saveBlock = '';
  if (h.baseline > 0 && price > 0) {
    let saved = 0;
    for (let i = 0; i < daysSince; i++) saved += (h.baseline - nOnDay(p, h, ymd(new Date(created.getFullYear(), created.getMonth(), created.getDate() + i)))) * price;
    const span30 = Math.min(30, daysSince); let n30 = 0; for (let i = 0; i < span30; i++) n30 += nOnDay(p, h, daysAgo(i));
    const yearSave = span30 >= 7 ? (h.baseline - n30 / span30) * price * 365 : null;
    saveBlock = `<div class="h-save"><span class="muted small">Poupança (face a ${h.baseline} por dia)</span>
      ${pickRow('Poupado até agora', saved > 0 ? `<span class="pos">${signed(saved)}</span>` : '<span class="muted">ainda sem poupança</span>')}
      ${pickRow('Ao ritmo atual, por ano', yearSave === null ? '<span class="muted small">precisa de 7 dias</span>' : yearSave > 0 ? `<span class="pos">${signed(yearSave)}</span>` : '<span class="muted">—</span>')}</div>`;
  } else if (!h.baseline) {
    saveBlock = '<p class="hint" style="margin-top:10px">Em Editar, diz quantos fumavas por dia antes para ver quanto poupas.</p>';
  }
  return `<div class="card habit" id="hcard-${h.id}">
    ${habitHead(h)}
    <div class="h-today"><div><b class="h-big">${st.day.n}</b> <span class="muted small">hoje</span><div class="muted small">${cost(st.day.spent)}</div></div>
      <div class="h-btns"><button class="h-minus" data-act="habit-minus" data-id="${h.id}" aria-label="Menos um" ${st.day.n ? '' : 'disabled'}>${ico('minus')}</button>
      <button class="h-plus" data-act="habit-plus" data-id="${h.id}" aria-label="Mais um">${ico('plus')}</button></div></div>
    ${goalBar}
    <div class="h-stats">${periodCells(st, true)}</div>
    ${h.lastAt ? pickRow('Último cigarro', `<span data-since="${h.lastAt}">${sinceText(h.lastAt)}</span>`) : ''}
    ${pickRow('Média (7 dias)', `${nf(n7 / span7, 1)} por dia`)}
    ${pack > 0 ? pickRow('Maços este mês', nf(st.month.n / pack, 1)) : ''}
    ${st.proj !== null ? pickRow('Projeção anual', cost(st.proj)) : pickRow('Projeção anual', '<span class="muted small">precisa de 7 dias</span>')}
    ${pickRow('Dias sem registo', st.daysFree)}
    ${saveBlock}${recentHTML(st, true)}
  </div>`;
}

/* CASINO: depósitos (gasto, não voltam) e ganhos (contam logo). O que se faz com o ganho fica a cargo de quem usa.
 * Dados: spent = depósitos, won = ganhos. Resultado = ganhos − depósitos. */
function casinoCard(p, h) {
  const st = habitStats(p, h), todayStr = ymd(today0());
  const recs = habitRecs(p, h), total = recs.reduce((a, r) => a + r.won - r.spent, 0);
  const net = st.month.won - st.month.spent, netYear = st.year.won - st.year.spent;
  const paused = h.pausedUntil && h.pausedUntil >= todayStr;
  const ratio = h.limit > 0 ? st.month.spent / h.limit : 0;
  const limitBar = h.limit > 0 ? `<div class="h-goal"><div class="h-goal-top"><span>Limite de depósitos deste mês</span><b>${nf(st.month.spent)} / ${nf(h.limit)} €</b></div>
      <div class="h-bar"><i class="${ratio > 1 ? 'over' : ratio >= 0.8 ? 'warn' : ''}" style="width:${Math.min(100, ratio * 100)}%"></i></div>
      ${ratio >= 1 ? '<div class="h-note over">Passaste o limite que definiste.</div>' : ratio >= 0.8 ? '<div class="h-note warn">Já usaste mais de 80 % do limite.</div>' : ''}</div>` : '';
  const pauseBanner = paused ? `<div class="h-pause">${ico('pause')}<span>Em pausa até <b>${dateShort(h.pausedUntil)}</b>. Boa decisão.</span></div>` : '';
  return `<div class="card habit" id="hcard-${h.id}">
    ${habitHead(h)}${pauseBanner}
    <div class="h-today"><div><span class="muted small">Resultado deste mês (ganhos − depósitos)</span><div><b class="h-big ${net >= 0 ? 'pos' : 'neg'}">${signed(net)}</b></div>
        <div class="muted small">Ano ${signed(netYear)} · Total ${signed(total)}</div></div></div>
    <div class="h-actions">
      <button class="h-add" data-act="casino-dep" data-id="${h.id}">${ico('plus')} Depósito</button>
      <button class="h-add alt" data-act="casino-gain" data-id="${h.id}">${ico('arrowUp')} Ganho</button>
    </div>
    ${limitBar}
    <div class="h-stats">${periodCells(st, false)}</div>
    <span class="muted small" style="display:block;text-align:center;margin:-8px 0 12px">Depositado (semana, mês e ano)</span>
    ${pickRow('Ganho este mês', st.month.won > 0 ? `<span class="pos">${signed(st.month.won)}</span>` : '—')}
    ${pickRow('Depositado este mês', st.month.spent > 0 ? `<span class="neg">${cost(st.month.spent)}</span>` : '—')}
    ${pickRow('Nº de depósitos este mês', st.month.n)}
    ${pickRow('Dias sem depósitos', st.daysFree)}
    ${recentHTML(st, false, 'ganho')}
  </div>`;
}

/* JOGOS: compras de videojogos, uma a uma; os reembolsos descontam ao gasto. */
function gameItems(p, h) {
  const out = [];
  for (const r of habitRecs(p, h)) for (const it of (p.hlog[r.key].items || [])) out.push({ ...it, date: r.date, key: r.key });
  return out.sort((a, b) => b.date.localeCompare(a.date));
}
function jogosCard(p, h) {
  const t = today0(), todayStr = ymd(t), items = gameItems(p, h);
  const sumNet = (a, b) => items.filter(i => i.date >= a && i.date <= b).reduce((x, i) => x + i.price - (i.refund || 0), 0);
  const R = k => periodRange(k).map(ymd), cnt = (a, b) => items.filter(i => i.date >= a && i.date <= b).length;
  const [mA, mB] = R('month'), [yA, yB] = R('year'), [wA, wB] = R('week');
  const monthNet = sumNet(mA, mB), yearNet = sumNet(yA, yB), yearN = cnt(yA, yB);
  const refunds = items.filter(i => i.date >= yA).reduce((x, i) => x + (i.refund || 0), 0);
  const rows = items.slice(0, 10).map(i => `<button class="h-rec h-game" data-act="edit-game" data-id="${i.key}|${i.id}">
      <span>${dateShort(i.date)}</span><span class="n">${esc(i.name)}${i.refund > 0 ? ` <em class="tag">${i.refund >= i.price ? 'reembolsado' : 'reembolso parcial'}</em>` : ''}</span>
      <b>${cost(i.price - (i.refund || 0))}</b></button>`).join('');
  return `<div class="card habit" id="hcard-${h.id}">
    ${habitHead(h)}
    <div class="h-today"><div><span class="muted small">Gasto este mês (já sem reembolsos)</span><div><b class="h-big neg">${cost(monthNet)}</b></div>
        <div class="muted small">${cnt(mA, mB)} jogo${cnt(mA, mB) === 1 ? '' : 's'} este mês</div></div>
      <button class="h-add" data-act="add-game" data-id="${h.id}">${ico('plus')} Compra</button></div>
    <div class="h-stats">${[['Semana', sumNet(wA, wB)], ['Mês', monthNet], ['Ano', yearNet]].map(([l, v]) => `<div><span>${l}</span><b>${cost(v)}</b></div>`).join('')}</div>
    ${pickRow('Média por jogo (este ano)', yearN ? cost(yearNet / yearN) : '—')}
    ${pickRow('Reembolsado (este ano)', refunds > 0 ? `<span class="pos">${nf(refunds)} €</span>` : '—')}
    ${items.length ? `<div class="h-recent"><span class="muted small">Compras recentes</span>${rows}</div>` : '<p class="hint" style="margin-top:10px">Toca em "Compra" sempre que comprares um jogo.</p>'}
  </div>`;
}

/* CAFÉ e ÁLCOOL: um toque por tipo (cada um com o seu preço). O café guarda a hora; o álcool as unidades (UA). */
function typeButtons(h) {
  const al = h.tpl === 'alcool';
  return `<div class="h-types">${h.types.map(t => `<button class="h-type" data-act="habit-type" data-id="${h.id}" data-t="${t.id}">
      <b>${esc(t.name)}</b><span>${nf(t.price)} €${al && t.ua > 0 ? ' · ' + nf(t.ua, 1) + ' UA' : ''}</span></button>`).join('')}</div>
    <div class="h-links"><button data-act="habit-undo" data-id="${h.id}" ${canUndo(h) ? '' : 'disabled'}>Desfazer o último</button></div>`;
}
const canUndo = h => { const r = h.lastAdd && current().hlog[h.lastAdd.k]; return !!(r && r.n > 0 && r.by?.[h.lastAdd.t] > 0); };

function cafeCard(p, h) {
  const st = habitStats(p, h), t = today0(), recs = habitRecs(p, h);
  const daysSince = Math.round((t - parseYmd(ymd(new Date(h.created)))) / DAY) + 1, span7 = Math.min(7, daysSince);
  let n7 = 0; for (let i = 0; i < span7; i++) n7 += nOnDay(p, h, daysAgo(i));
  const [ma, mb] = periodRange('month').map(ymd), cnt = {};
  recs.filter(r => r.date >= ma && r.date <= mb).forEach(r => { for (const id in r.by) cnt[id] = (cnt[id] || 0) + r.by[id]; });
  const topId = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
  const topName = topId ? (h.types.find(x => x.id === topId)?.name || 'Outros') : null;
  const from30 = daysAgo(29), hrs = { m: 0, t: 0, n: 0 };                               // a que horas tomas (últimos 30 dias)
  recs.filter(r => r.date >= from30).forEach(r => { for (const b in r.hr) hrs[b] = (hrs[b] || 0) + r.hr[b]; });
  const totH = hrs.m + hrs.t + hrs.n;
  const bars = totH ? `<div class="h-hours">${[['m', 'Manhã'], ['t', 'Tarde'], ['n', 'Noite']].map(([b, l]) =>
    `<div class="hb"><div class="bar"><i style="height:${Math.max(4, Math.round(hrs[b] / totH * 100))}%"></i></div><span>${l}</span><em>${Math.round(hrs[b] / totH * 100)} %</em></div>`).join('')}</div>` : '';
  return `<div class="card habit" id="hcard-${h.id}">
    ${habitHead(h)}
    <div class="h-today"><div><b class="h-big">${st.day.n}</b> <span class="muted small">hoje</span><div class="muted small">${cost(st.day.spent)}</div></div></div>
    ${typeButtons(h)}
    <div class="h-stats">${periodCells(st, true)}</div>
    ${pickRow('Média (7 dias)', `${nf(n7 / span7, 1)} por dia`)}
    ${pickRow('Custo médio por café (mês)', st.month.n ? cost(st.month.spent / st.month.n) : '—')}
    ${topName ? pickRow('Mais pedido este mês', esc(topName)) : ''}
    ${totH ? `<div class="h-row" style="display:block"><span>A que horas tomas <em class="muted small">(últimos 30 dias)</em></span>${bars}</div>` : ''}
    ${st.proj !== null ? pickRow('Projeção anual', cost(st.proj)) : pickRow('Projeção anual', '<span class="muted small">precisa de 7 dias</span>')}
    ${recentHTML(st, true)}
  </div>`;
}

function alcoolCard(p, h) {
  const st = habitStats(p, h);
  const goalBar = h.goalWeek > 0 ? `<div class="h-goal"><div class="h-goal-top"><span>Meta da semana</span><b>${nf(st.week.ua, 1)} / ${nf(h.goalWeek, 1)} UA</b></div>
      <div class="h-bar"><i class="${st.week.ua > h.goalWeek ? 'over' : ''}" style="width:${Math.min(100, st.week.ua / h.goalWeek * 100)}%"></i></div></div>` : '';
  return `<div class="card habit" id="hcard-${h.id}">
    ${habitHead(h)}
    <div class="h-free"><b>${st.daysFree}</b><span>dia${st.daysFree === 1 ? '' : 's'} sem álcool</span></div>
    <div class="h-today"><div><b class="h-big">${st.day.n}</b> <span class="muted small">hoje</span><div class="muted small">${nf(st.day.ua, 1)} UA · ${cost(st.day.spent)}</div></div></div>
    ${typeButtons(h)}
    ${goalBar}
    <div class="h-stats">${periodCells(st, true)}</div>
    ${pickRow('Unidades esta semana', `${nf(st.week.ua, 1)} UA`)}
    ${pickRow('Unidades este mês', `${nf(st.month.ua, 1)} UA`)}
    ${st.proj !== null ? pickRow('Projeção anual', cost(st.proj)) : pickRow('Projeção anual', '<span class="muted small">precisa de 7 dias</span>')}
    <p class="hint" style="margin-top:8px">UA = unidades de álcool (valores aproximados que podes ajustar em Editar).</p>
    ${recentHTML(st, true)}
  </div>`;
}

function habitCardHTML(p, h) {
  const typed = h.types?.length;                       // hábitos antigos de café/álcool sem tipos continuam no modelo genérico
  return (h.tpl === 'tabaco' ? tabacoCard : h.tpl === 'casino' ? casinoCard : h.kind === 'games' ? jogosCard
    : h.tpl === 'cafe' && typed ? cafeCard : h.tpl === 'alcool' && typed ? alcoolCard : genericCard)(p, h);
}

/* ── Médias ──  Nada é guardado: tudo se calcula na hora a partir dos registos.
   A média de uma unidade (dia, semana, mês, ano) é o gasto médio dos períodos COMPLETOS já passados, desde o primeiro registo
   (o período em que começaste, que ficou a meio, não conta); os períodos sem gastos contam como zero.
   O período atual ainda vai a meio, por isso compara-se com a média na mesma proporção (a meio do mês, com metade da média do mês). */
const AVG_UNITS = { day: ['dia', 'dias', 'por dia'], week: ['semana', 'semanas', 'por semana'], month: ['mês', 'meses', 'por mês'], year: ['ano', 'anos', 'por ano'] };
function periodOf(unit, d) {                                         // [início, fim] do período (dia, semana de segunda a domingo, mês, ano) que contém d
  const y = d.getFullYear(), m = d.getMonth();
  if (unit === 'day') return [new Date(y, m, d.getDate()), new Date(y, m, d.getDate())];
  if (unit === 'week') { const k = (d.getDay() + 6) % 7; return [new Date(y, m, d.getDate() - k), new Date(y, m, d.getDate() - k + 6)]; }
  if (unit === 'month') return [new Date(y, m, 1), new Date(y, m + 1, 0)];
  return [new Date(y, 0, 1), new Date(y, 11, 31)];
}
const nextPeriod = (unit, end) => new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);      // o período seguinte começa no dia depois do fim
const sumDays = (map, a, b) => { let t = 0; for (const d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) t += map[ymd(d)] || 0; return t; };
function spendSource(p) {                                            // os gastos do Dia-a-dia: gasto por dia
  const days = {}; let first = null;
  for (const s of p.spends) { days[s.date] = (days[s.date] || 0) + s.amount; if (!first || s.date < first) first = s.date; }
  return { first: first && parseYmd(first), valueIn: (a, b) => sumDays(days, a, b) };
}
function viceSource(p) {                                             // os vícios, com as mesmas regras do cartão: jogos sem reembolsos; o casino conta pelo saldo do período
  const nc = {}, cn = {}; let first = null;
  for (const h of p.habits) {
    const cas = h.tpl === 'casino' && h.kind !== 'games';
    for (const r of habitRecs(p, h)) {
      if (!first || r.date < first) first = r.date;
      if (cas) { const m = cn[h.id] ||= {}; m[r.date] = (m[r.date] || 0) + (r.won - r.spent); }
      else nc[r.date] = (nc[r.date] || 0) + (h.kind === 'games' ? Math.max(0, r.spent - r.won) : r.spent);
    }
  }
  return { first: first && parseYmd(first), valueIn: (a, b) => sumDays(nc, a, b) + Object.values(cn).reduce((t, m) => t + Math.max(0, -sumDays(m, a, b)), 0) };
}
function avgInfo(src, unit) {
  const t = today0(), [s0, e0] = periodOf(unit, t), cur = src.valueIn(s0, t);
  let n = 0, tot = 0;
  if (src.first) {
    let st = periodOf(unit, src.first)[0]; if (st < src.first) st = nextPeriod(unit, periodOf(unit, st)[1]);       // salta o período em que começaste
    for (;; st = nextPeriod(unit, periodOf(unit, st)[1])) { const e = periodOf(unit, st)[1]; if (e >= t) break; tot += src.valueIn(st, e); n++; }
  }
  const frac = unit === 'day' ? 1 : (Math.round((t - s0) / DAY) + 1) / (Math.round((e0 - s0) / DAY) + 1);       // a parte do período que já passou
  const avg = n ? tot / n : null, exp = avg === null ? null : avg * frac, diff = exp === null ? null : cur - exp;
  return { cur, avg, n, exp, diff: diff !== null && Math.abs(diff) < .005 ? 0 : diff, proj: cur / frac };
}
const avgDiff = d => `<span class="${d > 0 ? 'up' : 'dn'}">${d > 0 ? '+' : '−'}${nf(Math.abs(d))} €</span>`;
const avgBase = (n, unit) => n > 0 && n < 3 ? `<span class="bt-note">com base em ${n} ${AVG_UNITS[unit][n === 1 ? 0 : 1]}</span>` : '';       // histórico curto: avisa em quantos períodos se baseia
function avgStats(ai, unit) {                                  // os dois primeiros pontos dos cartões: a média e a diferença para ela
  const un = AVG_UNITS[unit][2];
  if (ai.avg === null) return [['—', 'média ' + un], unit === 'year' && ai.cur > 0 ? [eq(ai.proj), 'projeção do ano'] : ['—', 'sem histórico']];
  return [[eq(ai.avg), 'média ' + un], ai.diff === 0 ? ['na média', 'até agora'] : [avgDiff(ai.diff), ai.diff > 0 ? 'acima da média' : 'abaixo da média']];
}
/* Visão geral de todos os hábitos (como no Início): gasto por período e divisão por hábito.
 * Inclui também os hábitos escondidos do calendário, porque aqui é o espaço deles. */
function vSummaryHTML(p) {
  if (!p.habits.length) return '';
  const [a, b] = periodRange(ui.vperiod).map(ymd);
  const rows = p.habits.map(h => {
    let spent = 0, won = 0;
    for (const r of habitRecs(p, h)) if (r.date >= a && r.date <= b) {
      if (h.kind === 'games') spent += Math.max(0, r.spent - r.won);        // jogos: já sem reembolsos
      else { spent += r.spent; won += r.won; }
    }
    if (h.tpl === 'casino') { const net = won - spent; spent = Math.max(0, -net); won = Math.max(0, net); }   // casino: só conta o saldo do período
    return { h, spent, won };
  });
  const total = rows.reduce((x, r) => x + r.spent, 0), won = rows.reduce((x, r) => x + r.won, 0);
  const shown = rows.filter(r => r.spent > 0).sort((x, y) => y.spent - x.spent);
  const bar = shown.length ? `<div class="stackbar">${shown.map(r => `<i style="width:${r.spent / total * 100}%;background:${r.h.color}"></i>`).join('')}</div>` : '';
  const legend = shown.map(r => `<div class="lg"><i style="background:${r.h.color}"></i><span>${ico(r.h.icon)} ${esc(r.h.name)}</span><b>${cost(r.spent)}</b></div>`).join('');
  const label = PERIODS.find(x => x[0] === ui.vperiod)[2];
  const ai = avgInfo(viceSource(p), ui.vperiod), count = [shown.length, shown.length === 1 ? 'hábito com gastos' : 'hábitos com gastos'];
  return `<div class="big-total">
      <div class="seg four on-grad">${PERIODS.map(([k, l]) => `<button data-act="vperiod-sum" data-v="${k}" class="${ui.vperiod === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <span>Visão geral · gasto ${label}</span><b data-v="${total}">${cost(total)}</b>
      ${btStats([...avgStats(ai, ui.vperiod), count])}${avgBase(ai.n, ui.vperiod)}
    </div>
    <div class="card">
      ${bar}${legend || '<p class="muted small">Sem gastos neste período.</p>'}
      ${won > 0 ? `<div class="coming"><span>Ganhos (à parte dos gastos)</span><b class="pos">+${nf(won)} €</b></div>` : ''}
    </div>`;
}

function vHabits(p) {
  return `<section class="screen">
    <h1 class="page-title">Vícios</h1>
    ${p.habits.length ? `<div id="vsummary" style="margin-top:16px">${vSummaryHTML(p)}</div>` + p.habits.map(h => habitCardHTML(p, h)).join('')
      : `<div class="card" style="margin-top:16px"><div class="empty-state"><div class="emoji">${ico('vices')}</div>Ainda não acompanhas nenhum hábito.<br>Toca em <b>+</b> para criar o primeiro: tabaco, café, jogos…</div></div>`}
    <p class="hint">Sem julgamentos: Todos temos algum…</p>
  </section>`;
}

/* ── Casa: renda, luz, água… ── */
function billRow(p, b) {
  const bt = billTypeOf(b.type), i = billInfo(p, b);
  const trend = b.variable && i.last
    ? `<div class="bill-trend ${i.diff > 0 ? 'up' : i.diff < 0 ? 'dn' : ''}">Última fatura: ${nf(i.last.v)} €${i.diff !== null ? ` (${i.diff >= 0 ? '+' : '−'}${nf(Math.abs(i.diff))} € face à anterior)` : ''}</div>` : '';
  return `<button class="item" data-act="edit-bill" data-id="${b.id}">
    <div class="ic" style="background:${bt.color}">${ico(bt.icon)}</div>
    <div class="grow"><b>${esc(b.name)}</b><span>${freqText(b)}${b.variable ? ' · variável' : ''}</span>${everyOf(b) > 1 ? `<div class="bill-trend">${subStatus(b)}</div>` : ''}${trend}</div>
    <div class="amt neg">${cost(i.typical)}</div>
  </button>`;
}
function vHouse(p) {
  const infos = p.bills.map(b => ({ b, i: billInfo(p, b) }));
  const eqMonthly = infos.reduce((a, x) => a + x.i.monthly, 0);                          // média mensal de tudo (para a divisão por tipo)
  const sortedInfos = infos.slice().sort((a, c) => a.b.name.localeCompare(c.b.name));
  const monthlyInfos = sortedInfos.filter(x => everyOf(x.b) === 1), otherInfos = sortedInfos.filter(x => everyOf(x.b) > 1);
  const monthlyTotal = monthlyInfos.reduce((a, x) => a + x.i.typical, 0);                // o que sai todos os meses
  const othersYear = otherInfos.reduce((a, x) => a + x.i.typical * 12 / everyOf(x.b), 0); // trimestrais, anuais…: por ano
  const byType = {}; infos.forEach(x => byType[x.b.type] = (byType[x.b.type] || 0) + x.i.monthly);
  const rows = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  const bar = rows.length ? `<div class="stackbar">${rows.map(([t, v]) => `<i style="width:${v / eqMonthly * 100}%;background:${billTypeOf(t).color}"></i>`).join('')}</div>` : '';
  const legend = rows.map(([t, v]) => `<div class="lg"><i style="background:${billTypeOf(t).color}"></i><span>${ico(billTypeOf(t).icon)} ${billTypeOf(t).name}</span><b>${cost(v)}</b></div>`).join('');
  const nxt = p.bills.map(b => ({ b, d: nextCharge(b, afterToday()) })).sort((a, c) => a.d - c.d)[0];
  const pend = pendingInvoices(p).slice(0, 4);
  const pendCard = pend.length ? `<div class="card"><div class="card-h"><h3>Faturas por registar</h3><span class="muted small">${pend.length}</span></div>
      ${pend.map(x => { const bt = billTypeOf(x.b.type), mm = +x.ym.slice(5) - 1;
        return `<button class="item" data-act="invoice" data-id="${x.b.id}:${x.ym}"><div class="ic" style="background:${bt.color}">${ico(bt.icon)}</div>
          <div class="grow"><b>${esc(x.b.name)}</b><span>${MESES[mm]} · venceu a ${x.due.getDate()}</span></div><div class="amt muted">${nf(priceAt(x.b, x.ym))} € est.</div></button>`; }).join('')}
      <p class="hint" style="margin-top:6px">Toca para registar o valor real da fatura. Até lá conta a estimativa.</p></div>` : '';
  return `<section class="screen">
    <h1 class="page-title">Casa</h1>
    <div class="big-total" style="margin-top:16px">
      <span>Todos os meses</span><b>${cost(monthlyTotal)}</b>
      ${btStats([[eq(monthlyTotal * 12 + othersYear), 'por ano'], otherInfos.length ? [eq(othersYear), 'outras frequências'] : null, [p.bills.length, p.bills.length === 1 ? 'conta' : 'contas']])}
    </div>
    ${pendCard}
    ${p.bills.length ? '' : `<div class="card"><div class="empty-state"><div class="emoji">${ico('home')}</div>Ainda não tens contas de casa.<br>Toca em <b>+</b> para juntar a renda, a luz, a água…</div></div>`}
    ${monthlyInfos.length ? `<div class="card"><div class="card-h"><h3>Todos os meses</h3><span class="muted small">${monthlyInfos.length}</span></div>
      ${monthlyInfos.map(x => billRow(p, x.b)).join('')}
      <div class="total"><span>Gastos mensais</span><span class="neg">${cost(monthlyTotal)}</span></div></div>` : ''}
    ${otherInfos.length ? `<div class="card"><div class="card-h"><h3>Outras frequências</h3><span class="muted small">${otherInfos.length}</span></div>
      ${otherInfos.map(x => billRow(p, x.b)).join('')}
      <div class="total"><span>Por ano</span><span class="neg">${cost(othersYear)}</span></div>
      <p class="hint" style="margin-top:8px">Repartidas pelos 12 meses, dão ≈ ${cost(othersYear / 12)} por mês.</p></div>` : ''}
    ${p.bills.length ? `<div class="card"><div class="card-h"><h3>Para onde vai</h3><span class="muted small">média por mês</span></div>
      ${bar}${legend}
      ${nxt ? `<div class="coming"><span>${ico('calendar')} Próximo pagamento: <b>${esc(nxt.b.name)}</b> · ${nxt.d.getDate()} ${MESES[nxt.d.getMonth()].slice(0, 3)}</span><b class="neg">${cost(priceAt(nxt.b, ymOf(nxt.d)))}</b></div>` : ''}</div>` : ''}
    <p class="hint">Nas contas variáveis, o valor mensal é a média das últimas 6 faturas (luz, água, gás) ou o último valor (renda, condomínio, seguro, internet). Sem faturas, conta a estimativa.</p>
  </section>`;
}

/* Gastos avulsos: lista do mês atual agrupada por dia */
function vSpend(p) {
  const t = today0();
  const monthSpends = p.spends.filter(s => { const d = parseYmd(s.date); return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth(); });
  const total = monthSpends.filter(s => parseYmd(s.date) <= t).reduce((a, s) => a + s.amount, 0);
  const todaySum = monthSpends.filter(s => s.date === ymd(t)).reduce((a, s) => a + s.amount, 0);
  const ai = avgInfo(spendSource(p), 'day');
  const days = [...new Set(monthSpends.map(s => s.date))].sort().reverse();
  const moreDays = days.length > ui.spendDays ? `<button class="more" data-act="more-spend">Ver mais dias (${days.length - ui.spendDays})</button>` : '';
  const groups = days.slice(0, ui.spendDays).map(day => {
    const d = parseYmd(day);
    const items = monthSpends.filter(s => s.date === day).map(s => entryHTML({ kind: 'spend', id: s.id, name: s.note || catOf(s.cat).name, amount: s.amount, cat: s.cat, spend: s }, '')).join('');
    const label = +d === +t ? 'Hoje' : `${d.getDate()} de ${MESES[d.getMonth()]}`;
    return `<div class="card"><div class="card-h"><h3>${label}</h3><span class="muted small">${cost(monthSpends.filter(s => s.date === day).reduce((a, s) => a + s.amount, 0))}</span></div>${items}</div>`;
  }).join('');
  return `<section class="screen">
    <h1 class="page-title">Gastos do dia a dia</h1>
    <div class="big-total" style="margin-top:16px">
      <span>Gasto em ${MESES[t.getMonth()]}</span><b>${cost(total)}</b>
      ${btStats([[cost(todaySum), 'hoje'], ...avgStats(ai, 'day')])}${avgBase(ai.n, 'day')}
    </div>
    ${groups ? groups + moreDays : `<div class="card"><div class="empty-state"><div class="emoji">${ico('spend')}</div>Ainda sem gastos este mês.<br>Toca em <b>+</b> sempre que gastares algo.</div></div>`}
    <p class="hint">Vê outros meses no calendário, no Início.</p>
  </section>`;
}

/* Definições: tudo o que é do perfil num só sítio. Na primeira vez (perfil novo) mostra só a escolha do que gerir. */
/* Cor, estilo, calendário e modo: usado nas Definições e na janela rápida do Início. */
/* Cores e estilos podem ser muitos: mostram-se em PÁGINAS (uma grelha completa de cada vez), com setas, pontinhos e deslizar para o lado.
   Nada fica cortado nem precisa de scroll interno, e funciona para 15 ou para 150. Começa sempre na primeira página. */
const PAL_PER_PAGE = 12, STYLE_PER_PAGE = 6;
function swatchPager(kind, items, perPage, tile, gridClass, selIdx = 0) {      // selIdx: o item escolhido; sem página guardada, abre logo na página dele
  const pages = Math.max(1, Math.ceil(items.length / perPage)), cur = Math.min(ui.page?.[kind] ?? Math.floor(selIdx / perPage), pages - 1); (ui.page ||= {})[kind] = cur;
  const grids = Array.from({ length: pages }, (_, i) => `<div class="theme-grid ${gridClass}" role="group" aria-label="Página ${i + 1} de ${pages}">${items.slice(i * perPage, (i + 1) * perPage).map(tile).join('')}</div>`).join('');
  const dots = Array.from({ length: pages }, (_, i) => `<button class="pg-dot ${i === cur ? 'on' : ''}" data-act="pg" data-k="${kind}" data-to="${i}" aria-label="Página ${i + 1}"></button>`).join('');
  const bar = pages > 1 ? `<div class="pager-bar"><button class="pg-btn" data-act="pg" data-k="${kind}" data-d="-1" aria-label="Página anterior" ${cur === 0 ? 'disabled' : ''}>${ico('left')}</button>
      <span class="pg-dots">${dots}</span><button class="pg-btn" data-act="pg" data-k="${kind}" data-d="1" aria-label="Página seguinte" ${cur === pages - 1 ? 'disabled' : ''}>${ico('right')}</button></div>` : '';
  return `<div class="pager" id="${kind}-wrap" data-k="${kind}" data-pages="${pages}"><div class="pager-vp"><div class="pager-track" style="transform:translateX(-${cur * 100}%)">${grids}</div></div>${bar}</div>`;
}
function fitPager(box) {                              // a altura segue a página visível (a última pode ter menos mosaicos e não deixa espaço vazio)
  const i = ui.page?.[box.dataset.k] || 0, g = box.querySelector('.pager-track').children[i];
  if (g && g.offsetHeight) box.querySelector('.pager-vp').style.height = g.offsetHeight + 8 + 'px';
}
function fitPagers() { document.querySelectorAll('.pager').forEach(fitPager); }
function goPage(kind, to) {
  const box = document.getElementById(kind + '-wrap'); if (!box) return;
  const pages = +box.dataset.pages, i = Math.max(0, Math.min(pages - 1, to));
  (ui.page ||= {})[kind] = i; fitPager(box);
  box.querySelector('.pager-track').style.transform = `translateX(-${i * 100}%)`;
  box.querySelectorAll('.pg-dot').forEach((d, n) => d.classList.toggle('on', n === i));
  box.querySelector('[data-d="-1"]')?.toggleAttribute('disabled', i === 0);
  box.querySelector('[data-d="1"]')?.toggleAttribute('disabled', i === pages - 1);
}
let pg0 = null;                                       // deslizar para o lado dentro de uma grelha muda de página
document.addEventListener('touchstart', e => {
  const vp = e.touches.length === 1 && e.target.closest?.('.pager-vp');
  pg0 = vp ? { x: e.touches[0].clientX, y: e.touches[0].clientY, k: vp.parentElement.dataset.k } : null;
}, { passive: true });
document.addEventListener('touchend', e => {
  if (!pg0) return;
  const t = e.changedTouches[0], dx = t.clientX - pg0.x, dy = t.clientY - pg0.y, k = pg0.k; pg0 = null;
  if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
  swipedAt = Date.now(); goPage(k, (ui.page?.[k] || 0) + (dx < 0 ? 1 : -1));
}, { passive: true });
function themeControls(p) {
  const th = themeOf(p), on = (a, b) => a === b ? 'on' : '';
  const palTile = pal => `<button class="swatch ${on(th.palette, pal.id)}" data-act="theme-pal" data-v="${pal.id}" data-pal="${pal.id}" aria-label="${pal.name}">
      <i style="background:${themeBg(th.style, pal, true)}"></i><span>${pal.name}</span></button>`;
  const styleTile = ([k, l]) => `<button class="swatch wide ${on(th.style, k)}" data-act="theme-style" data-v="${k}" aria-label="${l}">
      <i style="background:${themeBg(k, palOf(th.palette), true)}"></i><span>${l}</span></button>`;
  return `${swatchPager('pal', PALETTES, PAL_PER_PAGE, palTile, 'pal', PALETTES.findIndex(x => x.id === th.palette))}
    <div class="field"><label>Estilo</label>${swatchPager('style', THEME_STYLES, STYLE_PER_PAGE, styleTile, 'three', THEME_STYLES.findIndex(x => x[0] === th.style))}</div>
    <div class="switch-row" data-act="theme-anim"><div><b>Animações ligadas</b><div class="hint">Põe as cores a dançar. Se te der tonturas, é só desligar.</div></div><div class="switch ${th.anim ? 'on' : ''}" id="anim-switch"></div></div>
    <div class="fx ${th.anim ? 'anim-on' : ''} ${ALWAYS_ANIM.includes(th.style) ? 'fluid' : ''}" id="fx-panel">
      <div class="fx-row fx-speed"><div class="fx-in"><div class="fx-head"><b>Velocidade</b><span class="fx-val">${fxSpeedLabel(fxSpeed(th))}</span></div>
        <input type="range" class="fx-range" data-fx="speed" min="0.5" max="2" step="0.25" value="${fxSpeed(th)}" aria-label="Velocidade das animações"></div></div>
      <div class="fx-row fx-amount"><div class="fx-in"><div class="fx-head"><b>Quantidade de efeitos</b><span class="fx-val">${FX_AMOUNT[fxLevel(th) - 1]}</span></div>
        <input type="range" class="fx-range" data-fx="amount" min="1" max="5" step="1" value="${fxLevel(th)}" aria-label="Quantidade de efeitos"></div></div>
    </div>
    <div class="field"><label>Calendário</label><div class="chips" style="--c:var(--accent)">${CAL_STYLES.map(([k, l]) => `<button class="chip ${on(th.cal, k)}" data-act="theme-cal" data-v="${k}">${l}</button>`).join('')}</div></div>
    <div class="field day-row"><label>Dia selecionado</label><div class="chips" style="--c:var(--accent)">${DAY_STYLES.map(([k, l]) => `<button class="chip ${on(DAY_STYLES.some(d => d[0] === th.day) ? th.day : 'default', k)}" data-act="theme-day" data-v="${k}">${l}</button>`).join('')}</div></div>
    <div class="switch-row" data-act="theme-cardstyle"><div><b>Cartões seguem o estilo</b></div><div class="switch ${th.cardStyle ? 'on' : ''}" id="cardstyle-switch"></div></div>
    <div class="field"><label>Modo</label><div class="seg four modes">${THEME_MODES.map(([k, l]) => `<button data-act="theme-mode" data-v="${k}" class="${on(th.mode, k)}">${l}</button>`).join('')}</div>
      <span class="hint">O tema é só deste perfil. Cada pessoa no telemóvel pode ter o seu.</span></div>`;
}
function refreshPreviews(th) {
  document.querySelectorAll('#pal-wrap .swatch[data-pal]').forEach(b => { b.querySelector('i').style.background = themeBg(th.style, palOf(b.dataset.pal), true); });
  document.querySelectorAll('#style-wrap .swatch[data-v]').forEach(b => { b.querySelector('i').style.background = themeBg(b.dataset.v, palOf(th.palette), true); });
}
function appearanceSheet(p) {
  ui.page = {};                                                      // cada vez que abre, as cores e os estilos abrem na página do que está escolhido
  openSheet(`<h2>Aparência</h2>${themeControls(p)}
    <div class="stack"><button class="btn primary" data-act="close-btn">Pronto</button></div>`);
}
function vManage(p) {
  const cards = MODULES.map(m => `
    <button class="module ${p.modules.includes(m.id) ? 'on' : ''} ${m.ready ? '' : 'soon'}" data-act="toggle-module" data-id="${m.id}">
      <div class="emoji">${ico(m.icon)}</div>
      <div class="grow"><b>${m.name}</b><span>${m.ready ? m.desc : 'Em breve'}</span></div>
      <div class="check">${p.modules.includes(m.id) ? ico('check') : ''}</div>
    </button>`).join('');
  if (ui.firstRun) return `<section class="screen">
    <h1 class="page-title">O que gostaria de gerir?</h1>
    <p class="muted">Escolhe o que queres acompanhar. Podes mudar quando quiseres — nada se perde.</p>
    <div class="modules">${cards}</div>
    <div class="spacer"></div><button class="btn primary" data-act="finish-setup">Continuar</button>
  </section>`;
  const th = themeOf(p), on = (a, b) => a === b ? 'on' : '';
  return `<section class="screen">
    <div class="set-head"><h1 class="page-title">Definições</h1>
      <button class="exit-btn" data-act="logout" aria-label="Sair para os perfis">${ico('logout')} Sair</button></div>
    <button class="set-profile" data-act="edit-profile">
      ${avatarHTML(p, 'sm')}
      <span class="grow"><b>${esc(p.name)}</b><span class="handle">@${esc(p.handle || '')}</span></span>
      <span class="edit-tag">${ico('edit')} Editar</span>
    </button>

    <h3 class="section-h">O que gerir</h3>
    <div class="modules" style="margin-top:0">${cards}</div>

    <h3 class="section-h">Ícone dos vícios</h3>
    <div class="chips" style="--c:var(--accent)">${VICE_ICONS.map(([k, l]) => `<button class="chip ${on(viceIcon(), k)}" data-act="vice-icon" data-v="${k}">${ico(k)} ${l}</button>`).join('')}</div>
    <span class="hint" style="display:block;margin:8px 0 0">Muda o ícone em toda a app, só neste perfil.</span>

    <h3 class="section-h">Avisos</h3>
    <div class="switch-row" data-act="toggle-balance-notice"><div><b>Avisar do balanço do mês</b><div class="hint">Nos primeiros dias de cada mês, diz como fechou o mês anterior</div></div><div class="switch ${p.balanceNotice ? 'on' : ''}" id="bn-switch"></div></div>

    <h3 class="section-h">Aparência</h3>
    ${themeControls(p)}

    <h3 class="section-h">Dados</h3>
    <div class="stack">
      <button class="btn ghost" data-act="export-backup">${ico('download')} Exportar perfil</button>
      <button class="btn ghost" data-act="import-backup">${ico('upload')} Importar perfil</button>
    </div>
    <p class="hint" id="storage-info" style="margin-top:12px">${backupLine(p)}</p>
    <button class="linkbtn accent" data-act="data-guide" style="margin-top:6px">${ico('shield')} Como guardar os dados em segurança</button>
    <h3 class="section-h">Segurança</h3>
    <div class="stack">${p.pin
      ? `<button class="btn ghost" data-act="change-pin">${ico('key')} Mudar senha</button><button class="btn ghost" data-act="remove-pin">${ico('unlock')} Remover senha</button>`
      : `<button class="btn ghost" data-act="set-pin">${ico('lock')} Definir senha</button>`}</div>

    <div class="danger-zone"><button class="btn danger" data-act="delete-profile">Apagar perfil</button></div>
  </section>`;
}

function afterProfileRender() {
  if (ui.tab === 'home') $('#calendar').innerHTML = vCalendar(current());
  if (ui.tab === 'manage') fillStorageInfo();
}

/* ── Cópias de segurança ── */
const hasData = p => p.incomes.length > 0 || p.earnings.length > 0 || p.subs.length > 0 || p.spends.length > 0 || p.bills.length > 0 || p.carFix.length > 0 || Object.keys(p.hlog).length > 0;
const DAY = 864e5;
function needsBackup(p) {      // lembrete suave: só com dados e passados 30 dias
  return hasData(p) && Date.now() - new Date(p.lastBackup || p.created).getTime() > 14 * DAY;
}
function backupLine(p) {
  return p.lastBackup ? `Última cópia: ${new Date(p.lastBackup).toLocaleDateString('pt-PT')}.` : 'Ainda não fizeste nenhuma cópia deste perfil.';
}
async function fillStorageInfo() {
  const el = $('#storage-info'); if (!el) return;
  const kb = Math.max(1, Math.round(JSON.stringify(current()).length / 1024));
  const inf = Store.info();
  let extra = '';
  if (inf.mode === 'native') {                               // app Android: ficheiros por ano, sem limite de espaço
    extra = ` Os dados ficam guardados em ficheiros por ano na app (${Math.max(1, Math.round(inf.bytes / 1024))} KB no total), sem limite de espaço, com uma cópia interna por dia.`;
  } else {                                                   // browser: localStorage tem um limite de uns 5 MB
    try {
      const est = await navigator.storage?.estimate?.();
      if (est?.quota) extra = ` Espaço usado pela app: ${(est.usage / 1048576).toFixed(1)} MB de ${Math.round(est.quota / 1048576)} MB.`;
    } catch {}
    if (inf.bytes > 3e6) extra += ' Atenção: estás a chegar ao limite do browser. Exporta uma cópia de segurança.';
  }
  el.textContent = `${backupLine(current())} Este perfil ocupa ${kb} KB.${extra}`;
}

async function exportBackup(p) {
  const payload = { app: 'konto', version: DB_VERSION, exportedAt: new Date().toISOString(), profile: p };
  const safe = p.handle || cleanHandle(p.name) || 'perfil';             // o ficheiro usa o @ do perfil: konto-filipe-2026-11-11.json
  const name = `konto-${safe}-${ymd(new Date())}.json`;
  const json = JSON.stringify(payload);
  const file = new File([json], name, { type: 'application/json' });
  let done = false;
  const cap = window.Capacitor, P = cap?.Plugins;
  if (cap?.isNativePlatform?.() && P?.Filesystem && P?.Share) {   // app Android: guarda o ficheiro na cache da app e abre o menu de partilhar do Android
    try {
      const w = await P.Filesystem.writeFile({ path: name, data: json, directory: 'CACHE', encoding: 'utf8' });
      await P.Share.share({ title: 'Cópia de segurança Konto', dialogTitle: 'Guardar a cópia de segurança', files: [w.uri] });
      done = true;
    } catch (e) {
      if (/cancel/i.test(e?.message || '')) return;        // fechou o menu sem escolher
      return toast('Não foi possível abrir o menu de partilha');
    }
  }
  if (!done && navigator.canShare?.({ files: [file] })) {   // browser no telemóvel: menu "Partilhar" (Drive, email…)
    try { await navigator.share({ files: [file], title: 'Cópia de segurança Konto' }); done = true; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  if (!done) {                                            // PC: descarrega o ficheiro
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  p.lastBackup = new Date().toISOString(); saveDB(); render(); toast('Cópia de segurança criada');
}

/* Importar uma cópia: se já existe esse perfil (o mesmo id ou o mesmo @), a cópia SUBSTITUI-O (mantém o id e o @, depois de confirmares);
   só se não existir é que cria um perfil novo. */
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    const src = data?.profile;
    if (data?.app !== 'konto' || !src || typeof src.name !== 'string') throw new Error('formato');
    if ((data.version || 1) > DB_VERSION) return toast('Esta cópia é de uma versão mais recente da app');
    const prof = migrateProfile(src), h = cleanHandle(src.handle);
    const same = db.profiles.find(x => x.id === src.id) || (h && db.profiles.find(x => x.handle === h));
    if (same) {
      const ok = await askConfirm({ title: `Substituir o perfil "${same.name}"?`, text: 'Os dados deste perfil vão ser substituídos pelos da cópia de segurança. Não dá para desfazer.', ok: 'Substituir', danger: true, icon: 'warn' });
      if (!ok) return;
      prof.id = same.id;
      prof.handle = uniqueHandle(src.handle || same.handle || prof.name, same.id);
      db.profiles[db.profiles.indexOf(same)] = prof; saveDB();
      if (ui.profileId === prof.id) applyTheme(themeOf(prof));
      toast(`Perfil "${prof.name}" atualizado`);
      render(); return;
    }
    prof.id = src.id && !db.profiles.some(x => x.id === src.id) ? src.id : uid();      // mantém o id da cópia, para a próxima importação reconhecer o perfil
    prof.handle = uniqueHandle(src.handle || prof.name, prof.id);       // o @ não pode repetir-se
    db.profiles.push(prof); saveDB();
    toast(`Perfil "${prof.name}" importado`);
    if (ui.screen === 'welcome' || ui.screen === 'ask') go('picker'); else render();
  } catch { toast('Ficheiro inválido'); }
}

/* Folhas (modais) */
let sheetTok = 0, sheetClosing = false;
function openSheet(html) {
  sheetTok++; sheetClosing = false;
  $('#sheet-root').innerHTML = `<div class="overlay" data-act="close-sheet"><div class="sheet"><div class="grab"></div>${html}</div></div>`;
  syncSegs(); syncModalLock();
}
function closeSheet() { $('#sheet-root').innerHTML = ''; syncModalLock(); }
/* Fechar com animação: a janela desliza para baixo e o fundo escurecido esbate. Também se fecha arrastando a barrinha de cima para baixo (a janela segue o dedo). */
function dismissSheet() {
  const sh = document.querySelector('#sheet-root .sheet'), ov = document.querySelector('#sheet-root .overlay');
  if (!sh || matchMedia('(prefers-reduced-motion: reduce)').matches) return closeSheet();
  if (sheetClosing) return;
  sheetClosing = true; const tok = ++sheetTok;
  sh.style.animation = 'none'; sh.style.transition = 'transform .26s cubic-bezier(.4, 0, 1, 1)'; sh.style.transform = 'translateY(105%)';
  if (ov) { ov.style.animation = 'none'; ov.style.transition = 'background-color .26s ease'; ov.style.backgroundColor = 'rgba(0, 0, 0, 0)'; }
  setTimeout(() => { if (tok === sheetTok) { sheetClosing = false; closeSheet(); } }, 280);
}
let sheetDrag = null;
document.addEventListener('pointerdown', e => {
  const g = e.target.closest?.('#sheet-root .grab'); if (!g || sheetClosing) return;
  const sh = g.closest('.sheet'), ov = g.closest('.overlay'); if (!sh) return;
  sheetDrag = { id: e.pointerId, y0: e.clientY, sh, ov, dy: 0, v: 0, ly: e.clientY, lt: performance.now(), h: sh.offsetHeight || 400 };
  sh.style.animation = 'none'; sh.style.transition = 'none'; if (ov) { ov.style.animation = 'none'; ov.style.transition = 'none'; }
  try { g.setPointerCapture(e.pointerId); } catch {}
});
document.addEventListener('pointermove', e => {
  const d = sheetDrag; if (!d || e.pointerId !== d.id) return;
  d.dy = Math.max(0, e.clientY - d.y0); const now = performance.now();
  d.v = (e.clientY - d.ly) / Math.max(1, now - d.lt); d.ly = e.clientY; d.lt = now;        // velocidade (px/ms) para decidir se foi um "empurrão"
  d.sh.style.transform = 'translateY(' + d.dy + 'px)';
  if (d.ov) d.ov.style.backgroundColor = 'rgba(0, 0, 0, ' + (.55 * (1 - Math.min(1, d.dy / d.h))).toFixed(3) + ')';
});
const endSheetDrag = e => {
  const d = sheetDrag; if (!d || (e && e.pointerId !== d.id)) return; sheetDrag = null;
  if (d.dy > 110 || (d.dy > 60 && d.v > .6)) return dismissSheet();                       // arrastou o suficiente (ou deu um empurrão): fecha
  d.sh.style.transition = 'transform .3s cubic-bezier(.2, .8, .2, 1)'; d.sh.style.transform = '';
  if (d.ov) { d.ov.style.transition = 'background-color .3s ease'; d.ov.style.backgroundColor = ''; }
  setTimeout(() => { d.sh.style.transition = ''; if (d.ov) d.ov.style.transition = ''; }, 320);
};
document.addEventListener('pointerup', endSheetDrag); document.addEventListener('pointercancel', endSheetDrag);
/* Com uma janela aberta, a página por baixo não deve mexer: ao arrastar dentro da janela, o scroll "passava" para o fundo. */
function syncModalLock() { document.documentElement.classList.toggle('modal-open', !!document.querySelector('#sheet-root .overlay, .dlg-overlay:not(.out)')); }

function subSheet(sub) {
  const s = sub || { name: '', amount: '', period: SUB_TABS.some(t => t[0] === ui.sper) ? ui.sper : 'month', day: new Date().getDate(), month: new Date().getMonth() + 1, remind: false, remindDays: 3 };      // uma subscrição nova já vem com o período do separador aberto
  ui.sheetPeriod = s.period; ui.sheetRemind = s.remind; ui.editId = sub?.id || null; ui.subIcon = s.icon || '';
  const tiles = [['', 'Automático', 'A'], ['letter', 'Só a letra', 'Aa']].map(([v, l, t]) => `<button type="button" class="ic-tile txt ${ui.subIcon === v ? 'on' : ''}" data-act="sub-icon" data-v="${v}" title="${l}" aria-label="${l}">${t}</button>`)
    .concat(SUB_ICONS.map(([v, l]) => `<button type="button" class="ic-tile ${ui.subIcon === v ? 'on' : ''}" data-act="sub-icon" data-v="${v}" title="${l}" aria-label="${l}">${subIc(null, v, v)}</button>`))
    .concat((typeof BRANDS !== 'undefined' ? BRANDS : []).slice().sort((a, b) => a.name.localeCompare(b.name)).map(b => `<button type="button" class="ic-tile ${ui.subIcon === 'brand:' + b.id ? 'on' : ''}" data-act="sub-icon" data-v="brand:${b.id}" title="${esc(b.name)}" aria-label="${esc(b.name)}">${subIc(null, b.name, 'brand:' + b.id)}</button>`));
  openSheet(`
    <h2>${sub ? 'Editar subscrição' : 'Nova subscrição'}</h2>
    <div class="field"><label>Nome</label><input class="input" id="s-name" maxlength="30" placeholder="Ex.: YouTube Premium" value="${esc(s.name)}"></div>
    <div class="field"><label>Ícone</label>
      <button type="button" class="icon-pick" data-act="sub-icons"><span id="s-icon-prev"></span><span class="grow"><b id="s-icon-label"></b><small class="muted">Toca para escolher</small></span>${ico('down')}</button>
      <div class="icon-grid" id="s-icon-grid" style="display:none">${tiles.join('')}</div></div>
    <div class="field"><label>Valor (€)</label><input class="input" id="s-amount" inputmode="decimal" placeholder="0,00" value="${s.amount === '' ? '' : String(curAmount(s)).replace('.', ',')}">
      ${pricesText(s) ? `<span class="hint">${pricesText(s)}</span>` : ''}</div>
    <div class="field"><label>Cobrança</label>
      <div class="chips">${Object.entries(FREQ).map(([k, f]) => `<button type="button" class="chip ${s.period === k ? 'on' : ''}" data-act="period" data-v="${k}" style="--c:var(--accent)">${f.label}</button>`).join('')}</div></div>
    <div class="row2">
      <div class="field"><label>Dia do mês</label><input class="input" id="s-day" type="number" min="1" max="31" value="${s.day}"></div>
      <div class="field" id="s-month-wrap" style="${s.period === 'month' ? 'display:none' : ''}"><label id="s-month-label">${s.period === 'year' ? 'Mês' : 'Mês de uma cobrança'}</label>
        <select class="input" id="s-month">${MESES.map((n, i) => `<option value="${i + 1}" ${s.month === i + 1 ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    </div>
    <div class="switch-row" data-act="remind"><div><b>Lembrar-me</b><div class="hint">Avisar antes da cobrança</div></div><div class="switch ${s.remind ? 'on' : ''}" id="s-switch"></div></div>
    <div class="field" id="s-rd-wrap" style="${s.remind ? '' : 'display:none'}"><label>Quanto tempo antes?</label>
      <select class="input" id="s-rd">${[1, 2, 3, 5, 7].map(n => `<option value="${n}" ${s.remindDays === n ? 'selected' : ''}>${n} dia${n > 1 ? 's' : ''} antes</option>`).join('')}</select></div>
    <div class="stack">
      <button class="btn primary" data-act="save-sub">Guardar</button>
      ${sub ? '<button class="btn danger" data-act="del-sub">Eliminar</button>' : ''}
    </div>`);
  updateSubIcon();
}
function updateSubIcon() {                       // atualiza a pré-visualização do ícone (e a sugestão automática, enquanto escreves o nome)
  const prev = $('#s-icon-prev'); if (!prev) return;
  const name = $('#s-name').value, id = ui.subIcon === '' ? autoIcon(name) : ui.subIcon;
  prev.innerHTML = subIc(null, name || '?', id);
  const b = id.startsWith('brand:') ? brandOf(id.slice(6)) : null, g = SUB_ICONS.find(x => x[0] === id);
  const what = id === 'letter' || !id ? 'Letra inicial' : b ? b.name : g ? g[1] : 'Letra inicial';
  $('#s-icon-label').textContent = ui.subIcon === '' ? `Automático · ${what}` : what;
}

const NOTE_HINT = { fuel: 'Ex.: Galp', food: 'Ex.: Sushi', transport: 'Ex.: Autocarro' };      // a sugestão da nota muda com a categoria; em "Outros" não há nenhuma
function spendSheet(sp) {
  const t = today0();
  const minDate = ymd(new Date(t.getFullYear(), t.getMonth(), 1));   // só gere desde o início do mês atual
  const s = sp || { amount: '', cat: 'other', date: ymd(t), note: '' };
  ui.sheetCat = s.cat; ui.editId = sp?.id || null;
  const fuelHint = current().modules.includes('fuel')
    ? 'Aqui só o valor. Para mais detalhes, usa o separador Automóvel.'
    : 'Aqui só o valor. Para litros e consumo, ativa o módulo Automóvel nas Definições.';
  openSheet(`
    <h2>${sp ? 'Editar gasto' : 'Registar gasto'}</h2>
    <div class="field"><label>Valor (€)</label><input class="input big" id="g-amount" inputmode="decimal" placeholder="0,00" value="${s.amount === '' ? '' : String(s.amount).replace('.', ',')}"></div>
    <div class="field"><label>Categoria</label>
      <div class="chips">${CATS.filter(c => c.id !== 'subs' && (!OWN_TAB.includes(c.id) || c.id === s.cat)).map(c => `<button class="chip ${s.cat === c.id ? 'on' : ''}" data-act="cat" data-v="${c.id}" style="--c:${c.color}">${ico(c.icon)} ${c.name}</button>`).join('')}</div>
      <div class="expand ${s.cat === 'fuel' ? 'open' : ''}" id="fuel-hint"><div><span class="hint">${fuelHint}</span></div></div></div>
    <div class="row2">
      <div class="field"><label>Data</label><input class="input" id="g-date" type="date" min="${s.date < minDate ? s.date : minDate}" value="${s.date}"></div>
      <div class="field"><label>Nota (opcional)</label><input class="input" id="g-note" maxlength="40" placeholder="${NOTE_HINT[s.cat] || ''}" value="${esc(s.note)}"></div>
    </div>
    <div class="stack">
      <button class="btn primary" data-act="save-spend">Guardar</button>
      ${sp ? '<button class="btn danger" data-act="del-spend">Eliminar</button>' : ''}
    </div>`);
}

/* Criar / editar um hábito (vício). Tudo é opcional e escolhido por quem usa. */
function habitSheet(h) {
  const isNew = !h;
  const s = h || { name: '', kind: 'unit', price: 0, wins: false, show: true, tpl: 'outro' };
  ui.editId = h?.id || null; ui.hKind = s.kind; ui.hWins = s.wins; ui.hShow = s.show; ui.hTpl = s.tpl || 'outro';
  const num = n => n > 0 ? String(+Number(n).toFixed(4)).replace('.', ',') : '';
  // tipos (café e álcool): os do hábito; num hábito antigo sem tipos, parte do preço que já tinha
  ui.hTypes = s.types?.length ? s.types.map(t => ({ ...t }))
    : (s.tpl === 'cafe' || s.tpl === 'alcool') && !isNew
      ? (s.price > 0 ? [{ id: uid(), name: s.tpl === 'alcool' ? 'Bebida' : 'Café', price: s.price, ua: s.tpl === 'alcool' ? 1 : 0 }] : freshTypes(s.tpl))
      : [];
  // hábitos de tabaco antigos só tinham o preço por cigarro: assume um maço de 20 para preencher os campos
  const pk = s.pack || (s.tpl === 'tabaco' && s.price > 0 ? { price: +(s.price * 20).toFixed(2), size: 20 } : {});
  openSheet(`
    <h2>${isNew ? 'Novo hábito' : 'Editar hábito'}</h2>
    ${isNew ? `<div class="field"><label>Começar por um modelo</label><div class="chips">${HABIT_TPLS.map(t =>
      `<button class="chip ${ui.hTpl === t.id ? 'on' : ''}" data-act="h-tpl" data-v="${t.id}" style="--c:${t.color}">${ico(t.icon)} ${t.name || 'Outros'}</button>`).join('')}</div></div>` : ''}
    <div class="field"><label>Nome</label><input class="input" id="h-name" maxlength="24" placeholder="Ex.: Tabaco" value="${esc(s.name)}"></div>

    <div id="hx-generic">
      <div class="field"><label>Como registas?</label>
        <div class="seg"><button data-act="hkind" data-v="unit" class="${s.kind === 'unit' ? 'on' : ''}">Por unidade (+1)</button><button data-act="hkind" data-v="value" class="${s.kind === 'value' ? 'on' : ''}">Por valor (€)</button></div>
        <span class="hint">Por unidade: tocas em +1 de cada vez. Por valor: escreves quanto gastaste.</span></div>
      <div class="field" id="h-price-wrap"><label>Preço por unidade (€)</label>
        <input class="input" id="h-price" inputmode="decimal" placeholder="Ex.: 0,80" value="${num(s.price)}"></div>
      <div class="switch-row" id="h-wins-row" data-act="h-wins"><div><b>Registar também ganhos</b><div class="hint">Mostra o saldo: ganho menos gasto</div></div><div class="switch ${s.wins ? 'on' : ''}" id="h-wins-switch"></div></div>
    </div>

    <div id="hx-tabaco">
      <div class="row2">
        <div class="field"><label>Preço do maço (€)</label><input class="input" id="h-pack-price" inputmode="decimal" placeholder="Ex.: 5,50" value="${num(pk.price)}"></div>
        <div class="field"><label>Cigarros por maço</label><input class="input" id="h-pack-size" inputmode="numeric" placeholder="20" value="${pk.size || ''}"></div>
      </div>
      <div class="row2">
        <div class="field"><label>Meta por dia (opcional)</label><input class="input" id="h-goal" inputmode="numeric" placeholder="Ex.: 10" value="${s.goal > 0 ? s.goal : ''}"></div>
        <div class="field"><label>Fumavas por dia antes</label><input class="input" id="h-baseline" inputmode="numeric" placeholder="Ex.: 20" value="${s.baseline > 0 ? s.baseline : ''}"></div>
      </div>
      <span class="hint" style="display:block;margin:-6px 0 16px">O "antes" serve para calcular quanto poupas ao fumar menos.</span>
    </div>

    <div id="hx-casino">
      <div class="${isNew ? '' : 'row2'}">
        <div class="field"><label>Limite de depósitos por mês (€)</label><input class="input" id="h-limit" inputmode="decimal" placeholder="Opcional" value="${num(s.limit)}"></div>
        ${isNew ? '' : `<div class="field"><label>Pausa até</label><input class="input" id="h-pause" type="date" min="${ymd(today0())}" value="${s.pausedUntil || ''}"></div>`}
      </div>
      <span class="hint" style="display:block;margin:-6px 0 16px">O limite mostra uma barra de progresso.${isNew ? '' : ' A pausa só te avisa quando fazes um depósito, nunca bloqueia nada.'}</span>
    </div>

    <div id="hx-types">
      <div class="field" style="margin-bottom:8px"><label>Tipos <span class="muted small">(cada um com o seu preço)</span></label></div>
      <div id="types-list"></div>
      <button class="btn ghost add-type" data-act="h-type-add" type="button">${ico('plus')} Adicionar tipo</button>
      <span class="hint" style="display:block;margin:10px 0 16px">Tocas no tipo certo de cada vez que registas. Os valores são só um ponto de partida: ajusta aos teus.</span>
    </div>

    <div id="hx-alcool">
      <div class="field"><label>Meta semanal de unidades de álcool (opcional)</label>
        <input class="input" id="h-goalweek" inputmode="decimal" placeholder="Ex.: 10" value="${s.goalWeek > 0 ? num(s.goalWeek) : ''}"></div>
    </div>

    <div class="switch-row" data-act="h-show"><div><b>Mostrar no calendário e no resumo</b><div class="hint">Desligado, o hábito só aparece neste separador</div></div><div class="switch ${s.show ? 'on' : ''}" id="h-show-switch"></div></div>
    <div class="stack">
      <button class="btn primary" data-act="save-habit">Guardar</button>
      ${isNew ? '' : '<button class="btn danger" data-act="del-habit">Eliminar hábito</button>'}
    </div>`);
  hxApply();
}

/* Mostra só os campos do modelo escolhido. */
function hxApply() {
  const t = ui.hTpl, typed = t === 'cafe' || t === 'alcool', generic = !typed && !['tabaco', 'casino', 'jogos'].includes(t);
  $('#hx-generic').style.display = generic ? '' : 'none';
  $('#hx-types').style.display = typed ? '' : 'none';
  $('#hx-alcool').style.display = t === 'alcool' ? '' : 'none';
  if (typed) typesEditorRender();
  $('#hx-tabaco').style.display = t === 'tabaco' ? '' : 'none';
  $('#hx-casino').style.display = t === 'casino' ? '' : 'none';
  $('#h-price-wrap').style.display = ui.hKind === 'unit' ? '' : 'none';
  $('#h-wins-row').style.display = ui.hKind === 'value' ? '' : 'none';
}

/* Editor de tipos (café e álcool): uma linha por tipo, com nome, preço e (no álcool) unidades de álcool. */
function typesEditorRender() {
  const al = ui.hTpl === 'alcool', val = n => n > 0 ? String(+Number(n).toFixed(4)).replace('.', ',') : '';
  $('#types-list').innerHTML = `<div class="type-head ${al ? 'al' : ''}"><span>Nome</span><span>Preço (€)</span>${al ? '<span>UA</span>' : ''}<span></span></div>`
    + ui.hTypes.map((t, i) => `<div class="type-row ${al ? 'al' : ''}">
        <input class="input t-name" maxlength="20" placeholder="Ex.: ${al ? 'Cerveja' : 'Bica'}" value="${esc(t.name)}">
        <input class="input t-price" inputmode="decimal" placeholder="0,00" value="${val(t.price)}">
        ${al ? `<input class="input t-ua" inputmode="decimal" placeholder="1,0" value="${val(t.ua)}">` : ''}
        <button class="t-del" type="button" data-act="h-type-del" data-i="${i}" aria-label="Remover tipo" ${ui.hTypes.length < 2 ? 'disabled' : ''}>${ico('minus')}</button>
      </div>`).join('');
}
function typesRead() {                                       // guarda o que foi escrito antes de voltar a desenhar a lista
  document.querySelectorAll('#types-list .type-row').forEach((row, i) => {
    const t = ui.hTypes[i]; if (!t) return;
    const num = sel => { const raw = row.querySelector(sel)?.value.trim() ?? ''; return raw ? parseExpr(raw) : 0; };
    t.name = row.querySelector('.t-name').value; t.price = num('.t-price'); t.ua = ui.hTpl === 'alcool' ? num('.t-ua') : 0;
  });
}

/* Saltar no calendário: escolher o ano e o mês. Os meses antes do primeiro registo ficam desativados;
 * os que têm registos levam um ponto. */
function calPickBody() {
  const p = current(), first = firstMonthIndex(p), y = ui.pickY;
  const minY = Math.floor(first / 12), maxY = new Date().getFullYear() + 1;
  const months = MESES.map((n, m) => {
    const off = y * 12 + m < first, on = y === ui.cal.y && m === ui.cal.m;
    const has = !off && entriesOn(p, y, m).length > 0;
    return `<button class="cp-m ${on ? 'on' : ''}" data-act="cp-month" data-m="${m}" ${off ? 'disabled' : ''}>${n.slice(0, 3)}${has ? '<i class="dot"></i>' : ''}</button>`;
  }).join('');
  return `<div class="cp-year"><button data-act="cp-year" data-d="-1" ${y <= minY ? 'disabled' : ''} aria-label="Ano anterior">${ico('left')}</button><b>${y}</b>
    <button data-act="cp-year" data-d="1" ${y >= maxY ? 'disabled' : ''} aria-label="Ano seguinte">${ico('right')}</button></div><div class="cp-grid">${months}</div>`;
}
function calPickSheet() {
  ui.pickY = ui.cal.y;
  openSheet(`<h2>Ir para…</h2><div id="cp-body">${calPickBody()}</div>
    <div class="stack" style="margin-top:18px"><button class="btn ghost" data-act="cp-today">Voltar a hoje</button></div>`);
}

/* Editar o perfil: foto, nome e @utilizador (a partir do Início). */
const pfPreview = () => ui.pf.avatar ? `<div class="avatar md"><img src="${ui.pf.avatar}" alt=""></div>` : avatarHTML({ name: ui.pf.name || '?', avatar: '' }, 'md');
function profileSheet() {
  const p = current();
  ui.pf = { avatar: p.avatar || '', name: p.name };
  openSheet(`
    <h2>Editar perfil</h2>
    <div class="pf-photo">
      <label class="photo-pick" data-act="pf-photo" aria-label="Mudar a foto">
        <span id="pf-preview">${pfPreview()}</span>
        <input id="pf-photo-input" type="file" accept="image/*" hidden>
      </label>
      <div class="pf-photo-actions"><span class="muted small">Toca na foto para a mudar</span>
        <button class="linkbtn" id="pf-remove" data-act="pf-remove-photo" ${p.avatar ? '' : 'style="display:none"'}>Remover foto</button></div>
    </div>
    <div class="field"><label>Nome</label><input class="input" id="pf-name" maxlength="24" value="${esc(p.name)}"></div>
    <div class="field"><label>@ utilizador</label>
      <div class="at-field"><span>@</span><input class="input" id="pf-handle" maxlength="20" autocapitalize="none" autocomplete="off" spellcheck="false" value="${esc(p.handle || '')}"></div>
      <span class="hint">Distingue perfis com o mesmo nome. Só letras, números, ponto e _.</span></div>
    <div class="stack"><button class="btn primary" data-act="save-pf">Guardar</button></div>`);
}

/* Criar / editar uma conta de casa. */
function billSheet(b) {
  const s = b || { type: 'light', name: '', amount: '', variable: true, period: 'month', day: new Date().getDate(), month: new Date().getMonth() + 1, remind: false, remindDays: 3 };
  ui.editId = b?.id || null; ui.billType = s.type; ui.billVar = s.variable; ui.billPeriod = s.period; ui.billRemind = s.remind;
  openSheet(`
    <h2>${b ? 'Editar conta' : 'Nova conta de casa'}</h2>
    <div class="field"><label>Tipo</label><div class="chips">${BILL_TYPES.map(t =>
      `<button type="button" class="chip ${s.type === t.id ? 'on' : ''}" data-act="bill-type" data-v="${t.id}" style="--c:${t.color}">${ico(t.icon)} ${t.name}</button>`).join('')}</div></div>
    <div class="field"><label>Nome</label><input class="input" id="b-name" maxlength="30" placeholder="Ex.: ${billTypeOf(s.type).name}" value="${esc(s.name)}"></div>
    <div class="switch-row" data-act="bill-var"><div><b>Valor variável</b><div class="hint">Para contas que mudam todos os meses, como a luz e a água. Indicas o valor real quando a fatura chega.</div></div><div class="switch ${s.variable ? 'on' : ''}" id="b-var-switch"></div></div>
    <div class="field"><label id="b-amount-label">${s.variable ? 'Estimativa da fatura (€)' : 'Valor (€)'}</label>
      <input class="input" id="b-amount" inputmode="decimal" placeholder="0,00" value="${s.amount === '' ? '' : String(curAmount(s)).replace('.', ',')}">
      ${pricesText(s) ? `<span class="hint">${pricesText(s)}</span>` : ''}</div>
    <div class="field"><label>Frequência</label>
      <div class="chips">${Object.entries(FREQ).map(([k, f]) => `<button type="button" class="chip ${s.period === k ? 'on' : ''}" data-act="bperiod" data-v="${k}" style="--c:var(--accent)">${f.label}</button>`).join('')}</div></div>
    <div class="row2">
      <div class="field"><label>Dia do mês</label><input class="input" id="b-day" type="number" min="1" max="31" value="${s.day}"></div>
      <div class="field" id="b-month-wrap" style="${s.period === 'month' ? 'display:none' : ''}"><label id="b-month-label">${s.period === 'year' ? 'Mês' : 'Mês de uma cobrança'}</label>
        <select class="input" id="b-month">${MESES.map((n, i) => `<option value="${i + 1}" ${s.month === i + 1 ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    </div>
    <div class="switch-row" data-act="bremind"><div><b>Lembrar-me</b><div class="hint">Avisar antes do pagamento</div></div><div class="switch ${s.remind ? 'on' : ''}" id="b-rswitch"></div></div>
    <div class="field" id="b-rd-wrap" style="${s.remind ? '' : 'display:none'}"><label>Quanto tempo antes?</label>
      <select class="input" id="b-rd">${[1, 2, 3, 5, 7].map(n => `<option value="${n}" ${s.remindDays === n ? 'selected' : ''}>${n} dia${n > 1 ? 's' : ''} antes</option>`).join('')}</select></div>
    <div class="stack">
      <button class="btn primary" data-act="save-bill">Guardar</button>
      ${b ? '<button class="btn danger" data-act="del-bill">Eliminar conta</button>' : ''}
    </div>`);
}

/* O valor de uma subscrição ou conta mudou: a partir de que mês conta o novo? Os meses anteriores ficam como estavam. */
function priceFromSheet(item, newAmount) {
  const now = new Date(), curIdx = now.getFullYear() * 12 + now.getMonth(), start = Math.min(startIndex(item), curIdx);
  const opts = [];
  for (let i = start; i <= curIdx + 12; i++) {
    const y = Math.floor(i / 12), m = i % 12;
    opts.push(`<option value="${y}-${pad(m + 1)}" ${i === curIdx ? 'selected' : ''}>${MESES[m]} ${y}</option>`);
  }
  openSheet(`
    <h2>O valor mudou</h2>
    <p class="muted" style="margin:-10px 0 18px">De ${nf(curAmount(item))} € para ${nf(newAmount)} €. A partir de que mês conta o valor novo?</p>
    <div class="field"><label>Conta a partir de</label><select class="input" id="pf-from">${opts.join('')}</select></div>
    <div class="stack">
      <button class="btn primary" data-act="price-apply">Aplicar a partir daí</button>
      <button class="btn ghost" data-act="price-all">Corrigir desde sempre</button>
      <button class="btn ghost" data-act="price-cancel">Cancelar</button>
    </div>
    <p class="hint" style="margin-top:12px">"Aplicar a partir daí" deixa os meses anteriores com o valor antigo. "Corrigir desde sempre" serve para quando o valor estava errado.</p>`);
}

/* Valor real de uma fatura (contas variáveis). Sem ele, conta a estimativa. */
function invoiceSheet(bid, ym) {                                       // valor real de um mês: fatura (Casa), pagamento fixo (Automóvel) ou ordenado
  const p = current(), kind = p.bills.some(x => x.id === bid) ? 'bill' : p.carFix.some(x => x.id === bid) ? 'car' : 'inc';
  const b = (kind === 'bill' ? p.bills : kind === 'car' ? p.carFix : p.incomes).find(x => x.id === bid), real = p.billLog[`${bid}:${ym}`];
  const [y, m] = ym.split('-').map(Number), prev = billReals(p, b).filter(r => r.ym < ym).pop();
  const T = { bill: ['Fatura', 'Valor da fatura (€)', 'fatura anterior', 'Editar a conta', 'edit-bill'], car: ['Pagamento', 'Valor pago (€)', 'anterior', 'Editar o pagamento', 'edit-carfix'], inc: ['Ordenado', 'Valor recebido (€)', 'anterior', 'Editar o ordenado', 'edit-income'] }[kind];
  const est = kind === 'inc' ? incomeEstimate(p, b, ym) : priceAt(b, ym);
  ui.inv = { bid, ym };
  openSheet(`
    <h2>${T[0]} · ${esc(kind === 'inc' ? incomeName(b) : b.name)}</h2>
    <p class="muted" style="margin:-10px 0 18px">${MESES[m - 1]} de ${y}</p>
    <div class="field"><label>${T[1]}</label>
      <input class="input big" id="i-amount" inputmode="decimal" placeholder="0,00" value="${real !== undefined ? String(real).replace('.', ',') : ''}">
      <span class="hint">Estimativa: ${nf(est)} €${prev ? ` · ${T[2]}: ${nf(prev.v)} €` : ''}</span></div>
    <div class="stack">
      <button class="btn primary" data-act="save-invoice">Guardar</button>
      ${real !== undefined ? '<button class="btn danger" data-act="clear-invoice">Voltar à estimativa</button>' : ''}
      <button class="btn ghost" data-act="${T[4]}" data-id="${b.id}">${T[3]}</button>
    </div>`);
}

/* Compra de um jogo (modelo Jogos): título, preço, data e reembolso opcional. */
function gameSheet(hid, key, itemId) {
  const p = current(), h = p.habits.find(x => x.id === hid);
  const it = itemId ? p.hlog[key].items.find(i => i.id === itemId) : null;
  const t = today0(), minDate = ymd(new Date(t.getFullYear(), t.getMonth(), 1));
  const date = key ? key.slice(hid.length + 1) : ymd(t);
  ui.gm = { hid, key: key || null, itemId: itemId || null };
  ui.gmRefund = !!(it && it.refund > 0);
  const num = n => n > 0 ? String(+Number(n).toFixed(2)).replace('.', ',') : '';
  openSheet(`
    <h2>${it ? 'Editar compra' : 'Nova compra'}</h2>
    <div class="field"><label>Jogo</label><input class="input" id="gm-name" maxlength="40" placeholder="Ex.: Elden Ring" value="${it ? esc(it.name) : ''}"></div>
    <div class="row2">
      <div class="field"><label>Preço (€)</label><input class="input" id="gm-price" inputmode="decimal" placeholder="0,00" value="${it ? num(it.price) : ''}"></div>
      <div class="field"><label>Data</label><input class="input" id="gm-date" type="date" min="${date < minDate ? date : minDate}" max="${ymd(t)}" value="${date}"></div>
    </div>
    <div class="switch-row" data-act="gm-refund"><div><b>Foi reembolsado</b><div class="hint">O reembolso desconta ao gasto</div></div><div class="switch ${ui.gmRefund ? 'on' : ''}" id="gm-refund-switch"></div></div>
    <div class="field" id="gm-refund-wrap" style="${ui.gmRefund ? '' : 'display:none'}"><label>Valor reembolsado (€)</label><input class="input" id="gm-refund" inputmode="decimal" placeholder="0,00" value="${it ? num(it.refund) : ''}"></div>
    <div class="stack">
      <button class="btn primary" data-act="save-game">Guardar</button>
      ${it ? '<button class="btn danger" data-act="del-game">Eliminar compra</button>' : ''}
    </div>`);
}
/* Os totais do dia derivam sempre da lista de compras desse dia. */
function recalcDay(p, key) {
  const r = p.hlog[key]; if (!r) return;
  if (!r.items?.length) { delete p.hlog[key]; return; }
  r.n = r.items.length;
  r.spent = +r.items.reduce((a, i) => a + i.price, 0).toFixed(2);
  r.won = +r.items.reduce((a, i) => a + (i.refund || 0), 0).toFixed(2);
}

/* Café e álcool: registos de um dia por tipo (noutro dia, ou para editar). Criar soma ao dia; editar substitui. */
function leftoverOf(h, rec) {                                // o que veio de tipos que já foram removidos continua a contar
  const known = new Set(h.types.map(x => x.id)), by = {};
  let n = 0; for (const id in (rec.by || {})) if (!known.has(id)) { by[id] = rec.by[id]; n += rec.by[id]; }
  if (!n) return { n: 0, by, spent: 0, ua: 0 };
  const kSpent = h.types.reduce((a, x) => a + (rec.by?.[x.id] || 0) * x.price, 0), kUa = h.types.reduce((a, x) => a + (rec.by?.[x.id] || 0) * (x.ua || 0), 0);
  return { n, by, spent: Math.max(0, rec.spent - kSpent), ua: Math.max(0, (rec.ua || 0) - kUa) };
}
function typesDaySheet(hid, key) {
  const p = current(), h = p.habits.find(x => x.id === hid), rec = key ? p.hlog[key] : null;
  const t = today0(), minDate = ymd(new Date(t.getFullYear(), t.getMonth(), 1)), date = key ? key.slice(hid.length + 1) : ymd(t);
  ui.hd = { hid, key: key || null, price: 0, mode: null };
  const d = parseYmd(date), al = h.tpl === 'alcool', lo = rec ? leftoverOf(h, rec) : { n: 0 };
  openSheet(`
    <h2>${key ? 'Editar registo' : 'Registar noutro dia'} · ${esc(h.name)}</h2>
    ${key ? `<p class="muted" style="margin:-10px 0 18px">${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}</p>`
          : `<div class="field"><label>Data</label><input class="input" id="td-date" type="date" min="${minDate}" max="${ymd(t)}" value="${date}"></div>`}
    <div class="tq-list">${h.types.map(x => `<div class="tq"><div><b>${esc(x.name)}</b><span class="muted small">${nf(x.price)} €${al && x.ua > 0 ? ' · ' + nf(x.ua, 1) + ' UA' : ''}</span></div>
        <input class="input tq-in" id="tq-${x.id}" inputmode="numeric" placeholder="0" value="${rec?.by?.[x.id] || ''}"></div>`).join('')}</div>
    ${lo.n > 0 ? `<p class="hint">Mais ${lo.n} registo${lo.n === 1 ? '' : 's'} de tipos que já removeste ficam como estão.</p>` : ''}
    <div class="stack">
      <button class="btn primary" data-act="save-tday">Guardar</button>
      ${key ? '<button class="btn danger" data-act="del-hday">Eliminar registo</button>' : ''}
    </div>`);
}

/* Registo de um dia de um hábito: criar (soma ao dia) ou editar (substitui). */
function hdaySheet(hid, key, mode) {
  const p = current(), h = p.habits.find(x => x.id === hid);
  const rec = key ? p.hlog[key] : null;
  const t = today0(), minDate = ymd(new Date(t.getFullYear(), t.getMonth(), 1));
  const date = key ? key.slice(hid.length + 1) : ymd(t), unit = h.kind === 'unit';
  const casino = h.tpl === 'casino';                       // casino: depósito ou ganho (um campo só)
  ui.hd = { hid, key: key || null, price: h.price || 0, mode: mode || null };
  const num = n => n > 0 ? String(+n.toFixed(2)).replace('.', ',') : '';
  const d = parseYmd(date);
  openSheet(`
    <h2>${key ? 'Editar registo' : casino ? (mode === 'gain' ? 'Ganho' : 'Depósito') : 'Registar'} · ${esc(h.name)}</h2>
    ${key ? `<p class="muted" style="margin:-10px 0 18px">${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}</p>`
          : `<div class="field"><label>Data</label><input class="input" id="d-date" type="date" min="${minDate}" max="${ymd(t)}" value="${date}"></div>`}
    ${unit ? `<div class="row2">
        <div class="field"><label>Quantidade</label><input class="input" id="d-n" inputmode="numeric" value="${key ? rec.n : 1}"></div>
        <div class="field"><label>Gasto (€)</label><input class="input" id="d-spent" inputmode="decimal" placeholder="0,00" value="${key ? num(rec.spent) : num(h.price)}"></div>
      </div>`
      : casino && !key
        ? (mode === 'gain'
            ? `<div class="field"><label>Valor ganho (€)</label><input class="input big" id="d-won" inputmode="decimal" placeholder="0,00">
                 <span class="hint">Conta logo como ganho. Se o levantas já ou não, decides tu.</span></div>`
            : `<div class="field"><label>Valor depositado (€)</label><input class="input big" id="d-spent" inputmode="decimal" placeholder="0,00">
                 <span class="hint">Dinheiro que meteste no casino. Conta como gasto e não volta.</span></div>`)
        : `<div class="field"><label>${casino ? 'Depositado (€)' : 'Gasto (€)'}</label><input class="input big" id="d-spent" inputmode="decimal" placeholder="0,00" value="${key ? num(rec.spent) : ''}"></div>
           ${h.wins ? `<div class="field"><label>Ganho (€)</label><input class="input" id="d-won" inputmode="decimal" placeholder="0,00" value="${key ? num(rec.won) : ''}"></div>` : ''}`}
    <div class="stack">
      <button class="btn primary" data-act="save-hday">Guardar</button>
      ${key ? '<button class="btn danger" data-act="del-hday">Eliminar registo</button>' : ''}
    </div>`);
}

/* Criar / editar um veículo (módulo Combustível). */
function vehicleSheet(v) {
  const s = v || { name: '', type: 'car' };
  ui.editId = v?.id || null; ui.vehType = s.type;
  openSheet(`
    <h2>${v ? 'Editar veículo' : 'Novo veículo'}</h2>
    <div class="field"><label>Nome</label><input class="input" id="v-name" maxlength="24" placeholder="Ex.: Carro da família" value="${esc(s.name)}"></div>
    <div class="field"><label>Km por ano (aproximado, opcional)</label><input class="input" id="v-kmyear" inputmode="numeric" placeholder="Ex.: 15000" value="${s.kmYear > 0 ? s.kmYear : ''}"><span class="hint">Ajuda a app a estimar os km quando não os registas.</span></div>
    <div class="field"><label>Tipo</label><div class="chips">${VEHICLE_TYPES.map(t =>
      `<button type="button" class="chip ${s.type === t.id ? 'on' : ''}" data-act="veh-type" data-v="${t.id}" style="--c:var(--accent)">${ico(t.icon)} ${t.name}</button>`).join('')}</div></div>
    <div class="stack">
      <button class="btn primary" data-act="save-vehicle">Guardar</button>
      ${v ? '<button class="btn danger" data-act="del-vehicle">Eliminar veículo</button>' : ''}
    </div>`);
}

/* Abastecimento detalhado (módulo Combustível): litros e km obrigatórios. */
function fuelSheet(sp) {
  const t = today0();
  const minDate = ymd(new Date(t.getFullYear(), t.getMonth(), 1));
  const s = sp || { amount: '', date: ymd(t), note: '' };
  ui.editId = sp?.id || null;
  ui.sheetFull = s.full !== false;                               // depósito cheio por defeito
  ui.fuelOrder = s.liters > 0 ? ['g-amount', 'g-liters'] : s.amount > 0 ? ['g-amount'] : [];   // o valor já preenchido conta; o preço calcula-se
  const P = current();
  if (!P.vehicles.length) { P.vehicles.push({ id: uid(), name: 'O meu carro', type: 'car' }); saveDB(); }   // o primeiro abastecimento cria o primeiro veículo
  ui.sheetVeh = (s.veh && P.vehicles.some(x => x.id === s.veh)) ? s.veh : (P.vehicles.find(x => x.id === ui.fuelVeh) || P.vehicles[0]).id;
  const dec = (n, d) => n > 0 ? n.toFixed(d).replace('.', ',') : '';
  const title = !sp ? 'Novo abastecimento' : s.liters > 0 ? 'Editar abastecimento' : 'Completar abastecimento';
  openSheet(`
    <h2>${title}</h2>
    ${P.vehicles.length > 1 ? `<div class="field"><label>Veículo</label><div class="chips">${P.vehicles.map(x =>
      `<button type="button" class="chip ${x.id === ui.sheetVeh ? 'on' : ''}" data-act="fveh" data-v="${x.id}" style="--c:var(--accent)">${ico(vehTypeOf(x.type).icon)} ${esc(x.name)}</button>`).join('')}</div></div>` : ''}
    <div class="field"><label>Valor pago (€) *</label><input class="input big" id="g-amount" inputmode="decimal" placeholder="0,00" value="${s.amount === '' ? '' : String(s.amount).replace('.', ',')}"></div>
    <div class="row2">
      <div class="field"><label>Litros *</label><input class="input" id="g-liters" inputmode="decimal" placeholder="0,00" value="${dec(s.liters, 2)}"></div>
      <div class="field"><label>Preço por litro (€)</label><input class="input" id="g-price" inputmode="decimal" placeholder="0,000" value="${s.liters > 0 ? dec(s.amount / s.liters, 3) : ''}"></div>
    </div>
    <span class="hint" style="display:block;margin:-6px 0 16px">Preenche dois destes três e o terceiro calcula-se sozinho.</span>
    <div class="field"><label>Quilómetros do conta-quilómetros (opcional)</label>
      <input class="input" id="g-km" inputmode="numeric" placeholder="Ex.: 84500" value="${s.km > 0 ? s.km : ''}">
      <span class="hint" id="g-km-hint">${fuelKmHint(ui.sheetVeh, sp?.id)}</span></div>
    <div class="switch-row" data-act="full-toggle"><div><b>Depósito cheio</b><div class="hint">Necessário para calcular o consumo</div></div><div class="switch ${ui.sheetFull ? 'on' : ''}" id="g-full-switch"></div></div>
    <div class="row2">
      <div class="field"><label>Data</label><input class="input" id="g-date" type="date" min="${s.date < minDate ? s.date : minDate}" value="${s.date}"></div>
      <div class="field"><label>Posto (opcional)</label><input class="input" id="g-note" maxlength="40" placeholder="Ex.: Galp" value="${esc(s.note)}"></div>
    </div>
    <div class="stack">
      <button class="btn primary" data-act="save-fuel">Guardar</button>
      ${sp ? '<button class="btn danger" data-act="del-spend">Eliminar</button>' : ''}
    </div>`);
}

/* Fluxos de senha. Cada passo abre o teclado e passa ao seguinte quando está certo. */
function verifyPin(p, next) {
  pinSheet(`Senha atual`, async v => { if (!(await checkPin(p, v))) return false; next(); return true; });
}
function askNewPin(p, done) {
  pinSheet('Escolhe a nova senha', first => {
    pinSheet('Repete a nova senha', async again => {
      if (again !== first) return false;
      p.pin = await hashPin(first); saveDB(); closeSheet(); render(); toast(done); return true;
    }, 'As senhas não coincidem.');
    return true;
  });
}

function pinSheet(title, onDone, errMsg = 'Senha errada. Tenta outra vez.') {
  let val = '', busy = false;
  const paint = () => document.querySelectorAll('#pin-dots i').forEach((d, i) => d.classList.toggle('f', i < val.length));
  pinSheet.handle = async k => {
    if (busy) return;
    val = k === '⌫' ? val.slice(0, -1) : (val + k).slice(0, 4);
    const e0 = $('#pin-error'); if (e0) e0.textContent = '';
    paint();
    if (val.length === 4) {
      busy = true;
      const ok = await onDone(val);
      if (!ok) {
        const d = $('#pin-dots'); d.classList.add('shake');
        const err = $('#pin-error'); if (err) err.textContent = errMsg;
        setTimeout(() => { d.classList.remove('shake'); val = ''; paint(); busy = false; }, 350);
      }
    }
  };
  // a folha é criada uma só vez; depois só as bolinhas mudam (sem piscar)
  openSheet(`<h2 style="text-align:center">${title}</h2>
    <div class="pin-dots" id="pin-dots"><i></i><i></i><i></i><i></i></div>
    <p id="pin-error" class="pin-error" role="alert"></p>
    <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, '⌫'].map(k => k === '' ? '<span></span>' : `<button data-act="pin-key" data-k="${k}" ${k === '⌫' ? 'aria-label="Apagar"' : ''}>${k === '⌫' ? ico('backspace') : k}</button>`).join('')}</div>`);
}

/* ───────────── 5. EVENTOS ───────────── */
function enterProfile(id) {
  ui.profileId = id; ui.tab = 'home'; ui.firstRun = false;      // abrir um perfil nunca deve herdar o "primeira vez" de outro
  applyTheme(themeOf(current()));                                  // cada perfil tem o seu tema
  const n = new Date(); ui.cal.y = n.getFullYear(); ui.cal.m = n.getMonth(); ui.cal.sel = n.getDate();
  closeSheet(); go('profile');
  notifyDue();
}

/* Ecrã de carregamento ao abrir um perfil (cerca de 2,3 s): cartão com a foto do perfil, anel a rodar, mensagens e barra de progresso.
   O perfil é aberto por baixo enquanto o cartão está à frente, e o cartão desvanece no fim. */
// Onze animações diferentes: a cada abertura sai uma ao acaso (nunca a mesma duas vezes seguidas), com mensagens também variadas.
const LOADERS = ['ring', 'pulse', 'float', 'orbit', 'coins', 'chart', 'lock', 'sparkle', 'radar', 'heart', 'confetti', 'tide', 'piggy', 'neon', 'digits', 'donut', 'shield', 'counter', 'aurora', 'duo', 'ripples', 'bubbles', 'stars', 'comet', 'flip', 'breathe', 'rainbow', 'clock', 'spinner', 'cards', 'petals', 'rays', 'sats', 'bounce', 'finger', 'wifi', 'battery', 'columns', 'euro', 'glass', 'dna', 'cradle', 'gears', 'snow', 'fireflies', 'bolt', 'moneyrain', 'planet', 'squares', 'hexagon', 'marquee', 'shimmer', 'fillrings', 'letters', 'halo', 'wave', 'cube', 'roller', 'drops', 'frame'];
const LOADER_NAMES = { ring: 'Anel', pulse: 'Pulso', float: 'Flutuar', orbit: 'Órbita', coins: 'Moedas', chart: 'Gráfico', lock: 'Cadeado', sparkle: 'Brilhos', radar: 'Radar', heart: 'Coração', confetti: 'Confetes',
  tide: 'Maré', piggy: 'Mealheiro', neon: 'Néon', digits: 'Números', donut: 'Donut', shield: 'Escudo', counter: 'Contador', aurora: 'Aurora' , duo: 'Duplo anel', ripples: 'Ondas', bubbles: 'Bolhas', stars: 'Estrelas', comet: 'Cometa', flip: 'Moeda', breathe: 'Respirar', rainbow: 'Arco-íris', clock: 'Relógio', spinner: 'Pontos', cards: 'Cartas', petals: 'Pétalas', rays: 'Raios', sats: 'Satélites', bounce: 'Saltar', finger: 'Impressão', wifi: 'Sinal', battery: 'Bateria', columns: 'Colunas', euro: 'Euro', glass: 'Ampulheta' , dna: 'Hélice', cradle: 'Pêndulo', gears: 'Engrenagens', snow: 'Neve', fireflies: 'Pirilampos', bolt: 'Arcos Elétricos', moneyrain: 'Chuva de euros', planet: 'Planeta', squares: 'Quadrados', hexagon: 'Hexágono', marquee: 'Comboio', shimmer: 'Reflexo', fillrings: 'Círculos', letters: 'Letras', halo: 'Halo', wave: 'Onda sonora', cube: 'Cubo', roller: 'Montanha-russa', drops: 'Gotas', frame: 'Moldura' };
/* Preferências das animações de entrada (neste aparelho): quais podem sair, o tamanho do ícone do perfil e a velocidade. Abrem-se no laboratório secreto (10 toques no ícone do Konto). */
const LD_DEFAULT = { sel: LOADERS.slice(0, 19),      // as 21 mais recentes vêm desligadas (ligam-se no laboratório)
   size: 96, speed: 1 };
function normLd(o) {
  const sl = Array.isArray(o.sel) ? o.sel.filter(x => LOADERS.includes(x)) : LD_DEFAULT.sel;
  return { sel: sl, size: Math.min(120, Math.max(64, +o.size || 96)), speed: Math.min(2, Math.max(.5, +o.speed || 1)) };
}
function ldPrefs(prof) {                                              // as do perfil (se guardou favoritas), senão as gerais deste aparelho
  if (prof && prof.ldp) return normLd(prof.ldp);
  try { const o = JSON.parse(localStorage.getItem('konto.ldprefs') || 'null'); if (o) return normLd(o); } catch {}
  return { ...LD_DEFAULT };
}
function saveLdPrefs(o) { try { localStorage.setItem('konto.ldprefs', JSON.stringify(o)); } catch {} }
const LD_MSGS = [
  ['A carregar o perfil…', 'A abrir o teu perfil…', 'A preparar o teu espaço…'],
  ['A preparar os teus dados…', 'A organizar as contas…', 'A pôr tudo em ordem…'],
  ['A organizar o calendário…', 'A afinar os gráficos…', 'A dar cor ao teu perfil…', 'Psst… toca 10× no K do início', 'Dica: o K esconde um laboratório'],
  ['Quase pronto…', 'Só mais um instante…', 'A finalizar…'],
];
const pickOf = a => a[Math.floor(Math.random() * a.length)];
function pickLoader(prof) {
  let last = ''; try { last = localStorage.getItem('konto.ld') || ''; } catch {}
  const sel = ldPrefs(prof).sel, pool = sel.length ? sel : LOADERS, v = pickOf(pool.length > 1 ? pool.filter(x => x !== last) : pool);        // só as escolhidas, sem repetir a anterior (se houver mais do que uma)
  try { localStorage.setItem('konto.ld', v); } catch {}
  return v;
}
function loaderParts(kind, prof) {                                    // [parte de cima (volta da foto), indicador por baixo]
  const av = avatarHTML(prof, 'lg');
  const bar = '<div class="ld-bar"><i></i></div>';
  const dots = '<div class="ld-dots"><i></i><i></i><i></i></div>';
  switch (kind) {
    case 'pulse': return [`<div class="ld-ring"><i class="ld-pulse"></i><i class="ld-pulse d2"></i>${av}</div>`, dots];
    case 'float': return [`<div class="ld-ring ld-float">${av}</div>`, '<div class="ld-eq"><i></i><i></i><i></i><i></i><i></i></div>'];
    case 'orbit': return [`<div class="ld-ring"><div class="ld-orbit"><i style="--a:0deg"></i><i style="--a:120deg"></i><i style="--a:240deg"></i></div>${av}</div>`, bar];
    case 'coins': return [`<div class="ld-ring">${av}</div>`, '<div class="ld-coins"><i>€</i><i>€</i><i>€</i></div>'];
    case 'chart': return [`<div class="ld-ring">${av}</div>`, '<svg class="ld-chart" viewBox="0 0 120 44" aria-hidden="true"><path d="M4 38 L26 28 L46 33 L68 14 L90 21 L116 5"/></svg>'];
    case 'lock': return [`<div class="ld-ring">${av}</div>`, '<div class="ld-lock"><svg viewBox="0 0 40 46" aria-hidden="true"><path class="sh" d="M11 21 V15 a9 9 0 0 1 18 0 V21"/><rect class="bd" x="6" y="21" width="28" height="21" rx="5"/><circle class="kh" cx="20" cy="31" r="3"/></svg></div>'];
    case 'sparkle': return [`<div class="ld-ring">${[0, 1, 2, 3, 4, 5].map(i => `<i class="ld-sp" style="--a:${i * 60}deg;--d:${(i * .28).toFixed(2)}s"></i>`).join('')}${av}</div>`, dots];
    case 'radar': return [`<div class="ld-ring"><i class="ld-radar"></i><i class="ld-pulse"></i>${av}</div>`, bar];
    case 'heart': return [`<div class="ld-ring ld-beat">${av}</div>`, '<svg class="ld-ecg" viewBox="0 0 120 40" aria-hidden="true"><path d="M2 22 H34 L42 22 L48 6 L56 36 L62 22 H118"/></svg>'];
    case 'confetti': return [`<div class="ld-ring">${Array.from({ length: 10 }, (_, i) => `<i class="ld-cf" style="--a:${i * 36}deg;--d:${((i % 5) * .12).toFixed(2)}s;--c:${i % 3}"></i>`).join('')}${av}</div>`, dots];
    case 'tide': { const wv = '<svg viewBox="0 0 200 22" preserveAspectRatio="none" aria-hidden="true"><path d="M0 11Q12.5 0 25 11T50 11T75 11T100 11T125 11T150 11T175 11T200 11V22H0Z"/></svg>';
      return [`<div class="ld-ring ld-tide"><div class="tw">${wv}<i></i></div><div class="tw b">${wv}<i></i></div>${av}</div>`, dots]; }
    case 'piggy': return [`<div class="ld-ring">${av}</div>`, '<div class="ld-jar"><svg viewBox="0 0 56 66" aria-hidden="true"><rect class="jf" x="10" y="26" width="36" height="34" rx="6"/><path class="jb" d="M12 7h32M14 7v7l-6 8v32a8 8 0 0 0 8 8h24a8 8 0 0 0 8-8V22l-6-8V7"/></svg><i>€</i><i>€</i><i>€</i></div>'];
    case 'neon': return [`<div class="ld-ring ld-neon"><i class="nr"></i><i class="nr b"></i>${av}</div>`, '<div class="ld-neonline"></div>'];
    case 'digits': return [`<div class="ld-ring ld-matrix">${Array.from({ length: 9 }, (_, i) => `<span class="ld-dg" style="--x:${6 + i * 13}px;--d:${(-((i * 7) % 9) * .35).toFixed(2)}s;--t:${(2.1 + (i % 4) * .35).toFixed(2)}s">${['€', '7', '0', '3', '€', '9', '1'].map((c, k) => (i + k) % 3 === 0 ? '€' : (i * 3 + k * 5) % 10).join('<br>')}</span>`).join('')}${av}</div>`, dots];
    case 'donut': return [`<div class="ld-ring ld-donut"><svg viewBox="0 0 132 132" aria-hidden="true"><circle class="ld-track" cx="66" cy="66" r="62"/>${[['#f97316', 112, 0], ['#6366f1', 78, 122], ['#0ea5e9', 92, 210], ['#10b981', 66, 312]].map(([c, len, off], i) => `<circle class="ld-seg" cx="66" cy="66" r="62" style="--c:${c};--len:${len};--off:${off};--d:${(i * .35).toFixed(2)}s"/>`).join('')}</svg>${av}</div>`, bar];
    case 'shield': return [`<div class="ld-ring">${av}</div>`, '<svg class="ld-shield" viewBox="0 0 40 46" aria-hidden="true"><path pathLength="100" d="M20 3 35 9v13c0 10-7 17-15 21C12 39 5 32 5 22V9z"/><path class="ck" pathLength="100" d="M13 23l5.5 5.5L28 17"/></svg>'];
    case 'counter': return [`<div class="ld-ring">${av}</div>`, '<div class="ld-count"><span class="num">0,00 €</span></div>'];
    case 'aurora': return [`<div class="ld-ring ld-aurora"><i style="--c:var(--accent);--d:0s"></i><i style="--c:var(--accent-2);--d:-1.3s"></i><i style="--c:color-mix(in srgb, var(--accent) 45%, #fff);--d:-2.6s"></i>${av}</div>`, dots];
    case 'duo': return [`<div class="ld-ring ld-x ld-duo"><i></i><i></i>${av}</div>`, bar];
    case 'ripples': return [`<div class="ld-ring ld-x ld-rip"><i></i><i style="--d:.8s"></i><i style="--d:1.6s"></i>${av}</div>`, dots];
    case 'bubbles': return [`<div class="ld-ring ld-x ld-bub">${Array.from({ length: 9 }, (_, k) => `<i style="--x:${8 + k * 10}%;--d:${((k * 5) % 9 * .27).toFixed(2)}s;--s:${6 + (k % 3) * 3}px"></i>`).join('')}${av}</div>`, bar];
    case 'stars': return [`<div class="ld-ring ld-x ld-star">${Array.from({ length: 7 }, (_, k) => `<i style="--a:${k * 51.4}deg;--d:${(k * .22).toFixed(2)}s">✦</i>`).join('')}${av}</div>`, dots];
    case 'comet': return [`<div class="ld-ring ld-x ld-comet"><i></i>${av}</div>`, bar];
    case 'flip': return [`<div class="ld-ring ld-x ld-flip"><i></i>${av}</div>`, dots];
    case 'breathe': return [`<div class="ld-ring ld-x ld-breathe"><i></i>${av}</div>`, dots];
    case 'rainbow': return [`<div class="ld-ring ld-x ld-rainbow"><i></i>${av}</div>`, bar];
    case 'clock': return [`<div class="ld-ring ld-x ld-clock">${Array.from({ length: 12 }, (_, k) => `<i style="--k:${k}"></i>`).join('')}${av}</div>`, bar];
    case 'spinner': return [`<div class="ld-ring ld-x ld-spin8">${Array.from({ length: 8 }, (_, k) => `<i style="--k:${k}"></i>`).join('')}${av}</div>`, dots];
    case 'cards': return [`<div class="ld-ring ld-x ld-cards"><i style="--r:-16deg"></i><i style="--r:12deg"></i><i style="--r:30deg"></i>${av}</div>`, bar];
    case 'petals': return [`<div class="ld-ring ld-x ld-petal">${Array.from({ length: 8 }, (_, k) => `<i style="--a:${k * 45}deg;--d:${(k * .15).toFixed(2)}s"></i>`).join('')}${av}</div>`, dots];
    case 'rays': return [`<div class="ld-ring ld-x ld-rays"><i></i>${av}</div>`, bar];
    case 'sats': return [`<div class="ld-ring ld-x ld-sats"><i></i><i></i>${av}</div>`, dots];
    case 'bounce': return [`<div class="ld-ring ld-x ld-bounce"><i></i>${av}</div>`, dots];
    case 'finger': return [`<div class="ld-ring ld-x ld-fp"><svg viewBox="0 0 100 100" aria-hidden="true"><circle r="47" cx="50" cy="50"/><circle r="40" cx="50" cy="50"/><circle r="33" cx="50" cy="50"/></svg>${av}</div>`, bar];
    case 'wifi': return [`<div class="ld-ring">${av}</div>`, '<svg class="ld-wifi" viewBox="0 0 40 32" aria-hidden="true"><path d="M3 12a24 24 0 0 1 34 0"/><path d="M9 18a15 15 0 0 1 22 0"/><path d="M14.5 24a7.5 7.5 0 0 1 11 0"/><circle cx="20" cy="29" r="2"/></svg>'];
    case 'battery': return [`<div class="ld-ring">${av}</div>`, '<div class="ld-batt"><i></i></div>'];
    case 'columns': return [`<div class="ld-ring">${av}</div>`, `<div class="ld-cols">${[.35, .55, .8, .6, 1].map((h, k) => `<i style="--h:${h};--d:${(k * .12).toFixed(2)}s"></i>`).join('')}</div>`];
    case 'euro': return [`<div class="ld-ring">${av}</div>`, '<div class="ld-eur"><i>€</i></div>'];
    case 'glass': return [`<div class="ld-ring">${av}</div>`, '<svg class="ld-glass" viewBox="0 0 40 52" aria-hidden="true"><g class="hg"><path class="o" d="M8 4h24M8 48h24M10 4c0 14 8 16 10 22-2 6-10 8-10 22M30 4c0 14-8 16-10 22 2 6 10 8 10 22"/><path class="t" d="M12 7h16c-1 8-6 11-8 15-2-4-7-7-8-15z"/><path class="b" d="M20 30c-2 5-7 7-8 14h16c-1-7-6-9-8-14z"/></g></svg>'];
    case 'dna': return [`<div class="ld-ring">${av}</div>`, `<div class="ld-dna">${Array.from({ length: 9 }, (_, k) => `<i style="--k:${k}"></i>`).join('')}</div>`];
    case 'cradle': return [`<div class="ld-ring">${av}</div>`, '<div class="ld-cradle"><i></i><i></i><i></i><i></i><i></i></div>'];
    case 'gears': return [`<div class="ld-ring ld-x ld-gear"><i></i><i></i>${av}</div>`, bar];
    case 'snow': return [`<div class="ld-ring ld-x ld-snow">${Array.from({ length: 10 }, (_, k) => `<i style="--x:${4 + k * 10}%;--d:${((k * 7) % 10 * .22).toFixed(2)}s;--s:${11 + (k % 3) * 4}px">❄</i>`).join('')}${av}</div>`, dots];
    case 'fireflies': return [`<div class="ld-ring ld-x ld-ff">${Array.from({ length: 9 }, (_, k) => `<i style="--x:${10 + (k * 37) % 80}%;--y:${8 + (k * 53) % 84}%;--dx:${(k % 3 - 1) * 14}px;--dy:${((k + 1) % 3 - 1) * 14}px;--d:${(k * .33).toFixed(2)}s"></i>`).join('')}${av}</div>`, dots];
    case 'bolt': return [`<div class="ld-ring ld-x ld-bl"><i></i><i></i>${av}</div>`, bar];
    case 'moneyrain': return [`<div class="ld-ring ld-x ld-snow ld-mrain">${Array.from({ length: 8 }, (_, k) => `<i style="--x:${6 + k * 12}%;--d:${((k * 5) % 8 * .2).toFixed(2)}s;--s:${13 + (k % 3) * 3}px">€</i>`).join('')}${av}</div>`, bar];
    case 'planet': return [`<div class="ld-ring ld-x ld-planet"><i></i>${av}</div>`, dots];
    case 'squares': return [`<div class="ld-ring ld-x ld-sq"><i></i><i></i>${av}</div>`, bar];
    case 'hexagon': return [`<div class="ld-ring ld-x ld-hex"><i></i>${av}</div>`, bar];
    case 'marquee': return [`<div class="ld-ring">${av}</div>`, '<div class="ld-march"><i></i><i style="--d:.25s"></i><i style="--d:.5s"></i><i style="--d:.75s"></i></div>'];
    case 'shimmer': return [`<div class="ld-ring">${av}</div>`, '<div class="ld-shim"></div>'];
    case 'fillrings': return [`<div class="ld-ring">${av}</div>`, `<div class="ld-frs">${[0, 1, 2].map(k => `<svg viewBox="0 0 24 24" style="--d:${(k * .55).toFixed(2)}s" aria-hidden="true"><circle class="t" cx="12" cy="12" r="9"/><circle class="f" cx="12" cy="12" r="9"/></svg>`).join('')}</div>`];
    case 'letters': return [`<div class="ld-ring">${av}</div>`, `<div class="ld-ltr">${'Konto'.split('').map((c, k) => `<i style="--k:${k}">${c}</i>`).join('')}</div>`];
    case 'halo': return [`<div class="ld-ring ld-x ld-halo"><i></i>${av}</div>`, dots];
    case 'wave': return [`<div class="ld-ring">${av}</div>`, '<svg class="ld-sine" viewBox="0 0 120 26" aria-hidden="true"><path d="M0 13Q15-1 30 13T60 13T90 13T120 13T150 13T180 13T210 13T240 13"/></svg>'];
    case 'cube': return [`<div class="ld-ring">${av}</div>`, '<div class="ld-cube"><div class="c"><i></i><i></i><i></i><i></i><i></i><i></i></div></div>'];
    case 'roller': return [`<div class="ld-ring">${av}</div>`, '<div class="ld-roll"><svg viewBox="0 0 120 30" aria-hidden="true"><path d="M0 15Q15-5 30 15T60 15T90 15T120 15"/></svg><i></i></div>'];
    case 'drops': return [`<div class="ld-ring ld-x ld-drop">${[18, 50, 82].map((x, k) => `<i class="d" style="--x:${x}%;--d:${(k * .55).toFixed(2)}s"></i><i class="r" style="--x:${x}%;--d:${(k * .55).toFixed(2)}s"></i>`).join('')}${av}</div>`, dots];
    case 'frame': return [`<div class="ld-ring ld-x ld-frame"><i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i>${av}</div>`, bar];
    default: return [`<div class="ld-ring"><svg viewBox="0 0 132 132" aria-hidden="true"><circle class="ld-track" cx="66" cy="66" r="62"/><circle class="ld-arc" cx="66" cy="66" r="62"/></svg>${av}</div>`, bar];
  }
}
function openWithLoading(prof, forceKind) {
  if (ui.loading) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return enterProfile(prof.id);
  ui.loading = true;
  applyTheme(themeOf(prof));                                         // já com as cores do perfil que vai abrir
  closeSheet();                                                      // a janela da senha, se houver
  const kind = forceKind || pickLoader(prof), [top, ind] = loaderParts(kind, prof), msgs = LD_MSGS.map(pickOf);
  const ov = document.createElement('div'); ov.className = 'ld'; ov.dataset.loader = kind;
  ov.setAttribute('role', 'status'); ov.setAttribute('aria-live', 'polite');
  ov.innerHTML = `<div class="ld-card">
      ${top}
      <h2>${esc(prof.name)}</h2>
      <p class="ld-msg">${msgs[0]}</p>
      ${ind}
      <div class="ld-brand">Konto</div>
    </div>`;
  document.body.appendChild(ov); applyLdLook(ov, ldPrefs(prof));
  const msg = ov.querySelector('.ld-msg');
  msgs.slice(1).forEach((t, i) => setTimeout(() => { msg.textContent = t; msg.classList.remove('swap'); void msg.offsetWidth; msg.classList.add('swap'); }, 650 * (i + 1)));
  setTimeout(() => enterProfile(prof.id), 350);                      // o trabalho a sério, por baixo do cartão
  setTimeout(() => { ov.classList.add('out'); setTimeout(() => { ov.remove(); ui.loading = false; }, 480); }, 2300);
}

/* O aspeto das animações de entrada (tamanho do ícone do perfil, velocidade) e o contador, que precisa de um pouco de JS. */
function applyLdLook(root, pr) {
  pr = pr || ldPrefs();
  root.style.setProperty('--ld-av', pr.size + 'px');
  requestAnimationFrame(() => { for (const a of root.getAnimations({ subtree: true })) a.playbackRate = pr.speed; });
  root.querySelectorAll('.ld-count').forEach(el => {
    const num = el.querySelector('.num'), t0 = performance.now(); let target = 900 + Math.random() * 2400, lap = 0;
    (function tick(now) {
      if (!el.isConnected) return;
      const k = ((now - t0) * pr.speed / 1900), l = Math.floor(k), f = k - l;
      if (l !== lap) { lap = l; target = 900 + Math.random() * 2400; }
      num.textContent = nf(target * (1 - Math.pow(1 - Math.min(1, f / .8), 3))) + ' €';
      requestAnimationFrame(tick);
    })(t0);
  });
}
/* Laboratório secreto: 10 toques no ícone do Konto (ecrã de boas-vindas). O ícone aproxima-se, treme e expande até ocupar a janela; lá dentro escolhes
   quais animações de entrada podem aparecer, o tamanho do ícone do perfil e a velocidade. Tudo fica guardado neste aparelho. */
const egg = { n: 0, t: 0, busy: false };
document.addEventListener('click', e => {
  const logo = e.target.closest?.('.logo'); if (!logo || egg.busy || document.querySelector('.lab, .egg')) return;
  const now = Date.now(); egg.n = now - egg.t < 1600 ? egg.n + 1 : 1; egg.t = now;
  logo.animate([{ transform: 'scale(1)' }, { transform: 'scale(.9)' }, { transform: 'scale(1)' }], { duration: 160 });         // um pequeno toque a cada clique
  if (egg.n >= 10) { egg.n = 0; startLab(logo); }
});
async function startLab(logo) {
  egg.busy = true;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { openLab(); egg.busy = false; return; }
  const r = logo.getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
  const ov = document.createElement('div'); ov.className = 'egg';
  const ic = logo.cloneNode(true); ic.className = 'logo egg-ic';
  Object.assign(ic.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', margin: '0', zIndex: '2' });
  ov.appendChild(ic); document.body.appendChild(ov); logo.style.visibility = 'hidden';
  const dx = vw / 2 - (r.left + r.width / 2), dy = vh / 2 - (r.top + r.height / 2), fin = { fill: 'forwards' };
  await ov.animate([{ background: 'rgba(0,0,0,0)' }, { background: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0b0b0c' }], { duration: 420, ...fin }).finished;      // esconde o resto da página
  await ic.animate([{ transform: 'translate(0,0) scale(1)' }, { transform: `translate(${dx}px, ${dy}px) scale(2.3)` }], { duration: 620, easing: 'cubic-bezier(.2,.8,.2,1)', ...fin }).finished;      // zoom
  const base = `translate(${dx}px, ${dy}px) scale(2.3)`;
  await ic.animate(Array.from({ length: 25 }, (_, i) => { const k = i / 24, amp = 2 + k * 9, sg = i % 2 ? 1 : -1;
    return { transform: `${base} rotate(${(sg * amp * (.6 + (i % 3) * .2)).toFixed(1)}deg) translateX(${(-sg * amp * .5).toFixed(1)}px)`, offset: k }; }), { duration: 1250, easing: 'linear', ...fin }).finished;      // abana e treme
  const lab = openLab();
  await burst(ov, ic, lab, vw / 2, vh / 2);                  // o ícone estala em partículas e mostra o laboratório
  ov.remove(); logo.style.visibility = ''; egg.busy = false;
}
async function burst(ov, ic, lab, cx, cy) {
  const vw = innerWidth, vh = innerHeight, maxR = Math.hypot(Math.max(cx, vw - cx), Math.max(cy, vh - cy)), fin = { fill: 'forwards' };
  const fx = document.createElement('div'); Object.assign(fx.style, { position: 'fixed', inset: '0', zIndex: '10002', pointerEvents: 'none', overflow: 'hidden' }); document.body.appendChild(fx);
  lab.style.zIndex = '10001'; lab.style.opacity = '';
  ic.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 80, ...fin });
  for (let i = 0; i < 30; i++) {
    const a = Math.random() * Math.PI * 2, d = (.25 + Math.random() * .65) * maxR, sz = 8 + Math.random() * 7, q = document.createElement('div');
    Object.assign(q.style, { position: 'absolute', left: cx - sz / 2 + 'px', top: cy - sz / 2 + 'px', width: sz + 'px', height: sz + 'px', borderRadius: '2px', background: 'linear-gradient(135deg,#34d399,#6366f1)' }); fx.appendChild(q);
    q.animate([{ transform: 'translate(0,0) rotate(0)', opacity: 1 }, { transform: `translate(${Math.cos(a) * d}px, ${Math.sin(a) * d}px) rotate(${Math.round(Math.random() * 500 - 250)}deg)`, opacity: 0 }], { duration: 900, easing: 'cubic-bezier(.1,.7,.3,1)', ...fin });
  }
  await lab.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 550, delay: 150, fill: 'both' }).finished; await new Promise(r => setTimeout(r, 400));
  lab.getAnimations().forEach(a => a.cancel()); lab.style.zIndex = ''; lab.style.opacity = ''; fx.remove();
}
function openLab() {
  const g = ldPrefs(), sel = new Set(g.sel); let cur = '', size = g.size, speed = g.speed;
  const lab = document.createElement('div'); lab.className = 'lab'; lab.setAttribute('role', 'dialog'); lab.setAttribute('aria-label', 'Animações de entrada');
  const tile = k => `<button type="button" class="lab-tile${sel.has(k) ? ' on' : ''}" data-id="${k}" aria-pressed="${sel.has(k)}"><div class="lab-prev" data-loader="${k}"><div class="lab-s">${loaderParts(k, { name: 'K' }).join('')}</div></div><span>${LOADER_NAMES[k]}</span><i class="lab-chk">${ico('check')}</i></button>`;
  const profs = (db.profiles || []);
  lab.innerHTML = `<div class="lab-head"><button type="button" class="lab-back" aria-label="Fechar">${ico('left')}</button><div><h2>Animações de entrada</h2><p>Toca para ligar ou desligar. Só as ligadas aparecem ao abrir um perfil.</p></div></div>
    ${profs.length ? `<h3 class="lab-sec">Perfil</h3><div class="lab-chips" id="lab-profs"><button type="button" class="lab-pchip on" data-p="">Geral</button>${profs.map(p => `<button type="button" class="lab-pchip" data-p="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>
    <p class="lab-hint" id="lab-phint">Estas são as escolhas gerais, usadas por todos os perfis que não tenham favoritas.</p>` : ''}
    <div class="lab-grid">${LOADERS.map(tile).join('')}</div>
    <div class="lab-ctl"><div class="lab-row"><label for="lab-size">Tamanho do ícone</label><b id="lab-size-v">${size}</b></div><input type="range" id="lab-size" class="lab-range" min="64" max="120" step="4" value="${size}">
      <div class="lab-row"><label for="lab-speed">Velocidade</label><b id="lab-speed-v">${String(speed).replace('.', ',')}×</b></div><input type="range" id="lab-speed" class="lab-range" min="0.5" max="2" step="0.25" value="${speed}">
      <button type="button" class="btn ghost lab-reset" id="lab-reset">Redefinir sliders</button></div>
    <div class="lab-act"><button type="button" class="btn ghost" id="lab-all">Ligar todas</button><button type="button" class="btn ghost" id="lab-none">Desligar todas</button><button type="button" class="btn primary" id="lab-test">Experimentar</button></div>
    <div class="lab-act" id="lab-pact" hidden><button type="button" class="btn ghost" id="lab-pclear">Usar as gerais</button><button type="button" class="btn primary" id="lab-psave">Guardar neste perfil</button></div>`;
  document.body.appendChild(lab); applyLdLook(lab, { size, speed });
  const cfg = () => ({ sel: LOADERS.filter(k => sel.has(k)), size, speed });
  const save = () => { if (!cur) saveLdPrefs(cfg()); };               // com um perfil escolhido, é um rascunho até carregares em "Guardar neste perfil"
  const paint = () => {
    lab.querySelectorAll('.lab-tile').forEach(t => { const on = sel.has(t.dataset.id); t.classList.toggle('on', on); t.setAttribute('aria-pressed', on); });
    lab.querySelector('#lab-size').value = size; lab.querySelector('#lab-size-v').textContent = size;
    lab.querySelector('#lab-speed').value = speed; lab.querySelector('#lab-speed-v').textContent = String(speed).replace('.', ',') + '×';
    applyLdLook(lab, { size, speed });
  };
  const choose = id => {                                               // muda de perfil: carrega as favoritas dele (ou as gerais)
    cur = id; const pf = profs.find(p => p.id === id), pr = ldPrefs(pf);
    lab.querySelectorAll('.lab-tile').forEach(t => { t.querySelector('.lab-s').innerHTML = loaderParts(t.dataset.id, pf || { name: 'K' }).join(''); });      // a foto do perfil no lugar do K
    sel.clear(); pr.sel.forEach(k => sel.add(k)); size = pr.size; speed = pr.speed;
    lab.querySelectorAll('.lab-pchip').forEach(c => c.classList.toggle('on', c.dataset.p === id));
    const act = lab.querySelector('#lab-pact'); if (act) act.hidden = !pf;
    const hint = lab.querySelector('#lab-phint');
    if (hint) hint.textContent = pf ? (pf.ldp ? `Favoritas de ${pf.name}. Mexe e carrega em "Guardar" para as atualizar.` : `${pf.name} usa as escolhas gerais. Mexe e carrega em "Guardar" para ter as suas.`) : 'Estas são as escolhas gerais, usadas por todos os perfis que não tenham favoritas.';
    const sv = lab.querySelector('#lab-psave'); if (sv && pf) sv.textContent = `Guardar em ${pf.name}`;
    const cl = lab.querySelector('#lab-pclear'); if (cl && pf) cl.hidden = !pf.ldp;
    paint();
  };
  lab.addEventListener('click', e => {
    const pc = e.target.closest('.lab-pchip'); if (pc) return choose(pc.dataset.p);
    if (e.target.closest('#lab-psave')) { const pf = profs.find(p => p.id === cur); if (!pf) return; pf.ldp = cfg(); saveDB(); lab.querySelector('#lab-pclear').hidden = false; lab.querySelector('#lab-phint').textContent = `Favoritas de ${pf.name} guardadas.`; return toast(`Guardado em ${pf.name}`); }
    if (e.target.closest('#lab-pclear')) { const pf = profs.find(p => p.id === cur); if (!pf) return; pf.ldp = null; saveDB(); choose(cur); return toast(`${pf.name} volta a usar as gerais`); }
    if (e.target.closest('#lab-reset')) { size = 96; speed = 1; paint(); save(); return; }
    const t = e.target.closest('.lab-tile');
    if (t) {
      if (sel.has(t.dataset.id) && sel.size === 1) return toast('Fica pelo menos uma ligada');
      sel.has(t.dataset.id) ? sel.delete(t.dataset.id) : sel.add(t.dataset.id); paint(); save(); return;
    }
    if (e.target.closest('#lab-none')) { const keep = LOADERS.find(k => sel.has(k)) || LOADERS[0]; sel.clear(); sel.add(keep); paint(); save(); return toast('Fica pelo menos uma ligada'); }
    if (e.target.closest('#lab-all')) { LOADERS.forEach(k => sel.add(k)); paint(); save(); return; }
    if (e.target.closest('#lab-test')) return testLoader(sel, { size, speed }, profs.find(p => p.id === cur));
    if (e.target.closest('.lab-back')) { const an = lab.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, fill: 'forwards' }); an.onfinish = () => lab.remove(); }
  });
  lab.addEventListener('input', e => {
    if (e.target.id !== 'lab-size' && e.target.id !== 'lab-speed') return;
    size = +lab.querySelector('#lab-size').value; speed = +lab.querySelector('#lab-speed').value;
    lab.querySelector('#lab-size-v').textContent = size; lab.querySelector('#lab-speed-v').textContent = String(speed).replace('.', ',') + '×';
    save(); applyLdLook(lab, { size, speed });
  });
  return lab;
}
function testLoader(sel, look, prof) {                                     // mostra uma animação de entrada de verdade (das ligadas), sem abrir nenhum perfil
  if (document.querySelector('.ld')) return;
  const pool = [...sel], kind = pickOf(pool), [top, ind] = loaderParts(kind, prof || { name: 'K' });
  const ov = document.createElement('div'); ov.className = 'ld'; ov.dataset.loader = kind; ov.style.zIndex = '10001';
  ov.innerHTML = `<div class="ld-card">${top}<h2>${prof ? esc(prof.name) : LOADER_NAMES[kind]}</h2><p class="ld-msg">A experimentar…</p>${ind}<div class="ld-brand">Konto</div></div>`;
  document.body.appendChild(ov); applyLdLook(ov, look);
  setTimeout(() => { ov.classList.add('out'); setTimeout(() => ov.remove(), 480); }, 2300);
}

async function notifyDue() {
  const p = current(); if (!p || !('Notification' in window) || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker?.getRegistration();
  dueReminders(p).forEach(r => reg?.showNotification('Konto · lembrete', { body: `${r.sub.name} cobra ${whenText(r.days)} (${cost(r.amount)})`, icon: 'icon.svg', tag: r.sub.id }));
}

const parseAmount = v => parseFloat(String(v).replace(',', '.'));

/* Seletores (.seg): o fundo do botão escolhido é um destaque que desliza de um botão para o outro.
   syncSegs mede o botão ativo; um observador chama-o sempre que o ecrã ou a escolha mudam. */
function syncSegs() {
  fitPagers();
  document.querySelectorAll('.seg').forEach(seg => {
    const b = seg.querySelector('button.on'); if (!b || !b.offsetWidth) return;
    seg.style.setProperty('--sx', b.offsetLeft + 'px'); seg.style.setProperty('--sw', b.offsetWidth + 'px');
    if (!seg.classList.contains('ready')) setTimeout(() => seg.classList.add('ready'), 60);    // só anima depois da primeira posição
  });
}
/* Barra de baixo: um traço por cima do separador ativo desliza de um para o outro (mesma técnica dos seletores). */
const NAV_IND_W = 30;
function placeNavInd(btn) {                          // põe a barra por baixo de um botão da barra de baixo (a transição trata do deslize)
  const ind = document.getElementById('nav-ind'); if (!ind || !btn) return;
  const r = btn.getBoundingClientRect();
  ind.style.transform = `translateX(${Math.round(r.left + (r.width - NAV_IND_W) / 2)}px)`;
}
function syncNav() {                                  // garante que a barra está sob o separador ativo (arranque, módulos que mudam, rodar o ecrã…)
  const ind = document.getElementById('nav-ind'); if (!ind) return;
  const b = document.querySelector('.nav button.on');
  if (!b || !b.offsetWidth) { ind.style.display = 'none'; ind.classList.remove('ready'); return; }   // sem barra de baixo (outros ecrãs): esconde e recomeça limpa
  const first = ind.style.display !== 'block';
  ind.style.display = 'block'; placeNavInd(b);
  if (first) { void ind.offsetWidth; setTimeout(() => ind.classList.add('ready'), 60); }              // a primeira posição é imediata; só depois passa a deslizar
}
function goTab(tab) {                                 // mudar de separador: a barra começa a deslizar JÁ, antes de o ecrã novo ser desenhado, e o ícone "faz a sua gracinha"
  const same = ui.tab === tab;
  if (!same) placeNavInd(document.querySelector(`.nav button[data-tab="${tab}"]`) || document.querySelector('.nav button[data-tab="more"]'));
  ui.tab = tab; ui.spendDays = 10; ui.fuelLimit = 10; ui.shopLimit = 10; ui.firstRun = false; render();
  syncNav();
  const b = document.querySelector('.nav button.on');
  if (b && !same) { b.classList.add('just'); setTimeout(() => b.classList.remove('just'), 700); }
}

/* Animações contínuas (capa e cartões de total): quando o ecrã se redesenha, o elemento é novo e a animação recomeçava do zero ("reset").
   Cada animação nova é posta na fase do relógio geral, por isso continua de onde ia. */
const animsDone = new WeakSet();
function syncAnims() {
  decorateTotals();                                                 // cartões novos (o ecrã redesenha-se) ganham a camada do estilo animado antes de se alinhar a fase
  document.querySelectorAll('.big-total, .cover.anim').forEach(el => {
    for (const a of el.getAnimations({ subtree: true })) {          // inclui a camada .cv e o pseudo-elemento ::before dos cartões
      if (!a.animationName || animsDone.has(a)) continue;
      animsDone.add(a);
      const t = a.effect?.getComputedTiming?.(); if (!t || t.iterations !== Infinity || !t.duration) continue;     // só as contínuas; as de entrada não
      const cycle = t.duration * (/alternate/.test(t.direction) ? 2 : 1);
      a.currentTime = performance.now() % cycle;
      const sp = fxSpeed(appliedTheme); if (sp !== 1) a.playbackRate = sp;
    }
  });
}
function applySpeed() {                                           // chamado quando o cursor da velocidade mexe: ajusta já as animações que estão a correr
  const sp = fxSpeed(appliedTheme);
  document.querySelectorAll('.big-total, .cover.anim').forEach(el => {
    for (const a of el.getAnimations({ subtree: true })) {
      if (!a.animationName) continue;
      const t = a.effect?.getComputedTiming?.(); if (!t || t.iterations !== Infinity) continue;
      if (a.playbackRate !== sp) a.updatePlaybackRate(sp);
    }
  });
}
// Cursores "Velocidade" e "Quantidade de efeitos" da janela de aparência: aplicam-se enquanto se arrasta e guardam-se ao largar.
let fxQueued = false;
document.addEventListener('input', e => {
  const r = e.target.closest?.('[data-fx]'); if (!r) return;
  const p = current(); if (!p) return;
  const key = r.dataset.fx, v = +r.value;
  p.theme = { ...themeOf(p), [key]: v };
  const lab = r.parentElement.querySelector('.fx-val'); if (lab) lab.textContent = key === 'speed' ? fxSpeedLabel(v) : FX_AMOUNT[v - 1];
  if (fxQueued) return; fxQueued = true;
  requestAnimationFrame(() => {
    fxQueued = false;
    const th = themeOf(current());
    applyTheme(th); applySpeed();
    refreshPreviews(th);                                         // as miniaturas também mostram a quantidade escolhida
  });
});
document.addEventListener('change', e => { if (e.target.closest?.('[data-fx]')) saveDB(); });
/* Cursores (velocidade e quantidade): só se mexem se agarrares no botão redondo e arrastares para os lados. Tocar na barra, ou arrastar para cima e para baixo
   (para fazer scroll), já não muda nada. Por isso o <input> não recebe toques (pointer-events: none) e este código trata do gesto. */
let fxDrag = null;
document.addEventListener('pointerdown', e => {
  const box = e.target.closest?.('.fx-in'); if (!box) return;
  const r = box.querySelector('.fx-range'); if (!r) return;
  const b = r.getBoundingClientRect(), min = +r.min, max = +r.max, tw = 22, usable = b.width - tw;
  const cx = b.left + tw / 2 + (+r.value - min) / (max - min) * usable;
  if (Math.abs(e.clientX - cx) > 26 || Math.abs(e.clientY - (b.top + b.height / 2)) > 22) return;      // fora do botão: não faz nada (o toque serve para o scroll)
  fxDrag = { id: e.pointerId, r, min, max, step: +r.step || 1, left: b.left + tw / 2, usable, off: e.clientX - cx, x0: e.clientX, y0: e.clientY, on: false, box };
});
document.addEventListener('pointermove', e => {
  const d = fxDrag; if (!d || e.pointerId !== d.id) return;
  if (!d.on) {                                                                 // decide cedo: gesto para os lados = mexer no cursor; vertical = deixa fazer scroll
    const dx = Math.abs(e.clientX - d.x0), dy = Math.abs(e.clientY - d.y0);
    if (dy > 8 && dy > dx) { fxDrag = null; return; }
    if (dx < 4) return;
    d.on = true; try { d.box.setPointerCapture(e.pointerId); } catch {}
  }
  const t = Math.max(0, Math.min(1, (e.clientX - d.off - d.left) / d.usable));
  const v = Math.round((d.min + t * (d.max - d.min)) / d.step) * d.step;
  if (+d.r.value !== v) { d.r.value = v; d.r.dispatchEvent(new Event('input', { bubbles: true })); }
});
const endFxDrag = e => { const d = fxDrag; if (!d || (e && e.pointerId !== d.id)) return; fxDrag = null; if (d.on) d.r.dispatchEvent(new Event('change', { bubbles: true })); };
document.addEventListener('pointerup', endFxDrag); document.addEventListener('pointercancel', endFxDrag);
/* O observador só acorda para o que lhe interessa (seletores, barra de baixo, capa e cartões de total) e mede tudo de uma vez, no fotograma seguinte,
   para não forçar cálculos de layout a meio de uma animação. */
/* Cartões de total em 3D: ao tocar e arrastar, o cartão inclina-se para onde está o dedo, em tempo real; ao largar, volta devagar à posição.
   O CSS usa touch-action: pan-y, por isso o scroll vertical da página continua a funcionar (o browser cancela o gesto e o cartão volta ao sítio). */
(() => {
  let el = null, raf = 0, nx = 0, ny = 0;
  const apply = () => {
    raf = 0; if (!el) return;
    el.style.setProperty('--ry', (nx * 14).toFixed(2) + 'deg'); el.style.setProperty('--rx', (-ny * 12).toFixed(2) + 'deg');
    el.style.setProperty('--px', nx.toFixed(3)); el.style.setProperty('--py', ny.toFixed(3)); el.style.setProperty('--gl', '1');
  };
  const track = e => {
    const r = el.getBoundingClientRect();
    nx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width - .5) * 2)); ny = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height - .5) * 2));
    if (!raf) raf = requestAnimationFrame(apply);
  };
  const end = () => {
    if (!el) return;
    const c = el; el = null; cancelAnimationFrame(raf); raf = 0; c.classList.remove('tilting');
    for (const k of ['--rx', '--ry', '--px', '--py', '--gl']) c.style.removeProperty(k);
  };
  document.addEventListener('pointerdown', e => { const c = e.target.closest?.('.big-total'); if (!c || e.target.closest('button, a, input, select, .seg')) return; el = c; c.classList.add('tilting'); track(e); }, { passive: true });
  document.addEventListener('pointermove', e => { if (el) track(e); }, { passive: true });
  document.addEventListener('pointerup', end, { passive: true }); document.addEventListener('pointercancel', end, { passive: true });
})();
const WATCH = '.seg, .nav, .big-total, .cover';
let segQueued = false;
const queueSync = () => {
  if (segQueued) return; segQueued = true;
  requestAnimationFrame(() => { segQueued = false; syncSegs(); syncNav(); syncAnims(); });
};
new MutationObserver(muts => {
  for (const m of muts) {
    const t = m.target;
    if (t.nodeType === 1 && (t === document.documentElement || t.closest?.(WATCH))) return queueSync();
    for (const n of m.addedNodes) if (n.nodeType === 1 && (n.matches?.(WATCH) || n.querySelector?.(WATCH))) return queueSync();
  }
}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
addEventListener('resize', () => { syncSegs(); syncNav(); });

/* Caixa de confirmação estilizada (substitui o confirm() do sistema). Devolve uma Promise: true = confirmou, false = cancelou. */
function askConfirm({ title, text = '', ok = 'Confirmar', cancel = 'Cancelar', danger = false, icon = 'warn' }) {
  return new Promise(resolve => {
    const root = document.createElement('div');
    root.className = 'dlg-overlay';
    root.innerHTML = `<div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t">
      <div class="dlg-ic ${danger ? 'danger' : ''}">${ico(icon)}</div>
      <h3 id="dlg-t">${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}
      <div class="dlg-btns"><button class="btn ghost" data-dlg="0">${esc(cancel)}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-dlg="1">${esc(ok)}</button></div></div>`;
    const finish = v => {
      document.removeEventListener('keydown', onKey, true);
      root.classList.add('out'); setTimeout(() => root.remove(), 180); syncModalLock(); resolve(v);
    };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); finish(false); } };
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-dlg]');
      if (b) finish(b.dataset.dlg === '1'); else if (e.target === root) finish(false);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(root); syncModalLock();
    root.querySelector('[data-dlg="0"]')?.focus();
  });
}

/* Transição entre o ecrã de boas-vindas e o resto: um círculo da cor do tema abre a partir do botão e cobre o ecrã;
   troca-se de ecrã por baixo; depois desvanece (ida) ou fecha-se dentro do botão "Começar" (volta, se `settleSel` existir). */
function wipe(fromEl, change, settleSel) {
  if (ui.leaving) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return change();
  ui.leaving = true;
  const r = fromEl.getBoundingClientRect(), ov = document.createElement('div');
  ov.className = 'reveal';
  ov.style.cssText = `left:${r.left + r.width / 2}px;top:${r.top + r.height / 2}px;--s:${(Math.hypot(innerWidth, innerHeight) * 2.1 / 20).toFixed(1)}`;   // chega para cobrir o ecrã a partir de qualquer ponto
  document.body.appendChild(ov); document.querySelector('.screen')?.classList.add('leaving');
  requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add('go')));
  const done = ms => setTimeout(() => { ov.remove(); ui.leaving = false; }, ms);
  setTimeout(() => {
    change();
    const t = settleSel && document.querySelector(settleSel);
    if (t) {                                                      // volta: o círculo encolhe para dentro do botão
      const b = t.getBoundingClientRect();
      ov.style.transition = 'none'; ov.style.left = `${b.left + b.width / 2}px`; ov.style.top = `${b.top + b.height / 2}px`;
      void ov.offsetWidth; ov.style.transition = ''; ov.classList.remove('go'); done(580);
    } else { ov.classList.add('out'); done(540); }
  }, 520);
}

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  if (Date.now() - swipedAt < 400 && el.closest('#summary, .pager')) return;               // o fim de um deslize não conta como toque
  const act = el.dataset.act, p = current();
  switch (act) {
    case 'start': wipe(el, () => go(db.profiles.length ? 'picker' : 'ask')); break;
    case 'new-profile': go('form', { draft: { name: '', pin: '', avatar: '', handle: '', handleTouched: false } }); break;
    case 'skip-profile': {
      const prof = newProfile({ name: 'Eu', handle: uniqueHandle('eu'), avatar: '', pin: null });
      db.profiles.push(prof); saveDB(); applyTheme(DEFAULT_THEME); ui.firstRun = true; ui.profileId = prof.id; ui.tab = 'manage'; go('profile'); break;
    }
    case 'to-picker': go('picker'); break;
    case 'logout': {                                                 // sair / trocar de perfil: pede confirmação
      const swap = el.dataset.kind === 'swap';
      if (!await askConfirm({ title: swap ? 'Trocar de perfil?' : 'Sair do perfil?', icon: swap ? 'swap' : 'logout', ok: swap ? 'Trocar' : 'Sair', cancel: 'Ficar',
        text: swap ? 'Voltas ao menu para escolheres outro perfil. Os dados deste ficam guardados.' : 'Voltas ao menu de perfis. Os teus dados ficam guardados.' })) break;
      go('picker'); break;
    }
    case 'theme-anim':
      p.theme = { ...themeOf(p), anim: !themeOf(p).anim }; applyTheme(p.theme); saveDB();
      $('#anim-switch').classList.toggle('on', !!p.theme.anim);
      $('#fx-panel')?.classList.toggle('anim-on', !!p.theme.anim); break;
    case 'theme-day':
      p.theme = { ...themeOf(p), day: el.dataset.v }; applyTheme(p.theme); saveDB();
      document.querySelectorAll('[data-act=theme-day]').forEach(b => b.classList.toggle('on', b === el)); break;
    case 'theme-cardstyle':
      p.theme = { ...themeOf(p), cardStyle: !themeOf(p).cardStyle }; applyTheme(p.theme); saveDB();
      $('#cardstyle-switch').classList.toggle('on', !!p.theme.cardStyle); break;
case 'pg': { const k = el.dataset.k; goPage(k, el.dataset.to !== undefined ? +el.dataset.to : (ui.page?.[k] || 0) + +el.dataset.d); break; }     // páginas das cores e dos estilos
    case 'data-guide': dataGuideSheet(); break;
    case 'hide-ios-hint': try { localStorage.setItem('konto.hint.ios', '1'); } catch {} render(); break;
    case 'go-appearance': appearanceSheet(p); break;                // janela rápida da aparência, a partir do Início
    case 'close-btn': dismissSheet(); break;
    case 'to-welcome': wipe(el, () => go('welcome'), '[data-act=start]'); break;                        // o ponto de partida do Konto
    case 'theme-pal': case 'theme-style': case 'theme-mode': case 'theme-cal': {       // o tema aplica-se logo e fica guardado neste perfil
      const key = act === 'theme-pal' ? 'palette' : act === 'theme-style' ? 'style' : act === 'theme-cal' ? 'cal' : 'mode';
      p.theme = { ...themeOf(p), [key]: el.dataset.v }; applyTheme(p.theme, { animate: act === 'theme-mode', from: el }); saveDB();
      document.querySelectorAll(`[data-act=${act}]`).forEach(b => b.classList.toggle('on', b === el));
      refreshPreviews(themeOf(p));                                               // as pré-visualizações seguem a cor e o estilo escolhidos
      $('#fx-panel')?.classList.toggle('fluid', ALWAYS_ANIM.includes(p.theme.style));
      break;
    }
    case 'vice-icon': {
      p.viceIcon = el.dataset.v; saveDB(); render();
      // o ícone escolhido "faz a sua gracinha" aqui e na barra de baixo, para se ver bem a troca
      const chip = document.querySelector(`[data-act=vice-icon][data-v="${el.dataset.v}"]`), navBtn = document.querySelector('.nav button[data-tab=vices]');
      const card = document.querySelector('.module[data-id=vices]'); if (card) card.dataset.ic = el.dataset.v;     // o cartão do módulo Vícios também
      [chip, navBtn, card].forEach(x => { if (!x) return; x.classList.add('ping'); setTimeout(() => x.classList.remove('ping'), 700); });
      break;
    }
    case 'pick-photo': case 'pf-photo': break; // o label abre o seletor de ficheiros
    case 'edit-profile': profileSheet(); break;
    case 'pf-remove-photo': ui.pf.avatar = ''; $('#pf-preview').innerHTML = pfPreview(); el.style.display = 'none'; break;
    case 'save-pf': {
      const name = $('#pf-name').value.trim(), handle = cleanHandle($('#pf-handle').value);
      if (!name) return toast('O nome não pode ficar vazio');
      if (handle.length < 2) return toast('O @ precisa de pelo menos 2 letras ou números');
      if (handleTaken(handle, p.id)) return toast(`O @${handle} já está a ser usado por outro perfil`);
      p.name = name; p.handle = handle; p.avatar = ui.pf.avatar;
      saveDB(); closeSheet(); render(); toast('Perfil atualizado'); break;
    }
    case 'save-profile': {
      const d = ui.draft; d.name = $('#f-name').value.trim(); d.pin = $('#f-pin').value.trim();
      if (!d.name) return toast('Dá um nome ao perfil');
      if (d.pin && !/^\d{4}$/.test(d.pin)) return toast('A senha tem de ter 4 dígitos');
      d.handle = cleanHandle($('#f-handle').value) || uniqueHandle(d.name);
      if (d.handle.length < 2) return toast('O @ precisa de pelo menos 2 letras ou números');
      if (handleTaken(d.handle)) return toast(`O @${d.handle} já está a ser usado por outro perfil`);
      const prof = newProfile({ name: d.name, handle: d.handle, avatar: d.avatar, pin: d.pin ? await hashPin(d.pin) : null });
      db.profiles.push(prof); saveDB();
      applyTheme(DEFAULT_THEME); ui.firstRun = true; ui.profileId = prof.id; ui.tab = 'manage'; go('profile'); break;
    }
    case 'open-profile': {
      const prof = db.profiles.find(x => x.id === el.dataset.id);
      if (!prof.pin) return openWithLoading(prof);
      pinSheet(`Senha de ${prof.name}`, async v => (await checkPin(prof, v)) && (openWithLoading(prof), true));
      break;
    }
    case 'pin-key': pinSheet.handle(el.dataset.k); break;
    case 'close-sheet': if (e.target === el) dismissSheet(); break;
    case 'tab': goTab(el.dataset.tab); break;   // sair do separador "primeira vez" por aqui também conta como concluído (ver goTab)
    case 'toggle-module': {
      const m = MODULES.find(x => x.id === el.dataset.id);
      if (!m.ready) return toast(`${m.name} chega em breve`);
      const i = p.modules.indexOf(m.id); i >= 0 ? p.modules.splice(i, 1) : p.modules.push(m.id);
      saveDB();
      // em vez de redesenhar o ecrã, muda-se o cartão no sítio para as transições do CSS se verem
      const on = i < 0, ck = el.querySelector('.check');
      el.classList.toggle('on', on);
      if (on) {
        ck.innerHTML = ico('check'); ck.classList.add('pop'); el.classList.add('bump');
        setTimeout(() => { ck.classList.remove('pop'); el.classList.remove('bump'); }, 450);
      } else {
        ck.querySelector('.i')?.classList.add('gone');
        setTimeout(() => { if (!el.classList.contains('on')) ck.innerHTML = ''; }, 230);
      }
      if (!ui.firstRun) {                                         // a barra de baixo depende dos módulos: atualiza só essa parte
        const tmp = document.createElement('div'); tmp.innerHTML = vProfile(p);
        const nav = tmp.querySelector('.nav'); if (nav) document.querySelector('.nav')?.replaceWith(nav);
      }
      break;
    }
    case 'finish-setup': {
      ui.firstRun = false;
      ui.tab = MODULES.find(m => m.ready && p.modules.includes(m.id))?.id || 'home';
      render(); break;
    }
    case 'set-pin': askNewPin(p, 'Senha definida'); break;
    case 'change-pin': verifyPin(p, () => askNewPin(p, 'Senha alterada')); break;
    case 'remove-pin': verifyPin(p, async () => {
      closeSheet();
      if (!await askConfirm({ title: 'Remover a senha?', text: 'Qualquer pessoa neste telemóvel poderá abrir este perfil.', ok: 'Remover', danger: true, icon: 'unlock' })) return;
      p.pin = null; saveDB(); render(); toast('Senha removida');
    }); break;
    case 'delete-profile': {
      const doDelete = async () => {
        if (!await askConfirm({ title: 'Apagar este perfil?', text: `"${p.name}" e todos os seus dados serão apagados. Não dá para desfazer.`, ok: 'Apagar', danger: true, icon: 'trash' })) return;
        db.profiles = db.profiles.filter(x => x.id !== p.id); saveDB();
        ui.profileId = null; ui.firstRun = false;
        go(db.profiles.length ? 'picker' : 'welcome'); toast('Perfil apagado');
      };
      if (!p.pin) return doDelete();
      pinSheet(`Confirma a senha de ${p.name}`, async v => {
        if (!(await checkPin(p, v))) return false;
        closeSheet(); doDelete(); return true;
      });
      break;
    }
    case 'period-sum': setPeriod(el.dataset.v); break;
    case 'cal-pick': calPickSheet(); break;
    case 'cp-year': ui.pickY += +el.dataset.d; $('#cp-body').innerHTML = calPickBody(); break;
    case 'cp-month': case 'cp-today': {                                // saltar para o mês escolhido (ou voltar a hoje)
      const n = new Date(), today = act === 'cp-today';
      ui.cal.y = today ? n.getFullYear() : ui.pickY; ui.cal.m = today ? n.getMonth() : +el.dataset.m;
      ui.cal.sel = today ? n.getDate() : null; ui.cal.limit = 20; ui.calAnim = 'fade';
      closeSheet(); $('#calendar').innerHTML = vCalendar(p); break;
    }
    case 'cal-prev': case 'cal-next': {
      const d = new Date(ui.cal.y, ui.cal.m + (act === 'cal-next' ? 1 : -1), 1);
      if (act === 'cal-prev' && d.getFullYear() * 12 + d.getMonth() < firstMonthIndex(p)) break;
      ui.cal.y = d.getFullYear(); ui.cal.m = d.getMonth(); ui.cal.sel = null; ui.cal.limit = 20; ui.calAnim = act === 'cal-next' ? 'from-r' : 'from-l'; $('#calendar').innerHTML = vCalendar(p); break;
    }
    case 'sel-day': {
      const d = +el.dataset.d; ui.cal.sel = ui.cal.sel === d ? null : d; ui.cal.limit = 20; ui.calPop = ui.cal.sel; $('#calendar').innerHTML = vCalendar(p); break;
    }
    case 'more-cal': ui.cal.limit += 20; $('#calendar').innerHTML = vCalendar(p); break;
    case 'toggle-hm': {
      const mm = +el.dataset.mm, abrir = !(ui.cal.openM[mm] ?? (mm === ui.cal.m)), body = el.nextElementSibling?.classList.contains('hm-body') ? el.nextElementSibling : null;
      el.querySelector('.i')?.classList.toggle('flip');                                  // a seta roda logo
      const aplicar = () => { ui.cal.openM[mm] = abrir; refreshCalSummary(p); if (abrir) calOpen(document.querySelector(`#cal-sum .hmonth[data-mm="${mm}"] + .hm-body`)); };
      if (!abrir && body) calClose(body, aplicar); else aplicar();
      break;
    }
    case 'more-spend': ui.spendDays += 10; render(); break;

    /* Subscrições */
    case 'export-backup': exportBackup(p); break;
    case 'import-backup': $('#import-input').click(); break;
    case 'toggle-hist': {
      const v = el.dataset.v, fechar = ui.cal.open === v, corpo = b => (b?.classList.contains('hist') ? b : null);
      el.querySelector('.i')?.classList.toggle('flip');
      const outro = !fechar && ui.cal.open ? document.querySelector(`#cal-sum [data-act=toggle-hist][data-v="${ui.cal.open}"]`) : null;
      const aplicar = () => { ui.cal.open = fechar ? null : v; refreshCalSummary(p); if (!fechar) calOpen(document.querySelector(`#cal-sum [data-act=toggle-hist][data-v="${v}"] + .hist`)); };
      if (fechar) calClose(corpo(el.nextElementSibling), aplicar);
      else if (outro) { outro.querySelector('.i')?.classList.remove('flip'); calClose(corpo(outro.nextElementSibling), aplicar); }      // fecha primeiro a outra lista aberta
      else aplicar();
      break;
    }
    /* Casa */
    case 'add-bill': billSheet(); break;
    case 'edit-bill': billSheet(p.bills.find(x => x.id === el.dataset.id)); break;
    case 'invoice': { const [bid, ym] = el.dataset.id.split(':'); invoiceSheet(bid, ym); break; }
    case 'edit-bill-entry': {                                          // no calendário: conta variável abre a fatura; fixa abre a conta
      const [bid, ym] = el.dataset.id.split(':'), b = p.bills.find(x => x.id === bid);
      b.variable ? invoiceSheet(bid, ym) : billSheet(b); break;
    }
    case 'bill-type': {
      const t = billTypeOf(el.dataset.v), prev = billTypeOf(ui.billType), nameEl = $('#b-name');
      document.querySelectorAll('[data-act=bill-type]').forEach(c => c.classList.toggle('on', c === el));
      if (!nameEl.value.trim() || nameEl.value.trim() === prev.name) nameEl.value = t.name;     // não apaga um nome que escreveste
      nameEl.placeholder = `Ex.: ${t.name}`; ui.billType = t.id;
      if (!ui.editId) { ui.billVar = t.variable; $('#b-var-switch').classList.toggle('on', ui.billVar); $('#b-amount-label').textContent = ui.billVar ? 'Estimativa da fatura (€)' : 'Valor (€)'; }   // luz, água e gás já vêm como variáveis
      break;
    }
    case 'bill-var': ui.billVar = !ui.billVar; $('#b-var-switch').classList.toggle('on', ui.billVar); $('#b-amount-label').textContent = ui.billVar ? 'Estimativa da fatura (€)' : 'Valor (€)'; break;
    case 'bperiod':
      ui.billPeriod = el.dataset.v;
      document.querySelectorAll('[data-act=bperiod]').forEach(c => c.classList.toggle('on', c === el));
      $('#b-month-wrap').style.display = ui.billPeriod === 'month' ? 'none' : '';
      $('#b-month-label').textContent = ui.billPeriod === 'year' ? 'Mês' : 'Mês de uma cobrança'; break;
    case 'bremind':
      ui.billRemind = !ui.billRemind; $('#b-rswitch').classList.toggle('on', ui.billRemind); $('#b-rd-wrap').style.display = ui.billRemind ? '' : 'none';
      if (ui.billRemind && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
      break;
    case 'save-bill': {
      const t = billTypeOf(ui.billType), name = $('#b-name').value.trim() || t.name;
      const amount = parseAmount($('#b-amount').value), day = Math.min(31, Math.max(1, parseInt($('#b-day').value, 10) || 0));
      if (!(amount > 0)) return toast(ui.billVar ? 'Indica uma estimativa' : 'Indica o valor');
      if (!day) return toast('Indica o dia do pagamento');
      const data = { name, type: t.id, amount, variable: ui.billVar, period: ui.billPeriod, day, month: +$('#b-month').value, remind: ui.billRemind, remindDays: +$('#b-rd').value };
      if (ui.editId) {
        const old = p.bills.find(x => x.id === ui.editId);
        if (Math.abs(amount - curAmount(old)) > 0.004) { ui.pend = { kind: 'bill', id: old.id, data }; return priceFromSheet(old, amount); }
        const { amount: _same, ...rest } = data; Object.assign(old, rest);
      } else p.bills.push({ id: uid(), created: new Date().toISOString(), ...data });
      saveDB(); closeSheet(); render(); toast('Conta guardada'); break;
    }
    case 'price-apply': case 'price-all': {                          // valor novo: a partir de um mês, ou corrigir desde sempre
      const { kind, id, data } = ui.pend, item = (kind === 'sub' ? p.subs : kind === 'car' ? p.carFix : kind === 'inc' ? p.incomes : p.bills).find(x => x.id === id);
      const { amount, ...rest } = data; Object.assign(item, rest);
      applyPriceChange(item, amount, act === 'price-all' ? null : $('#pf-from').value);
      ui.pend = null; saveDB(); closeSheet(); render(); toast('Guardado'); break;
    }
    case 'price-cancel': ui.pend = null; closeSheet(); break;
    case 'del-bill':
      if (await askConfirm({ title: 'Eliminar esta conta?', text: 'A conta e as faturas registadas serão eliminadas. Não dá para desfazer.', ok: 'Eliminar', danger: true, icon: 'trash' })) {
        const bid = ui.editId; p.bills = p.bills.filter(x => x.id !== bid);
        for (const k of Object.keys(p.billLog)) if (k.startsWith(bid + ':')) delete p.billLog[k];
        saveDB(); closeSheet(); render(); toast('Conta eliminada');
      }
      break;
    case 'save-invoice': {
      const v = parseAmount($('#i-amount').value);
      if (!(v >= 0)) return toast('Indica o valor da fatura');
      p.billLog[`${ui.inv.bid}:${ui.inv.ym}`] = +v.toFixed(2); saveDB(); closeSheet(); render(); toast('Fatura registada'); break;
    }
    case 'clear-invoice': delete p.billLog[`${ui.inv.bid}:${ui.inv.ym}`]; saveDB(); closeSheet(); render(); break;
    case 'add-sub': subSheet(); break;
    case 'edit-sub': subSheet(p.subs.find(s => s.id === el.dataset.id)); break;
    case 'sub-icons': { const g = $('#s-icon-grid'); g.style.display = g.style.display === 'none' ? '' : 'none'; break; }
    case 'sub-icon':
      ui.subIcon = el.dataset.v; updateSubIcon();
      document.querySelectorAll('[data-act=sub-icon]').forEach(b => b.classList.toggle('on', b === el));
      $('#s-icon-grid').style.display = 'none'; break;
    case 'period': {
      ui.sheetPeriod = el.dataset.v;
      document.querySelectorAll('[data-act=period]').forEach(b => b.classList.toggle('on', b === el));
      $('#s-month-wrap').style.display = ui.sheetPeriod === 'month' ? 'none' : '';
      $('#s-month-label').textContent = ui.sheetPeriod === 'year' ? 'Mês' : 'Mês de uma cobrança'; break;
    }
    case 'remind': {
      ui.sheetRemind = !ui.sheetRemind;
      $('#s-switch').classList.toggle('on', ui.sheetRemind);
      $('#s-rd-wrap').style.display = ui.sheetRemind ? '' : 'none';
      if (ui.sheetRemind && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
      break;
    }
    case 'save-sub': {
      const name = $('#s-name').value.trim();
      const amount = parseAmount($('#s-amount').value);
      const day = Math.min(31, Math.max(1, parseInt($('#s-day').value, 10) || 0));
      if (!name) return toast('Indica o nome');
      if (!(amount > 0)) return toast('Indica um valor válido');
      if (!day) return toast('Indica o dia da cobrança');
      const data = { name, amount, period: ui.sheetPeriod, day, month: +$('#s-month').value, remind: ui.sheetRemind, remindDays: +$('#s-rd').value, icon: ui.subIcon || '' };
      if (ui.editId) {
        const old = p.subs.find(s => s.id === ui.editId);
        if (Math.abs(amount - curAmount(old)) > 0.004) { ui.pend = { kind: 'sub', id: old.id, data }; return priceFromSheet(old, amount); }   // o valor mudou: pergunta desde quando
        const { amount: _same, ...rest } = data; Object.assign(old, rest);                                          // valor igual: não mexe no histórico
      } else p.subs.push({ id: uid(), created: new Date().toISOString(), ...data });
      saveDB(); closeSheet(); render(); toast('Guardado'); break;
    }
    case 'del-sub':
      if (await askConfirm({ title: 'Eliminar esta subscrição?', text: 'Deixa de contar nos teus gastos. Não dá para desfazer.', ok: 'Eliminar', danger: true, icon: 'trash' })) { p.subs = p.subs.filter(s => s.id !== ui.editId); saveDB(); closeSheet(); render(); }
      break;

    /* Gastos avulsos */
    case 'add-spend': spendSheet(); break;
    case 'edit-spend': {                       // abastecimento com detalhe abre o formulário detalhado
      const s = p.spends.find(x => x.id === el.dataset.id);
      isShop(s) ? shopSheet(s) : (s.cat === 'fuel' && s.liters > 0) ? fuelSheet(s) : spendSheet(s); break;
    }
    case 'car-tab': carSwitch(el.dataset.v); break;
    case 'car-help': carHelpSheet(); break;
    case 'add-shop': shopSheet(); break;
    case 'edit-shop': shopSheet(p.spends.find(s => s.id === el.dataset.id)); break;
    case 'more-shop': ui.shopLimit = (ui.shopLimit || 10) + 10; render(); break;
    case 'shop-type':
      ui.shopType = el.dataset.v; document.querySelectorAll('[data-act=shop-type]').forEach(c => c.classList.toggle('on', c === el));
      { const k = KM_TYPES.includes(ui.shopType); $('#s-km-wrap').style.display = k ? '' : 'none'; $('#s-km-hint').style.display = k ? 'block' : 'none'; }
      break;
    case 'sveh':
      ui.sheetVeh = el.dataset.v; document.querySelectorAll('[data-act=sveh]').forEach(c => c.classList.toggle('on', c === el));
      $('#s-km-hint').textContent = shopKmHint(ui.sheetVeh); break;
    case 'save-shop': {
      const amount = parseAmount($('#s-amount').value), date = $('#s-date').value, kmRaw = KM_TYPES.includes(ui.shopType) ? $('#s-km').value.trim() : '', km = kmRaw ? parseInt(kmRaw, 10) : 0;
      if (!(amount > 0)) return toast('Indica o valor');
      if (!date) return toast('Indica a data');
      if (kmRaw && !(km > 0)) return toast('Os quilómetros têm de ser um número');
      if (km) {                                                       // os km de um veículo só podem subir com o tempo
        const others = p.spends.filter(s => s.veh === ui.sheetVeh && s.km > 0 && s.id !== ui.editId && (isFuel(s) || isShop(s)));
        const before = others.filter(s => s.date <= date).map(s => s.km), after = others.filter(s => s.date > date).map(s => s.km);
        if (before.length && km < Math.max(...before)) return toast(`Os km não podem ser inferiores a ${nf(Math.max(...before), 0)} (registo anterior deste veículo)`);
        if (after.length && km > Math.min(...after)) return toast(`Os km não podem ser superiores a ${nf(Math.min(...after), 0)} (registo seguinte deste veículo)`);
      }
      const data = { amount, cat: 'shop', date, type: ui.shopType, km: km || undefined, place: $('#s-place').value.trim(), note: $('#s-note').value.trim(), veh: ui.sheetVeh };
      if (ui.editId) { const o = p.spends.find(s => s.id === ui.editId); Object.assign(o, data); if (!km) delete o.km; } else p.spends.push({ id: uid(), ...data });
      saveDB(); closeSheet(); render(); toast('Despesa registada'); break;
    }
    case 'add-carfix': carFixSheet(null, el.dataset.v); break;
    case 'edit-carfix': {                                              // no calendário (id com o mês): variável abre o valor real; fixo abre o pagamento
      const [cid, ym] = el.dataset.id.split(':'), c = p.carFix.find(x => x.id === cid);
      c.variable && ym ? invoiceSheet(cid, ym) : carFixSheet(c); break;
    }
    case 'cf-type': {
      const t = carFixTypeOf(el.dataset.v);
      document.querySelectorAll('[data-act=cf-type]').forEach(c => c.classList.toggle('on', c === el));
      $('#cf-name').placeholder = `Ex.: ${t.hint}`; ui.cfType = t.id;
      if (!ui.editId) { const b = document.querySelector(`[data-act=cf-period][data-v=${t.period}]`); if (b) b.click(); }     // um novo já traz a frequência habitual
      break;
    }
    case 'cf-period':
      ui.cfPeriod = el.dataset.v;
      document.querySelectorAll('[data-act=cf-period]').forEach(c => c.classList.toggle('on', c === el));
      $('#cf-month-wrap').style.display = ui.cfPeriod === 'month' ? 'none' : '';
      $('#cf-month-label').textContent = ui.cfPeriod === 'year' ? 'Mês' : 'Mês de um pagamento'; break;
    case 'cf-var': ui.cfVar = !ui.cfVar; $('#cf-var-switch').classList.toggle('on', ui.cfVar); $('#cf-amount-label').textContent = ui.cfVar ? 'Estimativa de cada pagamento (€) *' : 'Valor de cada pagamento (€) *'; break;
    case 'cf-remind':
      ui.cfRemind = !ui.cfRemind; $('#cf-rswitch').classList.toggle('on', ui.cfRemind); $('#cf-rd-wrap').style.display = ui.cfRemind ? '' : 'none';
      if (ui.cfRemind && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
      break;
    case 'save-carfix': {
      const t = carFixTypeOf(ui.cfType), name = $('#cf-name').value.trim() || t.name;
      const amount = parseAmount($('#cf-amount').value), day = Math.min(31, Math.max(1, parseInt($('#cf-day').value, 10) || 0));
      if (!(amount > 0)) return toast('Indica o valor');
      if (!day) return toast('Indica o dia do pagamento');
      const data = { name, type: t.id, amount, period: ui.cfPeriod, day, month: +$('#cf-month').value, remind: ui.cfRemind, remindDays: +$('#cf-rd').value, veh: ui.sheetVeh, variable: ui.cfVar };
      if (ui.editId) {
        const old = p.carFix.find(x => x.id === ui.editId);
        if (Math.abs(amount - curAmount(old)) > 0.004) { ui.pend = { kind: 'car', id: old.id, data }; return priceFromSheet(old, amount); }
        const { amount: _same, ...rest } = data; Object.assign(old, rest);
      } else p.carFix.push({ id: uid(), created: new Date().toISOString(), ...data });
      saveDB(); closeSheet(); render(); toast('Guardado'); break;
    }
    case 'del-carfix':
      if (await askConfirm({ title: 'Eliminar este pagamento?', text: 'Deixa de contar no calendário e nos totais. Não dá para desfazer.', ok: 'Eliminar', danger: true, icon: 'trash' })) { const cid = ui.editId; p.carFix = p.carFix.filter(x => x.id !== cid); for (const k of Object.keys(p.billLog)) if (k.startsWith(cid + ':')) delete p.billLog[k]; saveDB(); closeSheet(); render(); toast('Eliminado'); }
      break;
    case 'add-shoprem': shopRemSheet(); break;
    case 'edit-shoprem': shopRemSheet(p.shopRems.find(r => r.id === el.dataset.id)); break;
    case 'rem-type': {
      ui.remType = el.dataset.v; document.querySelectorAll('[data-act=rem-type]').forEach(c => c.classList.toggle('on', c === el));
      if (!ui.editId) { const tp = shopTypeOf(ui.remType); $('#r-km').value = tp.km || ''; $('#r-mo').value = tp.months || ''; }       // um lembrete novo já traz os valores habituais
      break;
    }
    case 'rveh': ui.sheetVeh = el.dataset.v; document.querySelectorAll('[data-act=rveh]').forEach(c => c.classList.toggle('on', c === el)); break;
    case 'save-shoprem': {
      const everyKm = parseInt($('#r-km').value, 10) || 0, everyMonths = parseInt($('#r-mo').value, 10) || 0;
      if (!everyKm && !everyMonths) return toast('Indica os km, os meses, ou os dois');
      const data = { type: ui.remType, veh: ui.sheetVeh || '', everyKm, everyMonths };
      if (ui.editId) Object.assign(p.shopRems.find(r => r.id === ui.editId), data); else p.shopRems.push({ id: uid(), ...data });
      saveDB(); closeSheet(); render(); toast('Lembrete guardado'); break;
    }
    case 'del-shoprem':
      if (await askConfirm({ title: 'Eliminar este lembrete?', text: 'As despesas já registadas não se perdem.', ok: 'Eliminar', danger: true, icon: 'trash' })) { p.shopRems = p.shopRems.filter(r => r.id !== ui.editId); saveDB(); closeSheet(); render(); }
      break;
    case 'quick-rem': {
      const tp = shopTypeOf(el.dataset.v);
      p.shopRems.push({ id: uid(), type: tp.id, veh: ui.fuelVeh || p.vehicles[0]?.id || '', everyKm: tp.km || 0, everyMonths: tp.months || 0 }); saveDB(); render(); toast('Lembrete criado'); break;
    }
    case 'more-nav': moreNavSheet(); break;
    case 'more-go': closeSheet(); goTab(el.dataset.id); break;
    case 'add-fuel': fuelSheet(); break;
    case 'edit-fuel': fuelSheet(p.spends.find(s => s.id === el.dataset.id)); break;
    case 'fuel-veh': ui.fuelVeh = el.dataset.v; ui.fuelLimit = 10; render(); break;           // trocar de veículo no separador
    case 'fveh':                                                                                // trocar de veículo no formulário
      ui.sheetVeh = el.dataset.v;
      document.querySelectorAll('[data-act=fveh]').forEach(c => c.classList.toggle('on', c === el));
      $('#g-km-hint').textContent = fuelKmHint(ui.sheetVeh, ui.editId); break;
    case 'add-vehicle': vehicleSheet(); break;
    case 'edit-vehicle': vehicleSheet(p.vehicles.find(v => v.id === el.dataset.id)); break;
    case 'veh-type':
      ui.vehType = el.dataset.v;
      document.querySelectorAll('[data-act=veh-type]').forEach(c => c.classList.toggle('on', c === el)); break;
    case 'save-vehicle': {
      const name = $('#v-name').value.trim();
      if (!name) return toast('Dá um nome ao veículo');
      if (p.vehicles.some(v => v.id !== ui.editId && v.name.toLowerCase() === name.toLowerCase())) return toast('Já tens um veículo com esse nome');
      const kmYear = parseInt($('#v-kmyear').value, 10) || 0;
      if (ui.editId) Object.assign(p.vehicles.find(v => v.id === ui.editId), { name, type: ui.vehType, kmYear });
      else { const v = { id: uid(), name, type: ui.vehType, kmYear }; p.vehicles.push(v); ui.fuelVeh = v.id; }
      saveDB(); closeSheet(); render(); toast('Veículo guardado'); break;
    }
    case 'del-vehicle': {
      const vid = ui.editId, mine = p.spends.filter(s => s.veh === vid);
      const msg = mine.length ? `O veículo e os seus ${mine.length} registo${mine.length === 1 ? '' : 's'} (abastecimentos e outras despesas) serão eliminados. Não dá para desfazer.` : 'Não dá para desfazer.';
      if (await askConfirm({ title: 'Eliminar este veículo?', text: msg, ok: 'Eliminar', danger: true, icon: 'trash' })) {
        p.vehicles = p.vehicles.filter(v => v.id !== vid); p.spends = p.spends.filter(s => s.veh !== vid); p.carFix = p.carFix.filter(c => c.veh !== vid); p.shopRems = p.shopRems.filter(r => r.veh !== vid);
        ui.fuelVeh = null; saveDB(); closeSheet(); render(); toast('Veículo eliminado');
      }
      break;
    }
    case 'more-fuel': ui.fuelLimit += 10; render(); break;

    /* Vícios */
    case 'add-habit': habitSheet(); break;
    case 'edit-habit': habitSheet(p.habits.find(x => x.id === el.dataset.id)); break;
    case 'h-tpl': {
      const t = tplOf(el.dataset.v), prev = tplOf(ui.hTpl), nameEl = $('#h-name');
      if (!nameEl.value.trim() || nameEl.value.trim() === prev.name) nameEl.value = t.name;   // não apaga um nome que escreveste
      ui.hTpl = t.id; ui.hKind = t.kind; ui.hWins = t.wins;
      if (t.types) ui.hTypes = freshTypes(t.id);                       // café / álcool: tipos de partida do modelo
      document.querySelectorAll('[data-act=h-tpl]').forEach(b => b.classList.toggle('on', b === el));
      document.querySelectorAll('[data-act=hkind]').forEach(b => b.classList.toggle('on', b.dataset.v === ui.hKind));
      $('#h-wins-switch').classList.toggle('on', ui.hWins);
      hxApply(); break;
    }
    case 'hkind':
      ui.hKind = el.dataset.v;
      document.querySelectorAll('[data-act=hkind]').forEach(b => b.classList.toggle('on', b === el));
      hxApply(); break;
    case 'h-wins': ui.hWins = !ui.hWins; $('#h-wins-switch').classList.toggle('on', ui.hWins); break;
    case 'h-show': ui.hShow = !ui.hShow; $('#h-show-switch').classList.toggle('on', ui.hShow); break;
    case 'h-type-add': typesRead(); ui.hTypes.push({ id: uid(), name: '', price: 0, ua: ui.hTpl === 'alcool' ? 1 : 0 }); typesEditorRender(); break;
    case 'h-type-del': typesRead(); if (ui.hTypes.length > 1) ui.hTypes.splice(+el.dataset.i, 1); typesEditorRender(); break;
    case 'save-habit': {
      const name = $('#h-name').value.trim();
      if (!name) return toast('Dá um nome ao hábito');
      const t = tplOf(ui.hTpl), data = { name, show: ui.hShow, tpl: t.id, icon: t.icon, color: t.id === 'outro' ? colorOf(name) : t.color };
      const optNum = (id, label, int) => {                        // campo opcional: vazio = sem valor; inválido = erro
        const raw = $('#' + id).value.trim(); if (!raw) return 0;
        const v = int ? parseInt(raw, 10) : parseAmount(raw);
        return v >= 0 ? v : (toast(`${label} não é válido`), NaN);
      };
      if (t.id === 'tabaco') {                                    // preço por cigarro = preço do maço ÷ cigarros por maço
        const pp = optNum('h-pack-price', 'O preço do maço'), size = optNum('h-pack-size', 'O nº de cigarros'), goal = optNum('h-goal', 'A meta', true), base = optNum('h-baseline', 'O valor de antes', true);
        if ([pp, size, goal, base].some(Number.isNaN)) return;
        if ((pp > 0) !== (size > 0)) return toast('Indica o preço do maço e os cigarros por maço');
        Object.assign(data, { kind: 'unit', wins: false, pack: { price: pp, size }, price: size > 0 ? +(pp / size).toFixed(4) : 0, goal, baseline: base });
      } else if (t.id === 'casino') {
        const limit = optNum('h-limit', 'O limite');
        if (Number.isNaN(limit)) return;
        Object.assign(data, { kind: 'value', wins: true, price: 0, limit, pausedUntil: $('#h-pause')?.value || null });   // a pausa só existe ao editar
      } else if (t.id === 'cafe' || t.id === 'alcool') {               // tipos com preço (e UA no álcool)
        typesRead();
        const al = t.id === 'alcool', types = ui.hTypes.filter(x => x.name.trim());
        if (!types.length) return toast('Acrescenta pelo menos um tipo');
        if (types.some(x => !(x.price >= 0) || (al && !(x.ua >= 0)))) return toast('Há um preço ou valor de UA que não é válido');
        const gw = al ? optNum('h-goalweek', 'A meta semanal') : 0;
        if (Number.isNaN(gw)) return;
        Object.assign(data, { kind: 'unit', wins: false, price: 0, goalWeek: gw,
          types: types.map(x => ({ id: x.id, name: x.name.trim(), price: +x.price.toFixed(4), ua: al ? +(x.ua || 0).toFixed(2) : 0 })) });
      } else if (t.id === 'jogos') {
        Object.assign(data, { kind: 'games', wins: false, price: 0 });
      } else {
        const unit = ui.hKind === 'unit', raw = $('#h-price').value.trim();
        const price = unit && raw ? parseExpr(raw) : 0;
        if (!(price >= 0)) return toast('O preço não é válido');
        Object.assign(data, { kind: ui.hKind, price: +price.toFixed(4), wins: !unit && ui.hWins });
      }
      if (ui.editId) Object.assign(p.habits.find(x => x.id === ui.editId), data);
      else p.habits.push({ id: uid(), created: new Date().toISOString(), ...data });
      saveDB(); closeSheet(); render(); toast('Hábito guardado'); break;
    }
    case 'del-habit':
      if (await askConfirm({ title: 'Eliminar este hábito?', text: 'Todos os registos dele serão eliminados. Não dá para desfazer.', ok: 'Eliminar', danger: true, icon: 'trash' })) {
        const hid = ui.editId; p.habits = p.habits.filter(x => x.id !== hid);
        for (const k of Object.keys(p.hlog)) if (k.startsWith(hid + ':')) delete p.hlog[k];
        saveDB(); closeSheet(); render(); toast('Hábito eliminado');
      }
      break;
    case 'habit-plus': case 'habit-minus': {          // +1 / −1 de hoje, sem recarregar o ecrã todo
      const h = p.habits.find(x => x.id === el.dataset.id), k = hkey(h.id, ymd(today0()));
      if (act === 'habit-plus') { const r = p.hlog[k] ||= { n: 0, spent: 0, won: 0 }; r.n++; r.spent = +(r.spent + (h.price || 0)).toFixed(4); h.lastAt = new Date().toISOString(); }
      else { const r = p.hlog[k]; if (!r || r.n < 1) break; r.n--; r.spent = Math.max(0, +(r.spent - (h.price || 0)).toFixed(4)); if (!r.n && !r.spent && !r.won) delete p.hlog[k]; }
      saveDB(); $('#hcard-' + h.id).outerHTML = habitCardHTML(p, h);
      refreshVSummary(p); break;                                         // a visão geral acompanha o +1 / −1
    }
    case 'vperiod-sum': setVPeriod(el.dataset.v); break;
    case 'sper-sum': ui.sper = el.dataset.v; refreshSubs(); break;
    case 'toggle-balance-notice': p.balanceNotice = !p.balanceNotice; saveDB(); $('#bn-switch').classList.toggle('on', p.balanceNotice); break;
    case 'dismiss-balance': p.noticeSeen = el.dataset.v; saveDB(); render(); break;
    case 'income-menu': p.incomes.length === 1 && !p.earnings.length ? incomeSheet(p.incomes[0]) : incomeMenuSheet(); break;
    case 'add-earning': earningSheet(); break;
    case 'edit-earning': earningSheet(p.earnings.find(x => x.id === el.dataset.id)); break;
    case 'earn-cycle': p.earnCycle = el.dataset.v; saveDB(); document.querySelectorAll('[data-act=earn-cycle]').forEach(c => c.classList.toggle('on', c === el)); refreshResta(); break;
    case 'save-earning': {
      const amount = parseAmount($('#ea-amount').value), date = $('#ea-date').value;
      if (!(amount > 0)) return toast('Indica o valor');
      if (!date) return toast('Indica a data');
      const data = { amount, date, note: $('#ea-note').value.trim() };
      if (ui.editId) Object.assign(p.earnings.find(x => x.id === ui.editId), data); else p.earnings.push({ id: uid(), ...data });
      saveDB(); closeSheet(); render(); toast('Ganho registado'); break;
    }
    case 'del-earning':
      if (await askConfirm({ title: 'Eliminar este ganho?', text: 'Deixa de contar no quanto te resta. Não dá para desfazer.', ok: 'Eliminar', danger: true, icon: 'trash' })) { const eid = ui.editId; p.earnings = p.earnings.filter(x => x.id !== eid); saveDB(); closeSheet(); render(); toast('Eliminado'); }
      break;
    case 'add-income': incomeSheet(); break;
    case 'edit-income': incomeSheet(p.incomes.find(i => i.id === el.dataset.id)); break;
    case 'in-sub': ui.incSub = !ui.incSub; $('#in-sub-switch').classList.toggle('on', ui.incSub); $('#in-sub-wrap').style.display = ui.incSub ? '' : 'none'; break;
    case 'in-var': ui.incVar = !ui.incVar; $('#in-var-switch').classList.toggle('on', ui.incVar); break;
    case 'in-rule':
      ui.incRule = el.dataset.v; document.querySelectorAll('[data-act=in-rule]').forEach(c => c.classList.toggle('on', c === el));
      $('#in-day-wrap').style.display = ui.incRule === 'day' ? '' : 'none'; $('#in-nth-wrap').style.display = ui.incRule === 'bizend' ? '' : 'none';
      $('#in-wday-wrap').style.display = ui.incRule === 'weekly' ? '' : 'none'; $('#in-monthly').style.display = ui.incRule === 'weekly' ? 'none' : ''; break;
    case 'save-income': {
      const amount = parseAmount($('#in-amount').value), dayRaw = parseInt($('#in-day').value, 10), day = dayRaw >= 1 && dayRaw <= 31 ? dayRaw : 0;
      if (!(amount > 0)) return toast('Indica o valor');
      if (ui.incRule === 'day' && !day) return toast('Indica o dia do pagamento');
      const weekly = ui.incRule === 'weekly';
      const data = { name: $('#in-name').value.trim(), amount, rule: ui.incRule, day: day || 1, nth: +$('#in-nth').value, wday: +$('#in-wday').value, period: 'month', month: 1, sub14: !weekly && ui.incSub, mFer: +$('#in-fer').value, mNat: +$('#in-nat').value, variable: !weekly && ui.incVar };
      if (ui.editId) {
        const old = p.incomes.find(x => x.id === ui.editId);
        if (Math.abs(amount - curAmount(old)) > 0.004) { ui.pend = { kind: 'inc', id: old.id, data }; return priceFromSheet(old, amount); }
        const { amount: _same, ...rest } = data; Object.assign(old, rest);
      } else p.incomes.push({ id: uid(), created: new Date().toISOString(), ...data });
      saveDB(); closeSheet(); render(); toast('Guardado'); break;
    }
    case 'del-income':
      if (await askConfirm({ title: 'Eliminar este ordenado?', text: 'Deixa de contar no quanto te resta. Não dá para desfazer.', ok: 'Eliminar', danger: true, icon: 'trash' })) { const iid = ui.editId; p.incomes = p.incomes.filter(x => x.id !== iid); for (const k of Object.keys(p.billLog)) if (k.startsWith(iid + ':')) delete p.billLog[k]; saveDB(); closeSheet(); render(); toast('Eliminado'); }
      break;
    case 'habit-type': {                                               // café / álcool: um toque no tipo regista +1 desse tipo
      const h = p.habits.find(x => x.id === el.dataset.id), ty = h.types.find(x => x.id === el.dataset.t), k = hkey(h.id, ymd(today0()));
      const r = p.hlog[k] ||= { n: 0, spent: 0, won: 0 };
      r.n++; r.spent = +(r.spent + ty.price).toFixed(4); (r.by ||= {})[ty.id] = (r.by[ty.id] || 0) + 1;
      if (ty.ua > 0) r.ua = +((r.ua || 0) + ty.ua).toFixed(3);
      let bucket = null;
      if (h.tpl === 'cafe') { const hr = new Date().getHours(); bucket = hr < 12 ? 'm' : hr < 18 ? 't' : 'n'; (r.hr ||= {})[bucket] = (r.hr[bucket] || 0) + 1; }
      h.lastAdd = { k, t: ty.id, b: bucket }; h.lastAt = new Date().toISOString();
      saveDB(); $('#hcard-' + h.id).outerHTML = habitCardHTML(p, h); refreshVSummary(p); break;
    }
    case 'habit-undo': {                                               // desfaz só o último registo feito com um toque
      const h = p.habits.find(x => x.id === el.dataset.id), la = h.lastAdd, r = la && p.hlog[la.k];
      if (!r || !(r.by?.[la.t] > 0)) return toast('Não há nada para desfazer');
      const ty = h.types.find(x => x.id === la.t) || { price: 0, ua: 0 };
      r.n--; r.spent = Math.max(0, +(r.spent - ty.price).toFixed(4)); r.by[la.t]--; if (!r.by[la.t]) delete r.by[la.t];
      if (ty.ua) r.ua = Math.max(0, +((r.ua || 0) - ty.ua).toFixed(3));
      if (la.b && r.hr?.[la.b] > 0) r.hr[la.b]--;
      if (!r.n && !r.spent && !r.won) delete p.hlog[la.k];
      h.lastAdd = null; saveDB(); $('#hcard-' + h.id).outerHTML = habitCardHTML(p, h); refreshVSummary(p); break;
    }
    case 'save-tday': {
      const { hid, key } = ui.hd, h = p.habits.find(x => x.id === hid);
      const date = key ? key.slice(hid.length + 1) : $('#td-date').value;
      if (!date) return toast('Indica a data');
      if (!key && date < $('#td-date').min) return toast('Só podes registar a partir do início deste mês');
      if (date > ymd(today0())) return toast('Não podes registar no futuro');
      const k = key || hkey(hid, date), old = p.hlog[k];
      let n = 0, spent = 0, ua = 0; const by = {};
      h.types.forEach(x => { const q = parseInt($('#tq-' + x.id).value, 10) || 0; if (q > 0) { by[x.id] = q; n += q; spent += q * x.price; ua += q * (x.ua || 0); } });
      if (key && old) { const lo = leftoverOf(h, old); if (lo.n) { Object.assign(by, lo.by); n += lo.n; spent += lo.spent; ua += lo.ua; } }
      if (!(n > 0)) return toast(key ? 'Indica pelo menos uma unidade (ou elimina o registo)' : 'Indica a quantidade de pelo menos um tipo');
      if (key) p.hlog[k] = { n, spent: +spent.toFixed(4), won: 0, by, ...(ua ? { ua: +ua.toFixed(3) } : {}), ...(old?.hr ? { hr: old.hr } : {}) };
      else {
        const r = p.hlog[k] ||= { n: 0, spent: 0, won: 0 };
        r.n += n; r.spent = +(r.spent + spent).toFixed(4); r.by = r.by || {};
        for (const id in by) r.by[id] = (r.by[id] || 0) + by[id];
        if (ua) r.ua = +((r.ua || 0) + ua).toFixed(3);
      }
      saveDB(); closeSheet(); render(); toast('Registado'); break;
    }
    case 'casino-gain': hdaySheet(el.dataset.id, null, 'gain'); break;  // um ganho não é gasto: sem aviso de pausa
    case 'habit-add': case 'casino-dep': {
      const h = p.habits.find(x => x.id === el.dataset.id);
      if (h.pausedUntil && h.pausedUntil >= ymd(today0()) && !(await askConfirm({ title: 'Estás em pausa', text: `A pausa vai até ${dateShort(h.pausedUntil)}. Queres registar mesmo assim?`, ok: 'Registar', icon: 'pause' }))) break;   // só avisa
      hdaySheet(h.id, null, act === 'casino-dep' ? 'dep' : null); break;
    }
    case 'goto-habits': ui.tab = 'vices'; render(); break;
    case 'add-game': gameSheet(el.dataset.id); break;
    case 'edit-game': { const [key, itemId] = el.dataset.id.split('|'); gameSheet(key.split(':')[0], key, itemId); break; }
    case 'gm-refund': {
      ui.gmRefund = !ui.gmRefund;
      $('#gm-refund-switch').classList.toggle('on', ui.gmRefund);
      $('#gm-refund-wrap').style.display = ui.gmRefund ? '' : 'none';
      if (ui.gmRefund && !$('#gm-refund').value) $('#gm-refund').value = $('#gm-price').value;   // por defeito, reembolso total
      break;
    }
    case 'save-game': {
      const { hid, key, itemId } = ui.gm;
      const name = $('#gm-name').value.trim(), price = parseAmount($('#gm-price').value), date = $('#gm-date').value;
      const refund = ui.gmRefund ? parseAmount($('#gm-refund').value) : 0;
      if (!name) return toast('Indica o nome do jogo');
      if (!(price > 0)) return toast('Indica o preço');
      if (!date) return toast('Indica a data');
      if (date < $('#gm-date').min) return toast('Só podes registar a partir do início deste mês');
      if (date > ymd(today0())) return toast('Não podes registar no futuro');
      if (ui.gmRefund && !(refund > 0 && refund <= price)) return toast('O reembolso tem de ser entre 0 e o preço');
      if (itemId) { const r = p.hlog[key]; r.items = r.items.filter(i => i.id !== itemId); recalcDay(p, key); }   // editar = tira da data antiga
      const k = hkey(hid, date), r = p.hlog[k] ||= { n: 0, spent: 0, won: 0, items: [] };
      (r.items ||= []).push({ id: itemId || uid(), name, price, refund: ui.gmRefund ? refund : 0 });
      recalcDay(p, k); saveDB(); closeSheet(); render(); toast('Compra guardada'); break;
    }
    case 'del-game':
      if (await askConfirm({ title: 'Eliminar esta compra?', text: 'Não dá para desfazer.', ok: 'Eliminar', danger: true, icon: 'trash' })) {
        const { key, itemId } = ui.gm, r = p.hlog[key]; r.items = r.items.filter(i => i.id !== itemId);
        recalcDay(p, key); saveDB(); closeSheet(); render();
      }
      break;
    case 'edit-hday': {                                                // café/álcool editam-se por tipo; os outros pelo valor total
      const hid = el.dataset.id.split(':')[0], h = p.habits.find(x => x.id === hid);
      h.types?.length ? typesDaySheet(hid, el.dataset.id) : hdaySheet(hid, el.dataset.id); break;
    }
    case 'save-hday': {
      const { hid, key } = ui.hd, h = p.habits.find(x => x.id === hid), unit = h.kind === 'unit';
      const date = key ? key.slice(hid.length + 1) : $('#d-date').value;
      if (!date) return toast('Indica a data');
      if (!key && date < $('#d-date').min) return toast('Só podes registar a partir do início deste mês');
      if (date > ymd(today0())) return toast('Não podes registar no futuro');
      const mode = ui.hd.mode;
      const spent = parseAmount($('#d-spent')?.value) || 0, won = h.wins ? (parseAmount($('#d-won')?.value) || 0) : 0;
      const n = unit ? parseInt($('#d-n').value, 10) : 1;
      if (unit && !(n > 0)) return toast('Indica a quantidade');
      if (!unit && !(spent > 0 || won > 0)) return toast('Indica o valor');
      const k = key || hkey(hid, date), old = p.hlog[k] || { n: 0, spent: 0, won: 0 };
      p.hlog[k] = key ? { n: unit ? n : (old.n ?? 1), spent, won }
        : { n: old.n + (unit ? n : (mode === 'gain' ? 0 : 1)),          // um ganho não é um depósito
            spent: +(old.spent + spent).toFixed(4), won: +(old.won + won).toFixed(4) };
      saveDB(); closeSheet(); render(); toast('Registado'); break;
    }
    case 'del-hday':
      if (await askConfirm({ title: 'Eliminar este registo?', text: 'Não dá para desfazer.', ok: 'Eliminar', danger: true, icon: 'trash' })) { delete p.hlog[ui.hd.key]; saveDB(); closeSheet(); render(); }
      break;
    case 'cat': {
      ui.sheetCat = el.dataset.v;
      document.querySelectorAll('[data-act=cat]').forEach(b => b.classList.toggle('on', b === el));
      $('#g-note').placeholder = NOTE_HINT[ui.sheetCat] || '';
      $('#fuel-hint').classList.toggle('open', ui.sheetCat === 'fuel'); break;                // a nota abre e fecha a deslizar, empurrando o resto com suavidade
    }
    case 'full-toggle': ui.sheetFull = !ui.sheetFull; $('#g-full-switch').classList.toggle('on', ui.sheetFull); break;
    case 'save-spend': {
      const amount = parseAmount($('#g-amount').value);
      const date = $('#g-date').value;
      if (!(amount > 0)) return toast('Indica um valor válido');
      if (!date) return toast('Indica a data');
      if (date < $('#g-date').min) return toast('Só podes registar a partir do início deste mês');
      const data = { amount, cat: ui.sheetCat, date, note: $('#g-note').value.trim() };   // versão simples: só o valor
      if (ui.editId) Object.assign(p.spends.find(s => s.id === ui.editId), data); else p.spends.push({ id: uid(), ...data });
      saveDB(); closeSheet(); render(); toast('Gasto registado'); break;
    }
    case 'save-fuel': {                                               // versão detalhada: litros e km obrigatórios
      const amount = parseAmount($('#g-amount').value), liters = parseAmount($('#g-liters').value);
      const kmRaw = $('#g-km').value.trim(), km = kmRaw ? parseInt(kmRaw, 10) : 0, date = $('#g-date').value;
      if (!(amount > 0)) return toast('Indica o valor pago');
      if (!(liters > 0)) return toast('Indica os litros abastecidos');
      if (kmRaw && !(km > 0)) return toast('Os quilómetros têm de ser um número');
      if (!date) return toast('Indica a data');
      if (date < $('#g-date').min) return toast('Só podes registar a partir do início deste mês');
      const others = p.spends.filter(s => isFuel(s) && s.veh === ui.sheetVeh && s.id !== ui.editId);   // os km são de cada veículo
      const before = others.filter(s => s.date <= date).map(s => s.km), after = others.filter(s => s.date > date).map(s => s.km);
      if (km && before.length && km <= Math.max(...before)) return toast(`Os km têm de ser superiores a ${nf(Math.max(...before), 0)} (registo anterior deste veículo)`);
      if (km && after.length && km >= Math.min(...after)) return toast(`Os km têm de ser inferiores a ${nf(Math.min(...after), 0)} (registo seguinte deste veículo)`);
      const data = { amount, cat: 'fuel', date, note: $('#g-note').value.trim(), liters, km: km || undefined, full: ui.sheetFull, veh: ui.sheetVeh };
      if (ui.editId) { const o = p.spends.find(s => s.id === ui.editId); Object.assign(o, data); if (!km) delete o.km; } else p.spends.push({ id: uid(), ...data });
      saveDB(); closeSheet(); render(); toast('Abastecimento registado'); break;
    }
    case 'del-spend':
      if (await askConfirm({ title: 'Eliminar este gasto?', text: 'Não dá para desfazer.', ok: 'Eliminar', danger: true, icon: 'trash' })) { p.spends = p.spends.filter(s => s.id !== ui.editId); saveDB(); closeSheet(); render(); }
      break;
  }
});

/* Combustível: valor, litros e preço por litro estão ligados — preenchendo dois, calcula o terceiro. */
document.addEventListener('input', e => {
  const tid = e.target.id;
  if (tid === 's-name' && ui.subIcon === '') updateSubIcon();
  if (tid === 'f-name' && ui.draft && !ui.draft.handleTouched) $('#f-handle').value = uniqueHandle(e.target.value);   // o @ sugere-se a partir do nome, até o mudares à mão
  if (tid === 'f-handle' || tid === 'pf-handle') {                                // só letras minúsculas, números, ponto e _
    if (tid === 'f-handle' && ui.draft) ui.draft.handleTouched = true;
    const c = cleanHandle(e.target.value); if (c !== e.target.value) e.target.value = c;
    return;
  }
  if (e.target.id === 'd-n' && ui.hd && ui.hd.price > 0) {          // vícios: quantidade × preço = gasto (podes alterar à mão)
    const n = parseInt(e.target.value, 10);
    if (n >= 0) $('#d-spent').value = (n * ui.hd.price).toFixed(2).replace('.', ',');
    return;
  }
  const id = e.target.id, F = ['g-amount', 'g-liters', 'g-price'];
  if (!F.includes(id)) return;
  ui.fuelOrder = [...(ui.fuelOrder || []).filter(x => x !== id), id].slice(-2);   // os 2 últimos campos editados mandam
  if (!$('#g-liters') || ui.fuelOrder.length < 2) return;           // só no formulário detalhado do combustível
  const val = x => parseAmount($('#' + x).value);
  const third = F.find(x => !ui.fuelOrder.includes(x));
  const v = Object.fromEntries(ui.fuelOrder.map(x => [x, val(x)]));
  if (!ui.fuelOrder.every(x => v[x] > 0)) return;
  const res = third === 'g-amount' ? v['g-liters'] * v['g-price']
    : third === 'g-liters' ? v['g-amount'] / v['g-price'] : v['g-amount'] / v['g-liters'];
  $('#' + third).value = res.toFixed(third === 'g-price' ? 3 : 2).replace('.', ',');
});

document.addEventListener('change', async e => {
  if (e.target.id === 'import-input') {
    const f = e.target.files[0]; e.target.value = '';
    if (f) importBackup(f);
    return;
  }
  if (e.target.id === 'pf-photo-input' && e.target.files[0]) {                    // mudar a foto no ecrã "Editar perfil"
    ui.pf.avatar = await readPhoto(e.target.files[0]);
    $('#pf-preview').innerHTML = pfPreview(); $('#pf-remove').style.display = '';
    e.target.value = ''; return;
  }
  if (e.target.id === 'photo-input' && e.target.files[0]) {
    ui.draft.name = $('#f-name').value; ui.draft.pin = $('#f-pin').value;
    ui.draft.avatar = await readPhoto(e.target.files[0]);
    $('#photo-preview').innerHTML = `<div class="avatar md"><img src="${ui.draft.avatar}" alt=""></div>`;
  }
});

/* ───────────── ARRANQUE ───────────── */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
setInterval(() => document.querySelectorAll('[data-since]').forEach(el => { el.textContent = sinceText(el.dataset.since); }), 30000);   // "último cigarro há…" vai atualizando
navigator.storage?.persist?.().catch(() => {});   // pede ao sistema para não apagar os dados quando faltar espaço
/* Arranque: lê os dados (na app Android são ficheiros, por isso é assíncrono) e só depois mostra o ecrã. */
/* Prepara com calma, quando o telemóvel está livre, as imagens que a janela Aparência usa (uma por cor): assim abre sem "soluço". */
function warmUp() {
  const idle = window.requestIdleCallback ? f => requestIdleCallback(f, { timeout: 4000 }) : f => setTimeout(f, 1200);
  let i = 0;
  const step = () => { if (i < PALETTES.length) { try { pixelGradient(PALETTES[i].g[0], PALETTES[i].g[1]); } catch {} i++; idle(step); } };   // uma de cada vez
  idle(step);
}
async function boot() {
  try { applyTheme(JSON.parse(localStorage.getItem('konto.theme'))); } catch {}      // o ecrã já nasce com o último tema usado
  $('#app').innerHTML = '<section class="screen center"><p class="muted" style="text-align:center">A carregar…</p></section>';
  try { db = await Store.load(); }
  catch (e) { console.error(e); db = loadDB(); }
  try { if (!window.Capacitor?.isNativePlatform?.()) navigator.storage?.persist?.(); } catch {}   // versão web: pede ao browser para não apagar os dados
  if (ensureHandles(db)) saveDB();                           // perfis antigos recebem um @utilizador
  ui.screen = db.profiles.length ? 'picker' : 'welcome';
  render();
  warmUp();
  const r = Store.report;
  if (r.bad) toast(r.recovered ? 'Alguns dados foram recuperados da cópia interna' : 'Alguns dados não puderam ser lidos');
}
boot();
