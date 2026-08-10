// Gemeinsame Basis für Host-, Spieler- und Fernbedienungsansicht:
// Verbindung (SSE), Aktionen (POST), Töne und ein paar Mini-Helfer.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, val] of Object.entries(value)) {
        // Object.assign greift bei CSS-Variablen nicht – die brauchen setProperty.
        if (prop.startsWith('--')) node.style.setProperty(prop, val);
        else node.style[prop] = val;
      }
    }
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

// Host-Screen und Spieleransicht bekommen getrennte Kennungen: sonst würden sich
// beide im selben Browser gegenseitig die Verbindung und die Host-Rechte wegnehmen.
let ROLE = 'player';

export function setRole(role) {
  ROLE = role === 'host' ? 'host' : 'player';
}

export function clientId() {
  const key = `quizduell.clientId.${ROLE}`;
  let id = localStorage.getItem(key);
  if (!id) {
    id = `c_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    localStorage.setItem(key, id);
  }
  return id;
}

/**
 * Text nur schreiben, wenn er sich geändert hat.
 *
 * Klingt nach Mikrooptimierung, ist aber der Unterschied zwischen einer
 * nützlichen und einer unbenutzbaren Ansage: Ein Bereich mit aria-live meldet
 * jede Änderung seines Inhalts – und `textContent = x` tauscht den Textknoten
 * auch dann aus, wenn derselbe Satz drinsteht. Ohne diesen Vergleich würde ein
 * Screenreader „Buzzer frei" bei jedem Broadcast erneut vorlesen, also auch,
 * wenn nur irgendein Handy aus dem Standby kommt.
 */
export function setzeText(node, text) {
  if (!node || node.textContent === text) return;
  node.textContent = text;
}

export function toast(text, level = 'info') {
  const box = $('#toasts');
  if (!box) return;
  // Dieselbe Meldung nicht stapeln – bei hektischen Buzz-Versuchen sonst eine Wand.
  const same = [...box.children].find((n) => n.textContent === text);
  if (same) {
    same.remove();
  }
  const node = el('div', { class: `toast ${level}` }, text);
  box.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 300);
  }, 3200);
}

/* -------------------------------------------------------------- Verbindung */

let online = true;
const connectionListeners = new Set();

export function isOnline() {
  return online;
}

export function onConnectionChange(fn) {
  connectionListeners.add(fn);
  fn(online);
}

function setOnline(next) {
  if (online === next) return;
  online = next;
  const bar = $('#offline');
  if (bar) bar.hidden = next;
  for (const fn of connectionListeners) fn(next);
}

/**
 * Verbindet sich mit dem Server und ruft onState bei jeder Änderung auf.
 * Der Browser reconnected EventSource automatisch.
 */
export function connect({ role, onState, onEvent }) {
  setRole(role);
  const id = clientId();
  const source = new EventSource(`/api/events?clientId=${encodeURIComponent(id)}&role=${role}`);

  source.addEventListener('state', (ev) => {
    setOnline(true);
    const sicht = JSON.parse(ev.data);
    // Zentral gemerkt, damit weder Host-Screen noch Fernbedienung etwas davon
    // wissen müssen – siehe `lage` weiter oben.
    lage = sicht.lage || null;
    onState(sicht);
  });
  source.addEventListener('toast', (ev) => {
    const { level, text } = JSON.parse(ev.data);
    toast(text, level);
  });
  if (onEvent) {
    for (const name of ['buzz']) {
      source.addEventListener(name, (ev) => onEvent(name, JSON.parse(ev.data)));
    }
  }
  source.addEventListener('error', () => setOnline(false));

  return source;
}

export async function action(type, payload = {}, role = 'player') {
  try {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, type, role, clientId: clientId() }),
    });
    const data = await res.json().catch(() => ({ ok: false, error: 'Serverfehler' }));
    if (data.ok) setOnline(true);
    if (!data.ok && data.error && !payload.quiet) toast(data.error, 'error');
    return data;
  } catch {
    // WLAN weg oder Server neu gestartet – der Aufrufer muss das merken können,
    // sonst hält ein Spieler seinen Buzz für angekommen.
    setOnline(false);
    const data = { ok: false, error: 'Keine Verbindung zum Server', offline: true };
    if (!payload.quiet) toast(data.error, 'error');
    return data;
  }
}

/**
 * Aktionen des Hosts – Wertungen sind entprellt.
 *
 * Ein zweiter Druck kurz nach dem ersten (zitternder Finger, gehaltene Taste,
 * ungeduldiges Nachtippen) trifft nicht mehr dieselbe Situation: Nach „Falsch“
 * ist der Buzzer frei, und wenn in der Zwischenzeit jemand gedrückt hat, zieht
 * der zweite Klick ausgerechnet diesem Team die halben Punkte ab. Deshalb
 * sperrt jede Wertung kurz alle anderen – 400 ms, wie beim Spieler-Buzzer.
 */
const WERTUNGEN = new Set(['judge', 'pass', 'endQuestion', 'close']);
let letzteWertung = -Infinity;

/* Die Kennung der Lage, die zuletzt hereinkam. Sie fährt bei Wertungen mit
   zurück, damit der Server einen Druck ablehnen kann, der für die vorige
   Situation gedacht war – etwa „Richtig" fürs Zugteam, während schon jemand
   gebuzzert hat. Die Entprellung oben fängt den Zitterfinger auf demselben
   Gerät ab, aber nicht zwei Host-Geräte und nicht ein Nachtippen, wenn die
   Anzeige bei zäher Verbindung hinterherhinkt. */
let lage = null;
const LAGEGEBUNDEN = new Set([
  'judge', 'pass', 'openBuzz', 'reveal', 'endQuestion', 'close', 'resetBuzz', 'buzzFor',
]);

export function hostAction(type, payload = {}) {
  if (WERTUNGEN.has(type)) {
    const jetzt = performance.now();
    if (jetzt - letzteWertung < 400) return Promise.resolve({ ok: false, entprellt: true });
    letzteWertung = jetzt;
  }
  const daten = LAGEGEBUNDEN.has(type) && lage ? { ...payload, lage } : payload;
  return action(type, daten, 'host');
}

/* ---------------------------------------------------------------- Sounds */

let audio = null;

/**
 * iOS lässt Töne nur zu, wenn der AudioContext aus einer echten Nutzergeste
 * heraus gestartet wurde – deshalb einmal bei der ersten Berührung entsperren.
 */
export function unlockAudio() {
  try {
    // Läuft der Context schon, ist nichts zu tun. Ohne diesen Wächter entstand
    // bei jedem einzelnen Tippen ein neuer Oszillator samt GainNode – über
    // einen Abend Hunderte Knoten, die nur Speicher belegen.
    if (audio && audio.state === 'running') return;
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.01);
  } catch {
    /* ohne Ton geht es auch */
  }
}

export function installAudioUnlock() {
  // Die Horcher bleiben absichtlich hängen: Ein Context kann jederzeit wieder
  // einschlafen – Displaysperre, Anruf, Tabwechsel –, und dann braucht es für
  // das Aufwecken erneut eine echte Nutzergeste. Mit { once: true } wäre der
  // Ton nach dem ersten Einschlafen für immer weg. Dass dabei nicht bei jedem
  // Tippen Audio-Knoten entstehen, regelt der Wächter in unlockAudio().
  const once = () => unlockAudio();
  document.addEventListener('pointerdown', once, { passive: true });
  document.addEventListener('keydown', once);
  // Nach dem Sperren des Displays ist der Context wieder suspendiert.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') audio?.resume?.();
  });
}

/* Die ganze Tonspur entsteht im Browser aus Oszillatoren und einer Handvoll
   Rauschen. Keine Datei, kein Download – das Quiz klingt auch ohne Internet.

   Ein Ton ist eine Liste von Stimmen. Jede Stimme:
     f     Frequenz in Hz (oder [von, bis] für einen Glissando-Rutsch)
     at    Startzeit in Sekunden, relativ zum Auslösen
     d     Dauer
     v     Lautstärke 0..1
     t     Wellenform – 'triangle' weich, 'square' blechern, 'sawtooth' scharf
     rausch  statt Oszillator ein Rauschimpuls (Perkussion)
   Nichts dauert länger als eine Sekunde: Am Spieleabend wartet niemand auf
   einen Jingle. Die einzige Ausnahme ist die Fanfare am Spielende. */

const TON = 'triangle';

// Halbtonabstände auf eine Grundfrequenz – so bleiben Akkorde sauber gestimmt.
const halbton = (grund, n) => grund * 2 ** (n / 12);
const C5 = 523.25;

const KLAENGE = {
  // Feld gewählt: kurzer Doppelblip, mehr nicht.
  pick: [
    { f: 520, at: 0, d: 0.09, v: 0.2 },
    { f: 780, at: 0.06, d: 0.1, v: 0.2 },
  ],
  // Buzzer freigegeben: die Treppe hinauf, das Signal zum Losdrücken.
  armed: [
    { f: 520, at: 0, d: 0.11, v: 0.28 },
    { f: 780, at: 0.09, d: 0.11, v: 0.3 },
    { f: 1040, at: 0.18, d: 0.11, v: 0.32 },
    { f: 1300, at: 0.27, d: 0.2, v: 0.3 },
  ],
  // Jemand hat gedrückt: harter Anschlag mit Rauschkante, dann abwärts.
  buzz: [
    { rausch: true, at: 0, d: 0.06, v: 0.35 },
    { f: 880, at: 0, d: 0.1, v: 0.3, t: 'square' },
    { f: 660, at: 0.08, d: 0.1, v: 0.3, t: 'square' },
    { f: 520, at: 0.16, d: 0.18, v: 0.28, t: 'square' },
  ],
  // Richtig: Dur-Dreiklang aufwärts, oben bleibt die Oktave stehen.
  correct: [
    { f: halbton(C5, 0), at: 0, d: 0.12, v: 0.26 },
    { f: halbton(C5, 4), at: 0.08, d: 0.12, v: 0.26 },
    { f: halbton(C5, 7), at: 0.16, d: 0.12, v: 0.28 },
    { f: halbton(C5, 12), at: 0.24, d: 0.34, v: 0.3 },
    { f: halbton(C5, 7), at: 0.24, d: 0.34, v: 0.16 },
  ],
  // Falsch: der Rutsch nach unten, den jede Show für den Fehlgriff hat.
  wrong: [
    { f: [320, 150], at: 0, d: 0.38, v: 0.3, t: 'sawtooth' },
    { f: [160, 78], at: 0.02, d: 0.38, v: 0.2, t: 'sawtooth' },
  ],
  // Auflösen ohne Gewinner: sachlich, kein Triumph.
  reveal: [
    { f: 740, at: 0, d: 0.12, v: 0.22 },
    { f: 990, at: 0.08, d: 0.26, v: 0.24 },
  ],
  // „Wusste es nicht": Das kostet standardmäßig nichts und darf deshalb auch
  // nicht klingen wie ein Fehlgriff – zwei weiche Töne abwärts, mehr nicht.
  passt: [
    { f: 440, at: 0, d: 0.14, v: 0.2 },
    { f: 370, at: 0.1, d: 0.26, v: 0.2 },
  ],
  // Zu spät gedrückt: ein kurzer, dumpfer Anschlag. Kein Strafton – verloren
  // hat man ja nur das Rennen.
  zuspaet: [
    { f: 220, at: 0, d: 0.16, v: 0.22, t: 'sawtooth' },
    { rausch: true, at: 0, d: 0.08, v: 0.16 },
  ],
  // Rundenende: das Spiegelbild des Rundenstarts, ruhiger und abwärts.
  rundenende: [
    { f: halbton(C5, 12), at: 0, d: 0.16, v: 0.24, t: 'square' },
    { f: halbton(C5, 7), at: 0.14, d: 0.16, v: 0.22, t: 'square' },
    { f: halbton(C5, 0), at: 0.28, d: 0.44, v: 0.24, t: 'square' },
    { f: halbton(C5, -12), at: 0.28, d: 0.44, v: 0.16 },
  ],
  // Neue Runde: aufsteigender Rutsch und zwei Schläge – Vorhang auf.
  rundenstart: [
    { f: [220, 660], at: 0, d: 0.34, v: 0.22, t: 'sawtooth' },
    { rausch: true, at: 0.3, d: 0.12, v: 0.3 },
    { f: halbton(C5, 0), at: 0.32, d: 0.16, v: 0.3, t: 'square' },
    { f: halbton(C5, 7), at: 0.32, d: 0.16, v: 0.22, t: 'square' },
    { f: halbton(C5, 12), at: 0.48, d: 0.4, v: 0.3, t: 'square' },
  ],
  // Trommelwirbel: Rauschschläge, die schneller und lauter werden.
  trommel: Array.from({ length: 16 }, (_, i) => ({
    rausch: true,
    at: (i / 16) ** 1.5 * 1.1,
    d: 0.05,
    v: 0.1 + (i / 16) * 0.28,
  })),
  // Sieg: die einzige Stelle, an der eine ganze Sekunde erlaubt ist.
  fanfare: [
    { f: halbton(C5, -5), at: 0, d: 0.16, v: 0.28, t: 'square' },
    { f: halbton(C5, 0), at: 0.14, d: 0.16, v: 0.28, t: 'square' },
    { f: halbton(C5, 4), at: 0.28, d: 0.16, v: 0.28, t: 'square' },
    { f: halbton(C5, 7), at: 0.42, d: 0.5, v: 0.26, t: 'square' },
    // Der Schlussakkord liegt darunter und trägt.
    { f: halbton(C5, 0), at: 0.42, d: 0.85, v: 0.2 },
    { f: halbton(C5, 4), at: 0.42, d: 0.85, v: 0.16 },
    { f: halbton(C5, 12), at: 0.42, d: 0.85, v: 0.14 },
    { rausch: true, at: 0.42, d: 0.2, v: 0.22 },
  ],
};

/* Ton lässt sich abschalten – auf jedem Gerät für sich, denn der Beamer steht
   im Wohnzimmer und die Handys liegen zwischen den Leuten. */
const TON_AUS = 'quizduell.stumm';
let stumm = localStorage.getItem(TON_AUS) === '1';

export function istStumm() {
  return stumm;
}

export function setzeStumm(an) {
  stumm = !!an;
  localStorage.setItem(TON_AUS, stumm ? '1' : '0');
  return stumm;
}

/* Alle Stimmen laufen über einen Summenregler. Ohne ihn addieren sich die vier
   Stimmen der Fanfare auf über 1.0 und der Lautsprecher verzerrt – gemessen,
   nicht vermutet. Hier ist außerdem die eine Stelle, an der die Gesamtlautstärke
   später verändert werden könnte. */
export const TON_PEGEL = 0.6;

let summe = null;

function ausgang(ac) {
  if (!summe || summe.context !== ac) {
    summe = ac.createGain();
    summe.gain.value = TON_PEGEL;
    // Ein Begrenzer dahinter: Gemessen bleibt jeder einzelne Ton im Rahmen,
    // aber zwei überlappende – ein Buzz mitten in die Wertung – könnten sich
    // trotzdem addieren. Der Kompressor fängt genau das ab.
    const bremse = ac.createDynamicsCompressor();
    bremse.threshold.value = -12;
    bremse.ratio.value = 6;
    bremse.attack.value = 0.003;
    bremse.release.value = 0.18;
    summe.connect(bremse).connect(ac.destination);
  }
  return summe;
}

let rauschPuffer = null;

/** Ein kurzer Rauschimpuls als Perkussion – einmal erzeugt, danach geliehen. */
function rauschen(ac) {
  if (rauschPuffer) return rauschPuffer;
  const laenge = Math.floor(ac.sampleRate * 0.25);
  rauschPuffer = ac.createBuffer(1, laenge, ac.sampleRate);
  const daten = rauschPuffer.getChannelData(0);
  for (let i = 0; i < laenge; i++) {
    // Nach hinten leiser: so klingt es nach Schlag und nicht nach Zischen.
    daten[i] = (Math.random() * 2 - 1) * (1 - i / laenge) ** 2;
  }
  return rauschPuffer;
}

/** Kurze Töne ohne externe Dateien – funktioniert auch offline. */
export function sound(kind) {
  try {
    if (stumm) return;
    if (!audio) return; // noch keine Nutzergeste, also auch kein Ton
    if (audio.state === 'suspended') audio.resume();
    const ac = audio;
    const jetzt = ac.currentTime;
    const stimmen = KLAENGE[kind];
    if (!stimmen) return;

    for (const s of stimmen) {
      const start = jetzt + s.at;
      const gain = ac.createGain();
      // Exponentiell, aber nie auf echte Null – sonst knackt es.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(s.v, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + s.d);
      gain.connect(ausgang(ac));

      if (s.rausch) {
        const quelle = ac.createBufferSource();
        quelle.buffer = rauschen(ac);
        // Ohne Tiefpass klingt Rauschen nach Radio zwischen zwei Sendern.
        const filter = ac.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 1800;
        quelle.connect(filter).connect(gain);
        quelle.start(start);
        quelle.stop(start + s.d + 0.02);
        continue;
      }

      const osc = ac.createOscillator();
      osc.type = s.t || TON;
      if (Array.isArray(s.f)) {
        osc.frequency.setValueAtTime(s.f[0], start);
        osc.frequency.exponentialRampToValueAtTime(s.f[1], start + s.d);
      } else {
        osc.frequency.value = s.f;
      }
      osc.connect(gain);
      osc.start(start);
      osc.stop(start + s.d + 0.03);
    }
  } catch {
    /* Ton ist nur Beiwerk */
  }
}

export function vibrate(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* iOS kennt das nicht – dafür gibt es den Farbblitz */
  }
}

/** Bildschirmfüllender Farbblitz – das einzige Signal, das auch auf iPhones ankommt. */
export function flash(color = 'rgba(224,27,70,.55)') {
  const node = el('div', { class: 'screenflash', style: { background: color } });
  document.body.append(node);
  setTimeout(() => node.remove(), 500);
}

/** Verhindert, dass das Handy mitten im Spiel den Bildschirm abschaltet. */
/* Mehrfach aufrufbar, und das mit Absicht: Beim Laden fehlt die Nutzergeste, die
   manche Browser für die Sperre verlangen – beim Beitreten ist sie da. Der
   Horcher wird trotzdem nur einmal angemeldet, sonst sammelt jeder Beitritt
   einen weiteren an. */
let wachLock = null;
let wachHorcht = false;

export function keepScreenAwake() {
  const anfordern = async () => {
    if (wachLock) return;
    try {
      wachLock = await navigator.wakeLock?.request('screen');
      // Das System gibt die Sperre beim Wegschalten von selbst frei – ohne
      // dieses Aufräumen würde sie danach nie wieder angefordert.
      wachLock?.addEventListener?.('release', () => { wachLock = null; });
    } catch {
      wachLock = null; // nicht überall verfügbar
    }
  };
  anfordern();
  if (wachHorcht) return;
  wachHorcht = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') anfordern();
  });
  // Safari verweigert die Sperre, solange noch keine echte Geste kam. Ohne
  // diesen zweiten Anlauf bliebe sie den ganzen Abend aus – ausgerechnet auf
  // dem iPad, das nach zwei Minuten von selbst zumacht. Die Horcher bleiben
  // hängen, weil das System die Sperre jederzeit wieder abgeben kann.
  document.addEventListener('pointerdown', anfordern, { passive: true });
  document.addEventListener('keydown', anfordern);
}

/**
 * Schreibt einen Fragetext in ein Element. Zeilen ohne Buchstaben und Ziffern
 * sind reine Symbolzeilen – bei Emoji-Rätseln ist genau das die Frage, also
 * bekommen sie ihre eigene, deutlich größere Zeile.
 */
export function setFrageText(node, text) {
  node.innerHTML = '';
  const zeilen = String(text ?? '').split('\n');
  zeilen.forEach((zeile, i) => {
    if (i > 0) node.append(document.createElement('br'));
    const istSymbolzeile = zeile.trim() && !/[\p{L}\p{N}]/u.test(zeile);
    if (istSymbolzeile) {
      node.append(el('span', { class: 'symbolzeile' }, zeile.trim()));
    } else {
      node.append(document.createTextNode(zeile));
    }
  });
}

/**
 * Wie steht es um die Handys? – ein Satz für Leinwand und Fernbedienung.
 *
 * Die Teamliste zeigt zwar bei jedem Team, ob ein Handy dranhängt. Die Frage
 * beim Blick auf „Spiel starten" ist aber eine andere: Sind alle da? Bei acht
 * Teams zählt man das nicht gern von oben nach unten durch, während der Raum
 * wartet.
 *
 * Drei Dinge stehen darin, die die Teamliste nicht zeigen kann:
 * - Die Kopfzahl über alle Geräte. Ein Team gilt schon mit einem Handy als
 *   dabei – ob in einem Zweierteam auch der Partner drauf ist, sieht man nur
 *   an dieser Zahl.
 * - Die Namen der Teams, bei denen etwas fehlt, damit der Host sie ansprechen
 *   kann, statt „irgendwer fehlt noch" in den Raum zu rufen.
 * - Geräte, die verbunden sind, aber noch in keinem Team stehen. Wer den
 *   QR-Code gerade gescannt hat und den Namen tippt, kommt im Spielzustand gar
 *   nicht vor – ist aber genau der Grund, noch zehn Sekunden zu warten. Die
 *   Zahl kommt vom Server und steht nur in Host-Ansichten.
 *
 * Kein Ton von Mangel: Ohne Handys zu spielen ist vorgesehen, und der Satz
 * sagt das an der Stelle auch.
 *
 * Liefert { text, bereit } – `bereit`, wenn nichts mehr aussteht.
 */
export function anschlussStand(state) {
  const teams = state.teams || [];
  const wartende = state.wartende || 0;
  const imTeam = teams.reduce((summe, t) => summe + t.members.filter((m) => m.online).length, 0);
  const gesamt = imTeam + wartende;
  const handys = (n) => (n === 1 ? '1 Handy' : `${n} Handys`);

  if (!teams.length) {
    return { text: gesamt ? `${handys(gesamt)} schon verbunden – leg jetzt die Teams an.` : '', bereit: false };
  }

  const ohne = teams.filter((t) => !t.members.some((m) => m.online));
  if (!ohne.length && !wartende) {
    return { text: `${handys(gesamt)} verbunden – alle ${teams.length} Teams sind dabei.`, bereit: true };
  }
  if (!gesamt) {
    return {
      text: 'Noch kein Handy verbunden – ihr könnt auch ohne spielen, der Host drückt dann die Knöpfe.',
      bereit: false,
    };
  }

  // Bei vielen offenen Teams nicht die ganze Liste: Der Satz soll auf eine
  // Zeile passen, sonst wächst die klebende Leiste in die Karten hinein.
  const namen = ohne.map((t) => t.name);
  const teile = [`${handys(gesamt)} verbunden`];
  if (namen.length) {
    teile.push(`ohne Handy: ${namen.length <= 3
      ? namen.join(', ')
      : `${namen.slice(0, 2).join(', ')} und ${namen.length - 2} weitere`}`);
  }
  if (wartende) teile.push(`${wartende} noch ohne Team`);
  return { text: teile.join(' · '), bereit: false };
}
