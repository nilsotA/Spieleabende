// Gemeinsame Basis für Host- und Spieler-Screen:
// Verbindung (SSE), Aktionen (POST) und ein paar Mini-Helfer.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
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

export function clientId() {
  let id = localStorage.getItem('quizduell.clientId');
  if (!id) {
    id = `c_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    localStorage.setItem('quizduell.clientId', id);
  }
  return id;
}

export function toast(text, level = 'info') {
  const box = $('#toasts');
  if (!box) return;
  const node = el('div', { class: `toast ${level}` }, text);
  box.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 300);
  }, 3200);
}

/**
 * Verbindet sich mit dem Server und ruft onState bei jeder Änderung auf.
 * Der Browser reconnected EventSource automatisch.
 */
export function connect({ role, onState, onEvent }) {
  const id = clientId();
  const source = new EventSource(`/api/events?clientId=${encodeURIComponent(id)}&role=${role}`);
  const offlineBar = $('#offline');

  source.addEventListener('state', (ev) => {
    if (offlineBar) offlineBar.hidden = true;
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
  source.addEventListener('error', () => {
    if (offlineBar) offlineBar.hidden = false;
  });

  return source;
}

export async function action(type, payload = {}, role = 'player') {
  const res = await fetch('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, type, role, clientId: clientId() }),
  });
  const data = await res.json().catch(() => ({ ok: false, error: 'Serverfehler' }));
  if (!data.ok && data.error) toast(data.error, 'error');
  return data;
}

/* ---------------------------------------------------------------- Sounds */

let audio;
function ctx() {
  if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
  if (audio.state === 'suspended') audio.resume();
  return audio;
}

/** Kurze Töne ohne externe Dateien – funktioniert auch offline. */
export function sound(kind) {
  try {
    const ac = ctx();
    const now = ac.currentTime;
    const notes = {
      buzz: [[880, 0], [660, 0.09], [520, 0.18]],
      correct: [[660, 0], [880, 0.1], [1180, 0.2]],
      wrong: [[300, 0], [200, 0.14]],
      pick: [[520, 0], [780, 0.06]],
      reveal: [[740, 0], [990, 0.08]],
    }[kind];
    if (!notes) return;
    for (const [freq, at] of notes) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = kind === 'wrong' ? 'sawtooth' : 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.25, now + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.22);
      osc.connect(gain).connect(ac.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.25);
    }
  } catch {
    /* Ton ist nur Beiwerk */
  }
}

export function vibrate(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* egal */
  }
}
