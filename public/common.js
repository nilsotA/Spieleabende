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
    onState(JSON.parse(ev.data));
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

/* ---------------------------------------------------------------- Sounds */

let audio = null;

/**
 * iOS lässt Töne nur zu, wenn der AudioContext aus einer echten Nutzergeste
 * heraus gestartet wurde – deshalb einmal bei der ersten Berührung entsperren.
 */
export function unlockAudio() {
  try {
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
  const once = () => unlockAudio();
  document.addEventListener('pointerdown', once, { passive: true });
  document.addEventListener('keydown', once);
  // Nach dem Sperren des Displays ist der Context wieder suspendiert.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') audio?.resume?.();
  });
}

/** Kurze Töne ohne externe Dateien – funktioniert auch offline. */
export function sound(kind) {
  try {
    if (!audio) return; // noch keine Nutzergeste, also auch kein Ton
    if (audio.state === 'suspended') audio.resume();
    const ac = audio;
    const now = ac.currentTime;
    const notes = {
      buzz: [[880, 0, 0.3], [660, 0.09, 0.3], [520, 0.18, 0.3]],
      armed: [[520, 0, 0.3], [780, 0.1, 0.32], [1040, 0.2, 0.34], [1300, 0.3, 0.3]],
      correct: [[660, 0, 0.3], [880, 0.1, 0.3], [1180, 0.2, 0.32]],
      wrong: [[300, 0, 0.3], [200, 0.14, 0.3]],
      pick: [[520, 0, 0.22], [780, 0.06, 0.22]],
      reveal: [[740, 0, 0.26], [990, 0.08, 0.26]],
    }[kind];
    if (!notes) return;
    for (const [freq, at, vol] of notes) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = kind === 'wrong' ? 'sawtooth' : 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(vol, now + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.24);
      osc.connect(gain).connect(ac.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.27);
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
export function keepScreenAwake() {
  let lock = null;
  const request = async () => {
    try {
      lock = await navigator.wakeLock?.request('screen');
      // Das System gibt die Sperre beim Wegschalten von selbst frei – ohne
      // dieses Aufräumen würde sie danach nie wieder angefordert.
      lock?.addEventListener?.('release', () => { lock = null; });
    } catch {
      lock = null; // nicht überall verfügbar
    }
  };
  request();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !lock) request();
  });
}
