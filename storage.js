/* Konto — armazenamento dos dados
 *
 * Browser / PWA: localStorage (limite de uns 5 MB).
 * App Android: ficheiros na pasta privada da app, sem limite prático de espaço:
 *
 *   konto/<perfil>.core.{a,b}.json     dados do perfil (subscrições, hábitos, contas, foto…)
 *   konto/<perfil>.<ano>.{a,b}.json    gastos e registos desse ano (os anos antigos já não são reescritos)
 *   konto/snapshots/AAAA-MM-DD.json    cópia interna diária (as últimas 7)
 *
 * Cada ficheiro tem duas "gavetas" (a e b) que se alternam: se a gravação for interrompida (bateria,
 * app fechada), só se estraga a gaveta que estava a ser escrita; a outra continua com a versão anterior,
 * completa. Cada gaveta leva um número de sequência e um código de verificação, para se saber qual está boa.
 * Se um perfil ficar ilegível nas duas gavetas, recupera-se da cópia interna mais recente.
 *
 * Usa globais de app.js só quando é chamado (loadDB, migrateProfile, ymd, toast, DB_VERSION, db).
 */
'use strict';

const Store = (() => {
  const DIR = 'konto', SNAP = 'konto/snapshots', KEEP_SNAPSHOTS = 7, DEBOUNCE_MS = 400;
  const api = { mode: 'web', loaded: false, report: { bad: 0, recovered: 0, migrated: false } };
  const state = {};                                          // ficheiro lógico → { seq, slot, body } (o que está gravado)
  let timer = null, running = null, again = false, snapDay = null;

  const isNative = () => { const c = window.Capacitor; return !!(c?.isNativePlatform?.() && c.Plugins?.Filesystem); };
  const FS = () => window.Capacitor.Plugins.Filesystem;
  const at = path => ({ path, directory: 'DATA' });          // pasta privada da app (a que entra na cópia automática do Android)

  /* ── verificação de integridade (rápida, não criptográfica) ── */
  function sum(s) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  const wrap = (kind, seq, body) => JSON.stringify({ app: 'konto', fmt: 1, kind, seq, savedAt: new Date().toISOString(), sum: sum(body), body });
  function unwrap(text) {                                    // devolve { seq, body } se o ficheiro estiver inteiro, senão null
    try { const w = JSON.parse(text); if (w?.app === 'konto' && typeof w.body === 'string' && w.sum === sum(w.body)) return { seq: w.seq || 0, body: w.body }; } catch {}
    return null;
  }

  /* ── ficheiros ── */
  async function readText(path) { try { return (await FS().readFile({ ...at(path), encoding: 'utf8' })).data; } catch { return null; } }
  const writeText = (path, data) => FS().writeFile({ ...at(path), data, encoding: 'utf8', recursive: true });
  async function removeFile(path) { try { await FS().deleteFile(at(path)); } catch {} }
  async function listDir(path) {
    try { const r = await FS().readdir(at(path)); return (r.files || []).map(f => typeof f === 'string' ? f : f.name); } catch { return []; }
  }
  const snapNames = files => files.filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();

  /* ── dividir os dados em ficheiros (perfil + um por ano) e voltar a juntá-los ── */
  const yearOf = s => String(s || '').slice(0, 4).match(/^\d{4}$/)?.[0] || '0000';
  function splitDB(d) {
    const out = {};
    for (const p of d.profiles) {
      const { spends, hlog, billLog, ...core } = p;
      out[`${p.id}.core`] = { ...core, _v: DB_VERSION };
      const years = {};
      const Y = y => years[y] ||= { spends: [], hlog: {}, billLog: {} };
      for (const s of spends || []) Y(yearOf(s.date)).spends.push(s);
      for (const k in hlog || {}) Y(yearOf(k.slice(k.indexOf(':') + 1))).hlog[k] = hlog[k];          // "idHábito:AAAA-MM-DD"
      for (const k in billLog || {}) Y(yearOf(k.slice(k.indexOf(':') + 1))).billLog[k] = billLog[k];  // "idConta:AAAA-MM"
      for (const y in years) out[`${p.id}.${y}`] = years[y];
    }
    return out;
  }
  function mergeShards(bodies) {
    const profiles = {}, split = name => [name.slice(0, name.indexOf('.')), name.slice(name.indexOf('.') + 1)];
    for (const [name, body] of Object.entries(bodies)) {
      const [pid, part] = split(name);
      if (part === 'core') { const { _v, ...core } = body; profiles[pid] = { ...core, spends: [], hlog: {}, billLog: {} }; }
    }
    for (const [name, body] of Object.entries(bodies)) {
      const [pid, part] = split(name), p = profiles[pid];
      if (!p || part === 'core') continue;
      for (const s of body.spends || []) p.spends.push(s);
      Object.assign(p.hlog, body.hlog || {}); Object.assign(p.billLog, body.billLog || {});
    }
    const list = Object.values(profiles).map(migrateProfile)
      .sort((a, b) => String(a.created).localeCompare(String(b.created)) || a.id.localeCompare(b.id));
    return { version: DB_VERSION, profiles: list };
  }

  /* ── cópias internas diárias ── */
  async function snapshotIfNeeded(d) {
    const today = ymd(new Date());
    if (snapDay === today) return;
    try {
      await writeText(`${SNAP}/${today}.json`, wrap('snapshot', 1, JSON.stringify(d)));
      snapDay = today;
      const names = snapNames(await listDir(SNAP));
      for (const old of names.slice(0, Math.max(0, names.length - KEEP_SNAPSHOTS))) await removeFile(`${SNAP}/${old}`);
    } catch (e) { console.error('Konto: cópia interna falhou', e); }
  }
  async function latestSnapshot() {
    for (const n of snapNames(await listDir(SNAP)).reverse()) {
      const w = unwrap((await readText(`${SNAP}/${n}`)) ?? '');
      if (w) { try { return JSON.parse(w.body); } catch {} }
    }
    return null;
  }

  /* ── gravar: só o que mudou ── */
  async function flushOnce(d) {
    const parts = splitDB(d), names = new Set(Object.keys(parts));
    let failed = false, wrote = 0;
    for (const name of names) {
      const body = JSON.stringify(parts[name]), st = state[name];
      if (st && st.body === body) continue;                  // não mudou: não se reescreve (os anos antigos ficam quietos)
      const seq = (st?.seq || 0) + 1, slot = st?.slot === 'a' ? 'b' : 'a';   // escreve na gaveta que NÃO é a última boa
      try { await writeText(`${DIR}/${name}.${slot}.json`, wrap(name.endsWith('.core') ? 'core' : 'year', seq, body)); state[name] = { seq, slot, body }; wrote++; }
      catch (e) { failed = true; console.error('Konto: falha a gravar', name, e); }
    }
    for (const name of Object.keys(state)) if (!names.has(name)) {          // perfil apagado, ou ano que ficou sem registos
      await removeFile(`${DIR}/${name}.a.json`); await removeFile(`${DIR}/${name}.b.json`); delete state[name];
    }
    if (failed) toast('Não foi possível guardar os dados. Exporta uma cópia de segurança.');
    else if (wrote) await snapshotIfNeeded(d);
    return !failed;
  }
  function flush(force) {                                    // grava já (os pedidos que chegam durante uma gravação são juntados)
    if (api.mode !== 'native' || (!api.loaded && !force)) return Promise.resolve();
    clearTimeout(timer); timer = null;
    if (running) { again = true; return running; }
    running = (async () => { do { again = false; await flushOnce(force && force.profiles ? force : db); force = null; } while (again); })()
      .finally(() => { running = null; });
    return running;
  }
  function save() {
    if (api.mode !== 'native') {                             // browser: localStorage, logo
      try { localStorage.setItem(KEY, JSON.stringify(db)); }
      catch { toast('Sem espaço para guardar! Exporta uma cópia de segurança.'); }
      return;
    }
    clearTimeout(timer); timer = setTimeout(() => flush(), DEBOUNCE_MS);
  }

  /* ── ler ── */
  async function verify(d) {                                 // lê tudo de volta e confirma que é igual ao que está em memória
    for (const [name, data] of Object.entries(splitDB(d))) {
      const body = JSON.stringify(data);
      const slots = await Promise.all(['a', 'b'].map(async s => unwrap((await readText(`${DIR}/${name}.${s}.json`)) ?? '')));
      if (!slots.some(w => w && w.body === body)) return false;
    }
    return true;
  }
  async function nativeLoad() {
    const files = await listDir(DIR);
    const bases = new Set(files.filter(f => /\.(a|b)\.json$/.test(f)).map(f => f.replace(/\.(a|b)\.json$/, '')));
    const bodies = {}, bad = [];
    for (const base of bases) {
      const slots = await Promise.all(['a', 'b'].map(async s => ({ s, w: unwrap((await readText(`${DIR}/${base}.${s}.json`)) ?? '') })));
      const good = slots.filter(x => x.w).sort((x, y) => y.w.seq - x.w.seq)[0];     // a gaveta inteira com a sequência mais alta
      if (!good) { bad.push(base); continue; }
      try { bodies[base] = JSON.parse(good.w.body); state[base] = { seq: good.w.seq, slot: good.s, body: good.w.body }; }
      catch { bad.push(base); }
    }
    snapDay = snapNames(await listDir(SNAP)).pop()?.slice(0, 10) || null;

    if (bad.length) {                                        // algum ficheiro ilegível nas duas gavetas: preenche-o com a cópia interna mais recente
      const snap = await latestSnapshot(); let recovered = 0;
      if (snap) {
        const fill = splitDB({ profiles: snap.profiles || [] });
        for (const base of bad) if (fill[base]) { bodies[base] = fill[base]; recovered++; }   // os ficheiros bons ficam como estão (são mais recentes)
      }
      api.report = { bad: bad.length, recovered, migrated: false };    // os recuperados voltam a ser gravados na próxima gravação
    }
    let d = mergeShards(bodies);

    if (!bases.size && localStorage.getItem(KEY)) {          // primeira vez com ficheiros: passa os dados que estavam no localStorage
      d = loadDB();
      await flush(d);
      if (await verify(d)) {                                 // só depois de confirmar que ficou tudo bem gravado
        localStorage.setItem(KEY + '.premigration', localStorage.getItem(KEY));    // fica uma cópia de segurança, mas deixa de ser a fonte
        localStorage.removeItem(KEY);
        api.report = { bad: 0, recovered: 0, migrated: true };
      } else {                                               // algo correu mal: desfaz e continua com o localStorage
        for (const name of Object.keys(state)) { await removeFile(`${DIR}/${name}.a.json`); await removeFile(`${DIR}/${name}.b.json`); delete state[name]; }
        api.mode = 'web'; api.fallback = true;
      }
    }
    return d;
  }
  async function load() {
    if (isNative()) {
      try { api.mode = 'native'; const d = await nativeLoad(); api.loaded = true; return d; }
      catch (e) { console.error('Konto: armazenamento em ficheiros falhou, a usar localStorage', e); api.fallback = true; }
    }
    api.mode = 'web'; api.loaded = true;
    return loadDB();
  }

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });   // ao sair da app, grava já
  window.addEventListener('pagehide', () => flush());

  return Object.assign(api, {
    load, save, flush,
    info() {                                                 // para mostrar em Gerir → Dados
      if (api.mode === 'native') return { mode: 'native', files: Object.keys(state).length, bytes: Object.values(state).reduce((a, s) => a + s.body.length, 0) };
      return { mode: 'web', bytes: JSON.stringify(db).length };
    },
    reset() { for (const k of Object.keys(state)) delete state[k]; snapDay = null; api.loaded = false; api.mode = 'web'; api.report = { bad: 0, recovered: 0, migrated: false }; api.fallback = false; },
    _split: splitDB, _merge: mergeShards, _unwrap: unwrap, _sum: sum, _state: state,
  });
})();
