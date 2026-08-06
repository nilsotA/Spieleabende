import { $, el, toast } from '/common.js';

const BASE_VALUES = [100, 200, 300, 500];
const STORAGE_KEY = 'quizduell.editor';

let set = load() || blankSet();

function blankRound() {
  return {
    categories: Array.from({ length: 6 }, (_, i) => ({
      name: `Kategorie ${i + 1}`,
      questions: Array.from({ length: 4 }, () => ({ text: '', answer: '', image: null, note: null })),
    })),
  };
}

function blankSet() {
  return { name: 'Neuer Fragensatz', description: '', rounds: [blankRound(), blankRound()] };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

let persistWarned = false;
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(set));
    persistWarned = false;
  } catch {
    // Passiert bei vielen eingebetteten Bildern. Stillschweigen wäre fatal:
    // der Nutzer glaubt, sein Stand sei gesichert.
    if (!persistWarned) {
      persistWarned = true;
      toast('Zwischenspeicher voll – bitte herunterladen oder auf dem Server speichern!', 'error');
    }
  }
}

/* ------------------------------------------------------------------ Render */

function render() {
  $('#set-name').value = set.name || '';
  const box = $('#rounds');
  box.innerHTML = '';

  set.rounds.forEach((round, ri) => {
    const mult = ri === 0 ? 1 : 2;
    const wrap = el('section', { class: 'round' },
      el('h2', {},
        `Runde ${ri + 1}`,
        el('span', { class: 'round-mult' }, mult > 1 ? `${mult}× Punkte` : ''),
        el('span', { class: 'grow' }),
        set.rounds.length > 1
          ? el('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: () => { set.rounds.splice(ri, 1); persist(); render(); },
          }, 'Runde entfernen')
          : null,
      ),
    );

    const cats = el('div', { class: 'cats' });
    round.categories.forEach((cat, ci) => {
      const card = el('div', { class: 'cat-card' },
        el('div', { class: 'cat-head' },
          el('input', {
            value: cat.name,
            maxlength: 40,
            placeholder: 'Kategoriename',
            oninput: (ev) => { cat.name = ev.target.value; persist(); },
          }),
          round.categories.length > 2
            ? el('button', {
              class: 'btn btn-sm btn-ghost',
              onclick: () => { round.categories.splice(ci, 1); persist(); render(); },
            }, '✕')
            : null,
        ),
      );

      cat.questions.forEach((q, qi) => {
        card.append(
          el('div', { class: 'qrow' },
            el('div', { class: 'val' }, String(BASE_VALUES[qi] * mult)),
            el('textarea', {
              placeholder: 'Frage',
              oninput: (ev) => { q.text = ev.target.value; persist(); },
            }, q.text || ''),
            el('textarea', {
              placeholder: 'Antwort',
              oninput: (ev) => { q.answer = ev.target.value; persist(); },
            }, q.answer || ''),
            el('div', { class: 'img-btn' },
              q.image ? el('img', { src: q.image, alt: '' }) : null,
              el('label', { class: 'btn btn-ghost btn-sm', style: { margin: 0, cursor: 'pointer' } },
                q.image ? 'Bild tauschen' : 'Bild …',
                el('input', {
                  type: 'file',
                  accept: 'image/*',
                  hidden: true,
                  onchange: (ev) => pickImage(ev, q),
                }),
              ),
              q.image
                ? el('button', {
                  class: 'btn btn-ghost btn-sm',
                  onclick: () => { q.image = null; persist(); render(); },
                }, 'Bild weg')
                : null,
            ),
          ),
        );
      });

      cats.append(card);
    });

    wrap.append(cats);
    wrap.append(
      el('div', { class: 'row', style: { justifyContent: 'center', marginTop: '.8rem' } },
        round.categories.length < 8
          ? el('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: () => {
              round.categories.push({
                name: `Kategorie ${round.categories.length + 1}`,
                questions: Array.from({ length: 4 }, () => ({ text: '', answer: '', image: null, note: null })),
              });
              persist();
              render();
            },
          }, '+ Kategorie')
          : null,
      ),
    );
    box.append(wrap);
  });
}

/** Bilder werden als Data-URL eingebettet – der Fragensatz bleibt eine einzige Datei. */
async function pickImage(ev, q) {
  const file = ev.target.files?.[0];
  if (!file) return;
  try {
    q.image = await shrinkImage(file, 900);
    persist();
    render();
  } catch (err) {
    toast('Bild konnte nicht geladen werden.', 'error');
  }
}

function shrinkImage(file, maxSide) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ---------------------------------------------------------------- Aktionen */

$('#set-name').addEventListener('input', (ev) => { set.name = ev.target.value; persist(); });

$('#btn-add-round').addEventListener('click', () => {
  set.rounds.push(blankRound());
  persist();
  render();
});

$('#btn-download').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(set, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `${slug(set.name)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

$('#btn-save').addEventListener('click', () => save(false));

async function save(overwrite) {
  const luecken = fehlendeFelder();
  if (luecken.length) {
    toast(`Noch unvollständig: ${luecken.slice(0, 3).join(', ')}${luecken.length > 3 ? ` und ${luecken.length - 3} weitere` : ''}`, 'error');
    return;
  }
  try {
    const res = await fetch('/api/sets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ set, file: `${slug(set.name)}.json`, overwrite }),
    });
    const data = await res.json();
    if (data.ok) {
      toast(`Gespeichert als ${data.file}`);
      loadSetList();
    } else if (data.exists) {
      if (confirm(`„${data.file}" gibt es schon. Überschreiben?`)) save(true);
    } else {
      toast(data.error || 'Speichern fehlgeschlagen.', 'error');
    }
  } catch (err) {
    toast('Speichern fehlgeschlagen: ' + err.message, 'error');
  }
}

/** Leere Fragen fallen sonst erst beim Spielstart auf – oder gar nicht. */
function fehlendeFelder() {
  const out = [];
  set.rounds.forEach((round, ri) => {
    round.categories.forEach((cat) => {
      cat.questions.forEach((q, qi) => {
        const wert = BASE_VALUES[qi] * (ri === 0 ? 1 : 2);
        if (!q.text?.trim() || !q.answer?.trim()) {
          out.push(`R${ri + 1} ${cat.name || '?'} ${wert}`);
        }
      });
    });
  });
  return out;
}

$('#file-input').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  try {
    set = normalizeLoaded(JSON.parse(await file.text()));
    persist();
    render();
    toast('Geladen.');
  } catch (err) {
    toast('Datei konnte nicht gelesen werden.', 'error');
  }
});

$('#btn-load').addEventListener('click', async () => {
  const file = $('#load-select').value;
  if (!file) return;
  try {
    set = normalizeLoaded(await (await fetch(`/api/set?file=${encodeURIComponent(file)}`)).json());
    persist();
    render();
    toast('Geladen.');
  } catch (err) {
    toast('Laden fehlgeschlagen.', 'error');
  }
});

async function loadSetList() {
  try {
    const sets = await (await fetch('/api/sets')).json();
    const select = $('#load-select');
    select.innerHTML = '';
    select.append(el('option', { value: '' }, 'Vorhandenen Satz laden …'));
    for (const s of sets) select.append(el('option', { value: s.file }, s.name));
  } catch {
    /* egal */
  }
}

function normalizeLoaded(raw) {
  const rounds = (raw.rounds || []).map((round) => ({
    categories: (round.categories || []).map((cat) => {
      const questions = (cat.questions || []).map((q) => ({
        text: q.text || '',
        answer: q.answer || '',
        image: q.image || null,
        note: q.note || null,
      }));
      while (questions.length < 4) questions.push({ text: '', answer: '', image: null, note: null });
      return { name: cat.name || '', questions: questions.slice(0, 4) };
    }),
  }));
  return {
    name: raw.name || 'Fragensatz',
    description: raw.description || '',
    rounds: rounds.length ? rounds : [blankRound(), blankRound()],
  };
}

function slug(str) {
  return String(str || 'fragensatz')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'fragensatz';
}

loadSetList();
render();
