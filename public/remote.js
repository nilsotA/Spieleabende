// Host-Fernbedienung: zeigt Frage UND Lösung auf dem Handy des Hosts und
// erlaubt das Bewerten – damit die Lösung nie auf der Leinwand landet.
import {
  $, el, connect, hostAction, sound, vibrate, flash,
  installAudioUnlock, keepScreenAwake, setFrageText } from '/common.js';

let state = null;

installAudioUnlock();
keepScreenAwake();

connect({
  role: 'host',
  onState: (next) => {
    state = next;
    render();
  },
  onEvent: (name) => {
    if (name !== 'buzz') return;
    sound('buzz');
    // In einer lauten Runde geht ein Handylautsprecher unter, und mit gestelltem
    // Klingelschalter kommt WebAudio auf dem iPhone gar nicht erst durch. Der
    // Host darf den Buzz aber auf keinen Fall verpassen.
    vibrate([40, 50, 40]);
    flash();
  },
});

const act = hostAction;

function render() {
  if (!state) return;
  const q = state.current;
  const teamName = (id) => state.teams.find((t) => t.id === id)?.name || '?';

  const phase = $('#r-phase');
  const box = $('#r-question');
  const bar = $('#r-buttons');

  // Wie auf dem Host-Screen: Die Leiste darf sich nicht bei jedem Broadcast neu
  // aufbauen. Der Server sendet auch, wenn irgendein Handy aus dem Standby
  // kommt oder wegfällt – fällt so ein Update zwischen Finger-runter und Tipp,
  // ist der Knopf weg und die Wertung verpufft. Ausgerechnet auf dem Gerät, mit
  // dem der Host den ganzen Abend steuert.
  const barKey = [
    state.phase, q?.step, q?.buzzedTeamId, q?.teamId,
    (q?.lockedOut || []).join(','),
    state.teams.map((t) => `${t.id}:${t.name}`).join('|'),
    state.turnIndex,
  ].join('#');
  const neueLeiste = bar.dataset.key !== barKey;
  if (neueLeiste) {
    bar.dataset.key = barKey;
    bar.innerHTML = '';
  }
  const setz = (...knoepfe) => { if (neueLeiste) bar.append(...knoepfe); };

  box.hidden = !q;
  if (q) {
    $('#r-cat').textContent = `${q.category} · ${q.value} Punkte`;
    setFrageText($('#r-text'), q.text);
    // Ohne Bild müsste der Host sich zur Leinwand umdrehen – genau das soll
    // die Fernbedienung ja ersparen.
    const bild = $('#r-image');
    if (q.image) {
      if (bild.getAttribute('src') !== q.image) bild.src = q.image;
      bild.hidden = false;
    } else {
      bild.hidden = true;
      bild.removeAttribute('src');
    }
    $('#r-answer').textContent = q.answer ?? '—';
    // Der Zusatz ist das, was der Host vorlesen soll („Nicht Sydney"). Auf der
    // Leinwand erscheint er erst nach dem Auflösen – hier steht er von Anfang
    // an, denn hier liest ihn nur der Host.
    const note = $('#r-note');
    note.hidden = !q.note;
    note.textContent = q.note || '';
    const log = $('#r-log');
    log.innerHTML = '';
    for (const entry of q.log) {
      const label =
        entry.result === 'pass' ? 'wusste es nicht'
          : entry.result === 'correct' ? `richtig +${entry.delta}`
            : entry.delta ? `falsch ${entry.delta}` : 'falsch';
      log.append(el('span', { class: `r-chip ${entry.result}` }, `${teamName(entry.teamId)}: ${label}`));
    }
  }

  switch (state.phase) {
    case 'lobby':
      phase.textContent = 'Lobby – Teams anlegen und starten geht am großen Screen.';
      break;
    case 'board':
      phase.textContent = `Am Zug: ${teamName(state.teams[state.turnIndex]?.id)} – wählt ein Feld.`;
      setz(big('Zug überspringen', 'btn-ghost', () => {
        const next = state.teams[(state.turnIndex + 1) % state.teams.length];
        act('setTurn', { teamId: next.id });
      }));
      break;
    case 'roundEnd':
      phase.textContent = `Runde ${state.round} beendet.`;
      setz(big('Nächste Runde', 'btn-primary', () => act('nextRound')));
      break;
    case 'gameOver':
      phase.textContent = 'Spiel beendet.';
      setz(big('Neues Spiel', 'btn-ghost', () => act('backToLobby')));
      break;
    case 'question':
      if (q.step === 'primary') {
        phase.textContent = `${teamName(q.teamId)} antwortet.`;
        setz(
          big('Richtig ✓', 'btn-good', () => act('judge', { correct: true })),
          big('Falsch ✗', 'btn-bad', () => act('judge', { correct: false })),
          big('Weiß nicht → Buzzer frei', 'btn-ghost', () => act('pass')),
        );
      } else if (q.step === 'buzz' && !q.buzzedTeamId) {
        phase.textContent = `Buzzer ist frei · ${q.halfValue} Punkte`;
        for (const team of state.teams) {
          if (team.id === q.teamId || q.lockedOut.includes(team.id)) continue;
          setz(big(`Buzz: ${team.name}`, 'btn-ghost', () => act('buzzFor', { teamId: team.id })));
        }
        setz(big('Keiner weiß es → auflösen', 'btn-primary', () => act('endQuestion')));
      } else if (q.step === 'buzz' && q.buzzedTeamId) {
        phase.textContent = `${teamName(q.buzzedTeamId)} hat gebuzzert (±${q.halfValue}).`;
        setz(
          big('Richtig ✓', 'btn-good', () => act('judge', { correct: true })),
          big('Falsch ✗', 'btn-bad', () => act('judge', { correct: false })),
          big('Buzz zurücknehmen', 'btn-ghost', () => act('resetBuzz')),
        );
      } else {
        phase.textContent = 'Frage beendet.';
        setz(big('Weiter', 'btn-primary', () => act('close')));
      }
      break;
    default:
      phase.textContent = '';
  }

  const list = $('#r-teams');
  const key = state.teams.map((t) => `${t.id}:${t.score}`).join('|') + `#${state.turnIndex}`;
  if (list.dataset.key !== key) {
    list.dataset.key = key;
    list.innerHTML = '';
    state.teams.forEach((team, i) => {
      list.append(
        el('li', { class: i === state.turnIndex ? 'turn' : '' },
          el('span', { class: 'dot', style: { background: team.color } }),
          el('span', { class: 'grow' }, team.name),
          el('button', { class: 'btn btn-sm btn-ghost', onclick: () => act('adjustScore', { teamId: team.id, delta: -100 }) }, '−'),
          el('span', { class: 'sc' }, String(team.score)),
          el('button', { class: 'btn btn-sm btn-ghost', onclick: () => act('adjustScore', { teamId: team.id, delta: 100 }) }, '+'),
        ),
      );
    });
  }
}

/**
 * Ein Knopf der Fernbedienung – mit Anlaufsperre.
 *
 * Die Leiste ist ein Raster: Nach einer Wertung steht an genau derselben Stelle
 * ein anderer Knopf. Wer „Weiter" tippt und den Daumen kurz danach noch einmal
 * absetzt, trifft „Neues Spiel" – und das Spiel ist weg. Deshalb ist ein frisch
 * erschienener Knopf 400 ms lang taub. Wer bewusst tippt, merkt davon nichts;
 * wer nachtippt, richtet keinen Schaden mehr an.
 */
function big(label, cls, onclick) {
  const geboren = performance.now();
  return el('button', {
    class: `btn ${cls} r-big`,
    type: 'button',
    onclick: () => {
      if (performance.now() - geboren < 400) return;
      onclick();
    },
  }, label);
}
