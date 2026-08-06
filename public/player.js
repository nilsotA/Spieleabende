import { $, el, connect, action, toast, sound, vibrate } from '/common.js';

let state = null;
let selectedTeam = localStorage.getItem('quizduell.teamId') || null;

$('#my-name').value = localStorage.getItem('quizduell.name') || '';

connect({
  role: 'player',
  onState: (next) => {
    const prev = state;
    state = next;
    render(prev);
  },
  onEvent: (name, data) => {
    if (name === 'buzz' && data.teamId === state?.you?.teamId) vibrate([40, 40, 80]);
  },
});

/* ---------------------------------------------------------------- Anmeldung */

$('#join-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const name = $('#my-name').value.trim();
  if (!name) return;
  if (!selectedTeam) return toast('Bitte ein Team auswählen.', 'error');
  localStorage.setItem('quizduell.name', name);
  localStorage.setItem('quizduell.teamId', selectedTeam);
  await action('joinTeam', { teamId: selectedTeam, name });
});

$('#btn-leave').addEventListener('click', () => action('leaveTeam'));

/* ------------------------------------------------------------------ Buzzer */

const buzzer = $('#buzzer');
let buzzLock = false;

function pressBuzzer() {
  if (buzzer.disabled || buzzLock) return;
  buzzLock = true;
  setTimeout(() => (buzzLock = false), 400);
  vibrate(60);
  sound('buzz');
  action('buzz');
}

// pointerdown statt click: spart die ~100 ms bis zum click-Event.
buzzer.addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  pressBuzzer();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === ' ' && document.activeElement?.tagName !== 'INPUT') {
    ev.preventDefault();
    pressBuzzer();
  }
});

/* ------------------------------------------------------------------ Render */

function render(prev) {
  if (!state) return;
  const joined = !!state.you?.teamId;
  $('#view-join').classList.toggle('active', !joined);
  $('#view-play').classList.toggle('active', joined);
  if (!joined) return renderJoin();

  const me = state.teams.find((t) => t.id === state.you.teamId);
  $('#p-team').textContent = me?.name || '—';
  $('#p-name').textContent = (me?.members || []).map((m) => m.name).join(', ');
  $('#p-score').textContent = me?.score ?? 0;

  renderQuestion();
  renderPicker();
  renderBuzzer(prev);
  renderScores();
}

function renderJoin() {
  const box = $('#team-choices');
  box.innerHTML = '';
  if (!state.teams.length) {
    box.append(el('p', { class: 'muted small' }, 'Der Host hat noch keine Teams angelegt. Gleich geht’s los …'));
  }
  for (const team of state.teams) {
    const node = el('button', {
      type: 'button',
      class: `team-choice ${selectedTeam === team.id ? 'selected' : ''}`,
      onclick: () => { selectedTeam = team.id; renderJoin(); },
    },
      el('span', { class: 'dot', style: { background: team.color } }),
      el('span', {},
        el('div', {}, team.name),
        el('div', { class: 'sub' },
          team.members.length ? team.members.map((m) => m.name).join(', ') : 'noch frei'),
      ),
    );
    box.append(node);
  }
  $('#join-hint').textContent =
    state.phase === 'lobby'
      ? 'Für Zweierteams wählt ihr beide dasselbe Team.'
      : 'Das Spiel läuft schon – du kannst trotzdem einsteigen.';
}

function renderQuestion() {
  const box = $('#p-question');
  const q = state.current;
  if (!q) { box.hidden = true; return; }
  box.hidden = false;
  $('#p-q-head').textContent = `${q.category} · ${q.value} Punkte`;
  $('#p-q-text').textContent = q.text;
  const img = $('#p-q-image');
  if (q.image) {
    if (img.getAttribute('src') !== q.image) img.src = q.image;
    img.hidden = false;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
  }
  const answer = $('#p-q-answer');
  answer.hidden = !q.revealed;
  answer.textContent = q.answer || '';
}

function renderPicker() {
  const box = $('#p-picker');
  const canPick = state.phase === 'board' && state.you.isMyTurn && state.board;
  box.hidden = !canPick;
  if (!canPick) return;

  const key = `${state.round}:${state.board.categories.map((c) => c.cells.map((x) => x.used ? 1 : 0).join('')).join('')}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = '';
  state.board.categories.forEach((cat, catIdx) => {
    box.append(
      el('div', { class: 'pick-cat' },
        el('h3', {}, cat.name),
        el('div', { class: 'pick-values' },
          cat.cells.map((cell, rowIdx) =>
            el('button', {
              type: 'button',
              disabled: cell.used,
              onclick: () => { sound('pick'); action('pick', { catIdx, rowIdx }); },
            }, String(cell.value)),
          ),
        ),
      ),
    );
  });
}

function renderBuzzer(prev) {
  const q = state.current;
  const you = state.you;
  const status = $('#p-status');
  const label = $('#buzzer-label');

  buzzer.classList.remove('armed', 'won');
  buzzer.disabled = true;
  label.textContent = 'BUZZ';

  if (state.phase === 'lobby') {
    status.textContent = 'Warten auf den Start …';
    status.classList.remove('you');
    label.textContent = 'BEREIT';
    return;
  }
  if (state.phase === 'roundEnd') { status.textContent = 'Runde vorbei – gleich geht’s weiter.'; return; }
  if (state.phase === 'gameOver') { status.textContent = 'Spiel beendet!'; return; }

  if (state.phase === 'board') {
    status.textContent = you.isMyTurn
      ? 'Du bist dran – wähle ein Feld!'
      : `Am Zug: ${state.teams[state.turnIndex]?.name ?? '?'} …`;
    status.classList.toggle('you', you.isMyTurn);
    return;
  }

  if (!q) return;

  if (q.step === 'primary') {
    const active = state.teams.find((t) => t.id === q.teamId);
    status.textContent = you.onTheHook
      ? 'Du bist dran – sag deine Antwort!'
      : `Am Zug: ${active?.name ?? '?'}. Buzzer noch gesperrt.`;
    status.classList.toggle('you', !!you.onTheHook);
    label.textContent = you.onTheHook ? 'DU BIST DRAN' : 'GESPERRT';
    return;
  }

  if (q.step === 'buzz' && !q.buzzedTeamId) {
    if (you.canBuzz) {
      buzzer.disabled = false;
      buzzer.classList.add('armed');
      status.textContent = `Buzzer frei! ${q.halfValue} Punkte – oder ${q.halfValue} Abzug.`;
      status.classList.add('you');
      if (prev?.current?.step !== 'buzz') { vibrate([30, 50, 30]); sound('reveal'); }
    } else {
      status.textContent = q.lockedOut.includes(you.teamId)
        ? 'Ihr hattet euren Versuch.'
        : 'Andere buzzern gerade.';
      status.classList.remove('you');
      label.textContent = 'GESPERRT';
    }
    return;
  }

  if (q.buzzedTeamId) {
    const team = state.teams.find((t) => t.id === q.buzzedTeamId);
    const mine = q.buzzedTeamId === you.teamId;
    buzzer.classList.add('won');
    label.textContent = mine ? 'DU!' : (team?.name || '').toUpperCase();
    status.textContent = mine ? 'Du warst zuerst – antworte!' : `${team?.name} war schneller.`;
    status.classList.toggle('you', mine);
    return;
  }

  status.textContent = q.revealed ? 'Aufgelöst.' : '…';
  status.classList.remove('you');
}

function renderScores() {
  const box = $('#p-scores');
  box.innerHTML = '';
  const activeId = state.teams[state.turnIndex]?.id;
  for (const team of state.teams) {
    const cls = [
      'chip',
      team.id === state.you.teamId ? 'me' : '',
      team.id === activeId ? 'turn' : '',
    ].join(' ');
    box.append(el('span', { class: cls }, `${team.name}: ${team.score}`));
  }
}
