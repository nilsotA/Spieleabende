// Host-Fernbedienung: zeigt Frage UND Lösung auf dem Handy des Hosts und
// erlaubt das Bewerten – damit die Lösung nie auf der Leinwand landet.
import { $, el, connect, action, sound, installAudioUnlock, keepScreenAwake, setFrageText } from '/common.js';

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
    if (name === 'buzz') sound('buzz');
  },
});

const act = (type, payload) => action(type, payload, 'host');

function render() {
  if (!state) return;
  const q = state.current;
  const teamName = (id) => state.teams.find((t) => t.id === id)?.name || '?';

  const phase = $('#r-phase');
  const box = $('#r-question');
  const bar = $('#r-buttons');
  bar.innerHTML = '';

  box.hidden = !q;
  if (q) {
    $('#r-cat').textContent = `${q.category} · ${q.value} Punkte`;
    setFrageText($('#r-text'), q.text);
    $('#r-answer').textContent = q.answer ?? '—';
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
      bar.append(big('Zug überspringen', 'btn-ghost', () => {
        const next = state.teams[(state.turnIndex + 1) % state.teams.length];
        act('setTurn', { teamId: next.id });
      }));
      break;
    case 'roundEnd':
      phase.textContent = `Runde ${state.round} beendet.`;
      bar.append(big('Nächste Runde', 'btn-primary', () => act('nextRound')));
      break;
    case 'gameOver':
      phase.textContent = 'Spiel beendet.';
      bar.append(big('Neues Spiel', 'btn-ghost', () => act('backToLobby')));
      break;
    case 'question':
      if (q.step === 'primary') {
        phase.textContent = `${teamName(q.teamId)} antwortet.`;
        bar.append(
          big('Richtig ✓', 'btn-good', () => act('judge', { correct: true })),
          big('Falsch ✗', 'btn-bad', () => act('judge', { correct: false })),
          big('Weiß nicht → Buzzer frei', 'btn-ghost', () => act('pass')),
        );
      } else if (q.step === 'buzz' && !q.buzzedTeamId) {
        phase.textContent = `Buzzer ist frei · ${q.halfValue} Punkte`;
        for (const team of state.teams) {
          if (team.id === q.teamId || q.lockedOut.includes(team.id)) continue;
          bar.append(big(`Buzz: ${team.name}`, 'btn-ghost', () => act('buzzFor', { teamId: team.id })));
        }
        bar.append(big('Keiner weiß es → auflösen', 'btn-primary', () => act('endQuestion')));
      } else if (q.buzzedTeamId) {
        phase.textContent = `${teamName(q.buzzedTeamId)} hat gebuzzert (±${q.halfValue}).`;
        bar.append(
          big('Richtig ✓', 'btn-good', () => act('judge', { correct: true })),
          big('Falsch ✗', 'btn-bad', () => act('judge', { correct: false })),
          big('Buzz zurücknehmen', 'btn-ghost', () => act('resetBuzz')),
        );
      } else {
        phase.textContent = 'Frage beendet.';
        bar.append(big('Weiter', 'btn-primary', () => act('close')));
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

function big(label, cls, onclick) {
  return el('button', { class: `btn ${cls} r-big`, type: 'button', onclick }, label);
}
