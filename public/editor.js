import { $, el, toast } from '/common.js';
import { verraeteneLoesungen } from '/fragenpruefung.js';

const BASE_VALUES = [100, 200, 300, 500];
const STORAGE_KEY = 'quizduell.editor';

const gemerkt = load();
let set = gemerkt?.set || blankSet();
let zielDatei = gemerkt?.zielDatei || null; // zuletzt geladene Datei – dorthin wird gespeichert

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
    if (!raw) return null;
    const daten = JSON.parse(raw);
    // Ältere Stände enthalten nur den Satz selbst, ohne Zieldatei.
    return Array.isArray(daten?.rounds) ? { set: daten, zielDatei: null } : daten;
  } catch {
    return null;
  }
}

// Bei jedem Tastendruck den ganzen Satz samt Bildern zu serialisieren ist teuer.
let persistTimer;
function persistSoon() {
  updateFortschritt(); // die Anzeige soll beim Tippen sofort mitlaufen
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 500);
}
window.addEventListener('blur', () => persist());
document.addEventListener('visibilitychange', () => persist());

function persist() {
  try {
    // Auch merken, wohin gespeichert wird: Nach einem Neuladen war das sonst
    // vergessen, und „Speichern" legte plötzlich eine zweite Datei unter dem
    // Namen des Satzes an, statt die geladene zu aktualisieren.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ set, zielDatei }));
    zeigeSpeicherwarnung(false);
  } catch {
    // Passiert bei vielen eingebetteten Bildern. Ein Toast wäre hier fatal: Er
    // verschwindet nach drei Sekunden, und danach sieht der Editor wieder
    // kerngesund aus, während in Wahrheit nichts mehr gesichert wird. Deshalb
    // ein Balken, der stehen bleibt, bis es wieder klappt.
    zeigeSpeicherwarnung(true);
  }
}

/** Bleibt sichtbar, solange nichts mehr in den Zwischenspeicher passt. */
function zeigeSpeicherwarnung(an) {
  const box = $('#speicher-warnung');
  if (box) box.hidden = !an;
}

/**
 * Rückfrage vor dem Löschen – aber nur, wenn wirklich Arbeit dranhängt.
 * Eine leere Kategorie wegzuklicken soll niemanden aufhalten; 24 getippte
 * Fragen zu verlieren, weil man einmal danebengetippt hat, dagegen schon.
 * Rückgängig gibt es nicht: Der Zwischenspeicher wird sofort überschrieben.
 */
function wirklichLoeschen(was, anzahlFragen) {
  if (anzahlFragen === 0) return true;
  return confirm(
    `${was} entfernen?\n\n${anzahlFragen} ausgefüllte ${anzahlFragen === 1 ? 'Frage geht' : 'Fragen gehen'} `
    + 'dabei verloren. Das lässt sich nicht rückgängig machen.',
  );
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
            onclick: () => {
              const wieviele = round.categories.reduce((n, c) => n + c.questions.filter((q) => q.text.trim()).length, 0);
              if (!wirklichLoeschen(`Runde ${ri + 1}`, wieviele)) return;
              set.rounds.splice(ri, 1);
              persist();
              render();
            },
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
            'aria-label': `Name der ${ci + 1}. Kategorie in Runde ${ri + 1}`,
            oninput: (ev) => {
              cat.name = ev.target.value;
              // Die Felder darunter tragen den Kategorienamen in ihrem
              // Vorlesetext. Neu gezeichnet wird beim Tippen bewusst nichts –
              // also hier nachziehen, sonst nennt die Vorlesehilfe den ganzen
              // Abend „Kategorie 3", während oben „Erdkunde" steht.
              benenneFelder(card, cat, ri, ci, mult);
              persistSoon();
            },
          }),
          round.categories.length > 2
            ? el('button', {
              class: 'btn btn-sm btn-ghost',
              title: 'Diese Kategorie entfernen',
              'aria-label': `Kategorie „${cat.name}“ entfernen`,
              onclick: () => {
                const wieviele = cat.questions.filter((q) => q.text.trim()).length;
                if (!wirklichLoeschen(`die Kategorie „${cat.name}“`, wieviele)) return;
                round.categories.splice(ci, 1);
                persist();
                render();
              },
            }, '✕')
            : null,
        ),
      );

      cat.questions.forEach((q, qi) => {
        // Woher ein Feld kommt, steht nur links daneben (der Punktwert) und
        // ganz oben in der Karte (der Kategoriename). Vorgelesen bekam man
        // 144-mal „Frage", „Antwort", „Zusatz" – ohne zu wissen, in welcher
        // Kategorie und bei welchem Wert man gerade ist. Der Zusatz nennt
        // beides; sichtbar ändert sich nichts.
        // Die Runde gehört dazu: Runde 2 verdoppelt, und ohne sie hieße die
        // zweite Zeile von Runde 1 genauso wie die erste von Runde 2 – beide
        // stehen bei 200 Punkten.
        const wo = `Runde ${ri + 1}, ${cat.name || `Kategorie ${ci + 1}`}, ${BASE_VALUES[qi] * mult} Punkte`;
        card.append(
          el('div', { class: 'qrow' },
            el('div', { class: 'val' }, String(BASE_VALUES[qi] * mult)),
            el('textarea', {
              placeholder: 'Frage',
              'aria-label': `Frage – ${wo}`,
              oninput: (ev) => {
                q.text = ev.target.value;
                laengeMarkieren(ev.target);
                hoeheAnpassen(ev.target);
                verraeterMarkieren();
                persistSoon();
              },
            }, q.text || ''),
            el('div', { class: 'antwort' },
              el('textarea', {
                placeholder: 'Antwort',
                'aria-label': `Antwort – ${wo}`,
                oninput: (ev) => {
                  q.answer = ev.target.value;
                  hoeheAnpassen(ev.target);
                  verraeterMarkieren();
                  persistSoon();
                },
              }, q.answer || ''),
              // Der Zusatz erscheint beim Auflösen klein unter der Lösung –
              // gut für „Nicht Sydney!" oder eine Quellenangabe.
              //
              // Als einzeiliges Feld war er nach rund 60 Zeichen zu Ende zu
              // sehen: „Magellan selbst starb unterwegs – heimgebracht hat das
              // letzte S…". Wer nachlesen will, was er geschrieben hat, musste
              // im Feld scrollen. Jetzt umbricht er und wächst mit.
              el('textarea', {
                class: 'notiz',
                placeholder: 'Zusatz beim Auflösen (optional)',
                'aria-label': `Zusatz beim Auflösen – ${wo}`,
                maxlength: 200,
                rows: 1,
                oninput: (ev) => {
                  q.note = ev.target.value.trim() || null;
                  hoeheAnpassen(ev.target);
                  persistSoon();
                },
              }, q.note || ''),
            ),
            el('div', { class: 'img-btn' },
              q.image ? el('img', { src: q.image, alt: '' }) : null,
              // datei-knopf: Das Feld liegt unsichtbar über dem Knopf, statt
              // per `hidden` aus dem Tabulator-Lauf zu fallen – sonst kommt man
              // mit der Tastatur nie an die Bildauswahl.
              el('label', { class: 'btn btn-ghost btn-sm datei-knopf', style: { margin: 0, cursor: 'pointer' } },
                q.image ? 'Bild tauschen' : 'Bild …',
                el('input', {
                  type: 'file',
                  accept: 'image/*',
                  'aria-label': `Bild für die ${BASE_VALUES[qi] * mult}-Frage wählen`,
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
              // render() baut alles neu, der Fokus fällt dabei auf <body>.
              // Wer eine Kategorie anlegt, will sie als Nächstes benennen.
              fokussiereKategorie(ri, round.categories.length - 1);
            },
          }, '+ Kategorie')
          : null,
      ),
    );
    box.append(wrap);
  });
  updateFortschritt();
  zeigeZiel();
  alleLaengenMarkieren();
  // Nach dem Neuaufbau stehen alle Felder auf ihrer Grundhöhe – die muss zum
  // Inhalt passen, sonst sieht man von einem geladenen Satz nur den Anfang.
  // Alle auf einmal, nicht einzeln beim Bauen: So liest der Browser die Höhen
  // in einem Durchgang, statt für jedes Feld neu zu rechnen.
  for (const feld of box.querySelectorAll('.qrow textarea')) hoeheAnpassen(feld);
}

/**
 * Vorlesetexte der Felder einer Kategorie neu setzen.
 *
 * Steht getrennt, weil beim Umbenennen einer Kategorie nichts neu gezeichnet
 * wird – der Cursor im Namensfeld soll ja stehen bleiben.
 */
function benenneFelder(card, cat, ri, ci, mult) {
  card.querySelectorAll('.qrow').forEach((zeile, qi) => {
    const wo = `Runde ${ri + 1}, ${cat.name || `Kategorie ${ci + 1}`}, ${BASE_VALUES[qi] * mult} Punkte`;
    const felder = zeile.querySelectorAll('textarea');
    if (felder[0]) felder[0].setAttribute('aria-label', `Frage – ${wo}`);
    if (felder[1]) felder[1].setAttribute('aria-label', `Antwort – ${wo}`);
    if (felder[2]) felder[2].setAttribute('aria-label', `Zusatz beim Auflösen – ${wo}`);
  });
}

/**
 * Ein Textfeld auf die Höhe seines Inhalts bringen.
 *
 * Erst auf `auto` zurücksetzen, sonst wächst es nur und schrumpft nie wieder:
 * `scrollHeight` kann die eingestellte Höhe nicht unterschreiten.
 */
function hoeheAnpassen(feld) {
  feld.style.height = 'auto';
  feld.style.height = `${feld.scrollHeight}px`;
}
/** Wohin „Auf dem Server speichern" schreibt – vorher wusste man das erst danach. */
function zeigeZiel() {
  const ziel = $('#ziel-datei');
  if (!ziel) return;
  ziel.textContent = zielDatei
    ? `Speichern schreibt nach data/${zielDatei}`
    : `Speichern legt data/${slug(set.name)}.json an`;
}

/** Bilder werden als Data-URL eingebettet – der Fragensatz bleibt eine einzige Datei. */
const MAX_BILD = 12 * 1024 * 1024;

async function pickImage(ev, q) {
  const file = ev.target.files?.[0];
  const knopf = ev.target.closest('label');
  if (!file) return;

  // Ein 12-MP-Handyfoto zu dekodieren und zu verkleinern dauert auf dem
  // Hauptthread spürbar. Ohne Rückmeldung wirkt der Editor in dieser Zeit
  // eingefroren, und viele klicken dann ein zweites Mal.
  const beschriftung = knopf?.firstChild;
  const alterText = beschriftung?.textContent;
  if (beschriftung) beschriftung.textContent = 'lädt …';
  ev.target.value = ''; // dieselbe Datei soll erneut wählbar bleiben

  try {
    if (file.size > MAX_BILD) {
      throw new Error(`Das Bild ist ${(file.size / 1024 / 1024).toFixed(1)} MB groß – bitte kleiner als 12 MB.`);
    }
    q.image = await shrinkImage(file, 900);
    persist();
    render();
  } catch (err) {
    // SVG ohne feste Größe hat naturalWidth 0 – das Ergebnis wäre eine leere
    // weiße Fläche, also lieber ehrlich absagen.
    toast(err.message || 'Bild konnte nicht geladen werden.', 'error');
    if (beschriftung) beschriftung.textContent = alterText;
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
        // SVG ohne width/height im Markup liefert 0 – dann käme eine leere
        // weiße Fläche heraus, und niemand wüsste, warum.
        if (!img.width || !img.height) {
          return reject(new Error('Dieses Bild hat keine feste Größe (bei SVG häufig). Bitte als PNG oder JPG einfügen.'));
        }
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        // Ohne weissen Grund werden transparente Bereiche im JPEG schwarz.
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ---------------------------------------------------------------- Aktionen */

$('#set-name').addEventListener('input', (ev) => { set.name = ev.target.value; persistSoon(); zeigeZiel(); });

$('#btn-add-round').addEventListener('click', () => {
  set.rounds.push(blankRound());
  persist();
  render();
  fokussiereKategorie(set.rounds.length - 1, 0);
});

/** Nach dem Neubau den Namen der frisch angelegten Kategorie anspringen. */
function fokussiereKategorie(rundenIndex, katIndex) {
  const runde = document.querySelectorAll('.round')[rundenIndex];
  const feld = runde?.querySelectorAll('.cat-head input')[katIndex];
  if (!feld) return;
  feld.focus();
  feld.select(); // der Platzhaltername soll beim Tippen sofort weg sein
}

$('#btn-download').addEventListener('click', () => {
  const luecken = fehlendeFelder();
  if (luecken.length && !confirm(`${luecken.length} Felder sind noch leer – trotzdem herunterladen?`)) return;
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
  // Ohne Namen landete der Satz als „fragensatz.json" auf der Platte und hieß
  // in der Lobby „Fragensatz“. Wer 48 Fragen geschrieben hat, findet ihn dann
  // zwischen den anderen nicht wieder – und der nächste namenlose Satz will
  // dieselbe Datei. Der Name ist das Einzige, woran man einen Satz später
  // erkennt, also wird hier danach gefragt statt still etwas zu erfinden.
  if (!String(set.name || '').trim()) {
    toast('Der Fragensatz braucht einen Namen – daran erkennst du ihn später in der Lobby.', 'error');
    $('#set-name').focus();
    return;
  }
  const luecken = fehlendeFelder();
  if (luecken.length) {
    toast(`Noch unvollständig: ${luecken.slice(0, 3).map((l) => l.label).join(', ')}${luecken.length > 3 ? ` und ${luecken.length - 3} weitere` : ''}`, 'error');
    return;
  }
  try {
    const res = await fetch('/api/sets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ set, file: zielDatei || `${slug(set.name)}.json`, overwrite }),
    });
    const data = await res.json();
    if (data.ok) {
      zielDatei = data.file;
      zeigeZiel();
      toast(`Gespeichert als ${data.file}`);
      loadSetList();
    } else if (data.exists) {
      // Wer hier abbricht, hat auf „Speichern“ gedrückt und sieht sonst gar
      // nichts passieren – und weiß nicht, ob der Klick angekommen ist.
      if (confirm(`„${data.file}“ gibt es schon. Überschreiben?`)) save(true);
      else toast('Nicht gespeichert – der Satz behält seinen bisherigen Stand auf der Platte.');
    } else {
      toast(data.error || 'Speichern fehlgeschlagen.', 'error');
    }
  } catch (err) {
    toast('Speichern fehlgeschlagen: ' + err.message, 'error');
  }
}

/**
 * 48 Fragen zu schreiben ist viel – sichtbar zu machen, wie weit man ist und
 * wo noch Lücken sind, nimmt der Sache das Zähe.
 */
/**
 * Sehr lange Fragen als solche kenntlich machen.
 *
 * Auf der Leinwand wird die Schrift so weit heruntergerechnet, bis alles
 * draufpasst – bei einem ganzen Absatz landet sie dabei bei einem Bruchteil
 * ihrer Größe und ist aus vier Metern nicht mehr zu lesen. Das merkt man beim
 * Tippen nicht, sondern erst am Abend. Die Grenze ist gemessen: Bis etwa 180
 * Zeichen bleibt die Frage auf einem 900px-Screen in voller Größe.
 */
const LEINWAND_GRENZE = 180;

function laengeMarkieren(feld) {
  const zulang = (feld.value || '').length > LEINWAND_GRENZE;
  feld.classList.toggle('zulang', zulang);
  feld.title = zulang
    ? `${feld.value.length} Zeichen – das wird auf der Leinwand klein. Unter ${LEINWAND_GRENZE} bleibt es groß.`
    : '';
}

function alleLaengenMarkieren() {
  for (const feld of document.querySelectorAll('.qrow > textarea')) laengeMarkieren(feld);
  verraeterMarkieren();
}

/**
 * Steht eine Lösung schon in einer anderen Frage derselben Kategorie?
 *
 * Das ist der Fehler, der einen Spielabend wirklich kostet: Die Kategorie
 * steht offen auf der Leinwand, und wer lesen kann, holt sich die teuerste
 * Frage geschenkt. Beim Tippen fällt es kaum auf – zwischen den beiden Zeilen
 * liegen ja zwei andere.
 *
 * Geprüft wird mit derselben Regel, die auch über den fertigen Satz läuft.
 * Gewarnt wird, nicht verboten: Manchmal ist die Wiederholung Absicht, und ein
 * Editor, der das Speichern verweigert, wäre schlimmer als das Problem.
 */
function verraeterMarkieren() {
  const zeilen = [...document.querySelectorAll('.qrow')];
  for (const z of zeilen) {
    z.classList.remove('verraet');
    const feld = z.querySelector('.antwort > textarea');
    if (feld) feld.title = '';
  }

  let index = 0;
  let gefunden = 0;
  let ersteZeile = null;
  for (const runde of set.rounds) {
    for (const cat of runde.categories) {
      const treffer = verraeteneLoesungen(cat.questions);
      for (const { i, j } of treffer) {
        const zeile = zeilen[index + i];
        if (!zeile || zeile.classList.contains('verraet')) continue;
        zeile.classList.add('verraet');
        const feld = zeile.querySelector('.antwort > textarea');
        if (feld) {
          const andere = (cat.questions[j].text || '').slice(0, 60);
          feld.title = 'Diese Lösung steht schon in einer anderen Frage dieser Kategorie '
            + `– auf der Leinwand ist sie damit verschenkt:\n„${andere}…“`;
        }
        gefunden += 1;
        if (!ersteZeile) ersteZeile = zeile;
      }
      index += cat.questions.length;
    }
  }

  const hinweis = $('#fortschritt-verraet');
  if (hinweis) {
    hinweis.hidden = gefunden === 0;
    hinweis.textContent = gefunden === 1
      ? '1 Lösung steht schon in einer anderen Frage derselben Kategorie.'
      : `${gefunden} Lösungen stehen schon in anderen Fragen derselben Kategorie.`;
    hinweis.onclick = ersteZeile
      ? () => ersteZeile.scrollIntoView({
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'center',
      })
      : null;
  }
}

function updateFortschritt() {
  const gesamt = set.rounds.reduce((n, r) => n + r.categories.length * 4, 0);
  const offen = fehlendeFelder();
  const fertig = gesamt - offen.length;
  const knopf = $('#fortschritt');
  $('#fortschritt-balken').style.transform = `scaleX(${gesamt ? fertig / gesamt : 0})`;
  $('#fortschritt-text').textContent = offen.length
    ? `${fertig} von ${gesamt} Fragen fertig · nächste Lücke: ${offen[0].label}`
    : `Alle ${gesamt} Fragen ausgefüllt`;
  knopf.classList.toggle('fertig', offen.length === 0);

  // Nebenbei: Wie viele Fragen sind zu lang für eine Leinwand? Das steht hier
  // und nicht als Hindernis beim Speichern – geschrieben ist geschrieben, und
  // manchmal muss eine Frage eben lang sein.
  const lange = set.rounds.flatMap((r) => r.categories)
    .flatMap((c) => c.questions)
    .filter((q) => (q.text || '').length > LEINWAND_GRENZE).length;
  const hinweis = $('#fortschritt-lang');
  if (hinweis) {
    hinweis.hidden = lange === 0;
    hinweis.textContent = lange === 1
      ? '1 Frage ist sehr lang – die wird auf der Leinwand klein.'
      : `${lange} Fragen sind sehr lang – die werden auf der Leinwand klein.`;
  }
}

$('#fortschritt').addEventListener('click', () => {
  const offen = fehlendeFelder();
  if (!offen.length) return;
  const feld = document.querySelectorAll('.qrow')[offen[0].index];
  if (!feld) return;
  feld.scrollIntoView({
    // Wer weniger Bewegung eingestellt hat, will auch nicht durch 48 Fragen
    // gescrollt werden.
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'center',
  });
  feld.classList.add('luecke');
  setTimeout(() => feld.classList.remove('luecke'), 1600);
  feld.querySelector('textarea')?.focus();
});

/** Leere Fragen fallen sonst erst beim Spielstart auf – oder gar nicht. */
function fehlendeFelder() {
  const out = [];
  let index = 0;
  set.rounds.forEach((round, ri) => {
    round.categories.forEach((cat) => {
      cat.questions.forEach((q, qi) => {
        const wert = BASE_VALUES[qi] * (ri === 0 ? 1 : 2);
        if (!q.text?.trim() || !q.answer?.trim()) {
          out.push({ label: `R${ri + 1} ${cat.name || '?'} ${wert}`, index });
        }
        index++;
      });
    });
  });
  return out;
}

$('#file-input').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    if (!Array.isArray(raw?.rounds)) throw new Error('Das ist kein Fragensatz.');
    if (!verwerfenOk()) return;
    set = normalizeLoaded(raw);
    zielDatei = file.name;
    persist();
    render();
    toast('Geladen.');
  } catch (err) {
    toast(`Datei konnte nicht gelesen werden: ${err.message}`, 'error');
  } finally {
    ev.target.value = '';
  }
});

$('#btn-load').addEventListener('click', async () => {
  const file = $('#load-select').value;
  if (!file) return;
  try {
    const res = await fetch(`/api/set?file=${encodeURIComponent(file)}`);
    const raw = await res.json();
    if (!res.ok || raw.error) throw new Error(raw.error || 'Satz konnte nicht gelesen werden.');
    if (!Array.isArray(raw.rounds)) throw new Error('Das ist kein Fragensatz.');
    if (!verwerfenOk()) return;
    set = normalizeLoaded(raw);
    zielDatei = file;
    persist();
    render();
    toast('Geladen.');
  } catch (err) {
    toast(`Laden fehlgeschlagen: ${err.message}`, 'error');
  }
});

/** Der Editor haelt nur einen Satz – vor dem Ueberschreiben also fragen. */
function verwerfenOk() {
  const hatInhalt = set.rounds.some((r) => r.categories.some((c) => c.questions.some((q) => q.text?.trim() || q.answer?.trim())));
  return !hatInhalt || confirm('Der aktuelle Fragensatz wird ersetzt. Vorher heruntergeladen?');
}

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
      if (questions.length > 4) {
        toast(`Kategorie „${cat.name || '?'}“ hatte ${questions.length} Fragen – nur die ersten 4 werden übernommen.`, 'error');
      }
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

/**
 * Die Kopfleiste rückt zusammen, sobald man im Formular arbeitet.
 *
 * Gemessen wird an der Marke direkt unter der Leiste, nicht an `scrollY`.
 * Grund steht in editor.html: Das Zusammenrücken verkürzt die Seite, der
 * Browser zieht den Scrollwert nach – und gegen `scrollY` geprüft klappte die
 * Leiste dadurch endlos auf und zu. Die Marke bewegt sich bei diesem Nachziehen
 * nicht, weil genau das der Zweck des Nachziehens ist.
 */
function leisteAnpassen() {
  const bar = document.querySelector('.bar');
  const marke = document.querySelector('#bar-marke');
  if (!bar || !marke) return;
  const oben = marke.getBoundingClientRect().top;
  const eng = bar.classList.contains('eng');
  if (!eng && oben < 60) bar.classList.add('eng');
  else if (eng && oben > 90) bar.classList.remove('eng');
}
addEventListener('scroll', leisteAnpassen, { passive: true });

loadSetList();
render();
updateFortschritt();
alleLaengenMarkieren();
leisteAnpassen();
