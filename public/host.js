import { $, $$, el, connect, action, toast, sound } from '/common.js';

let state = null;
let localSet = null;      // per Datei geladener Fragensatz (noch nicht gespeichert)
let lastPhaseKey = '';
let lastScores = new Map();

const act = (type, payload) => action(type, payload, 'host');

/* --------------------------------------------------------------- Verbindung */

connect({
  role: 'host',
  onState: (next) => {
    const prev = state;
    state = next;
    render(prev);
  },
  onEvent: (name, data) => {
    if (name === 'buzz') {
      sound('buzz');
      flashBuzz(data);
    }
  },
});

/* -------------------------------------------------------------------- Lobby */

$('#team-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = $('#team-name');
  act('addTeam', { name: input.value });
  input.value = '';
  input.focus();
});

$('#btn-reload-sets').addEventListener('click', loadSets);
$('#btn-start').addEventListener('click', () => {
  const payload = localSet ? { set: localSet } : { file: $('#set-select').value };
  act('startGame', payload);
});

$('#set-file').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  try {
    localSet = JSON.parse(await file.text());
    $('#set-select').insertAdjacentHTML(
      'afterbegin',
      `<option value="__local" selected>${escapeHtml(localSet.name || file.name)} (aus Datei)</option>`,
    );
    $('#set-select').value = '__local';
    describeSet(localSet);
    toast('Fragensatz geladen.');
  } catch (err) {
    toast('Datei konnte nicht gelesen werden: ' + err.message, 'error');
  }
});

$('#set-select').addEventListener('change', async (ev) => {
  if (ev.target.value === '__local') return describeSet(localSet);
  localSet = null;
  try {
    const set = await (await fetch(`/api/set?file=${encodeURIComponent(ev.target.value)}`)).json();
    describeSet(set);
  } catch {
    $('#set-info').textContent = '';
  }
});

for (const [id, key, parse] of [
  ['#set-turnmode', 'turnMode', (v) => v],
  ['#set-penalty', 'wrongPenalty', (v) => v],
  ['#set-buzzcorrect', 'buzzAfterCorrect', (v) => v === 'true'],
]) {
  $(id).addEventListener('change', (ev) => act('settings', { settings: { [key]: parse(ev.target.value) } }));
}

async function loadSets() {
  try {
    const sets = await (await fetch('/api/sets')).json();
    const select = $('#set-select');
    select.innerHTML = '';
    if (!sets.length) {
      select.append(el('option', { value: '' }, 'Keine Fragensätze gefunden'));
      return;
    }
    for (const set of sets) {
      select.append(
        el('option', { value: set.file, disabled: !!set.error },
          set.error ? `${set.file} – Fehler: ${set.error}` : `${set.name} (${set.questions} Fragen)`),
      );
    }
    select.dispatchEvent(new Event('change'));
  } catch (err) {
    toast('Fragensätze konnten nicht geladen werden.', 'error');
  }
}

function describeSet(set) {
  if (!set) return;
  const rounds = (set.rounds || []).map(
    (r, i) => `Runde ${i + 1}: ${r.categories.map((c) => c.name).join(' · ')}`,
  );
  $('#set-info').innerHTML = rounds.map(escapeHtml).join('<br>');
}

async function loadUrls() {
  try {
    const info = await (await fetch('/api/info')).json();
    $('#join-urls').innerHTML = '';
    for (const url of info.urls) $('#join-urls').append(el('code', {}, url));
  } catch {
    /* egal */
  }
}

loadSets();
loadUrls();

/* ------------------------------------------------------------------ Render */

function render(prev) {
  if (!state) return;
  const inLobby = state.phase === 'lobby';
  $('#view-lobby').classList.toggle('active', inLobby);
  $('#view-game').classList.toggle('active', !inLobby);

  if (inLobby) return renderLobby();

  renderBoard(prev);
  renderQuestion(prev);
  renderPlayers(prev);
  renderScoreboard();
  renderControls();
}

function renderLobby() {
  const list = $('#lobby-teams');
  list.innerHTML = '';
  if (!state.teams.length) {
    list.append(el('li', { class: 'muted' }, 'Noch keine Teams. Lege oben mindestens zwei an.'));
  }
  for (const team of state.teams) {
    list.append(
      el('li', {},
        el('span', { class: 'dot', style: { background: team.color } }),
        el('span', { class: 'grow' },
          el('div', { class: 'tname' }, team.name),
          el('div', { class: 'tmembers' },
            team.members.length
              ? team.members.map((m) => m.name).join(', ')
              : 'kein Handy verbunden'),
        ),
        el('button', { class: 'btn btn-sm btn-ghost', onclick: () => act('removeTeam', { teamId: team.id }) }, '✕'),
      ),
    );
  }
  $('#set-turnmode').value = state.settings.turnMode;
  $('#set-penalty').value = state.settings.wrongPenalty;
  $('#set-buzzcorrect').value = String(state.settings.buzzAfterCorrect);
  $('#btn-start').disabled = state.teams.length < 2;
}

function renderBoard(prev) {
  const board = $('#board');
  const data = state.board;
  if (!data) return;
  const cols = data.categories.length;
  const rows = data.categories[0]?.cells.length || 4;

  const key = `${state.round}:${cols}:${rows}`;
  if (board.dataset.key !== key) {
    board.dataset.key = key;
    board.innerHTML = '';
    board.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    board.style.gridTemplateRows = `auto repeat(${rows}, minmax(0, 1fr))`;
    data.categories.forEach((cat, catIdx) => {
      board.append(el('div', { class: 'cat', style: { gridColumn: catIdx + 1, gridRow: 1 } }, cat.name));
      cat.cells.forEach((cell, rowIdx) => {
        board.append(
          el('button', {
            class: 'tile',
            'data-cell': `${catIdx}-${rowIdx}`,
            style: { gridColumn: catIdx + 1, gridRow: rowIdx + 2 },
            onclick: () => {
              sound('pick');
              act('pick', { catIdx, rowIdx });
            },
          }, String(cell.value)),
        );
      });
    });
  }

  data.categories.forEach((cat, catIdx) => {
    cat.cells.forEach((cell, rowIdx) => {
      const tile = board.querySelector(`[data-cell="${catIdx}-${rowIdx}"]`);
      if (!tile) return;
      const wasUsed = tile.classList.contains('used');
      tile.classList.toggle('used', cell.used);
      tile.disabled = cell.used || state.phase !== 'board';
      if (cell.used && !wasUsed) {
        tile.classList.add('picked');
        setTimeout(() => tile.classList.remove('picked'), 400);
      }
    });
  });

  $('#round-label').textContent = `Runde ${state.round} / ${state.roundCount}`;
  $('#round-mult').textContent = data.multiplier > 1 ? `${data.multiplier}× Punkte` : '';

  const active = state.teams[state.turnIndex];
  $('#turn-name').textContent = active ? `Am Zug: ${active.name}` : '—';
  $('#turn-pill').style.display = state.phase === 'board' || state.phase === 'question' ? '' : 'none';
}

function renderQuestion(prev) {
  const box = $('#question');
  const q = state.current;
  if (!q) {
    box.hidden = true;
    setBuzzIndicator('idle');
    return;
  }
  box.hidden = false;

  $('#q-head').textContent = `${q.category} ${q.value}`;
  $('#q-text').textContent = q.text;

  const img = $('#q-image');
  if (q.image) {
    if (img.getAttribute('src') !== q.image) img.src = q.image;
    img.hidden = false;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
  }

  // Statuszeile
  const status = $('#q-status');
  status.innerHTML = '';
  const team = (id) => state.teams.find((t) => t.id === id);
  if (q.step === 'primary') {
    const t = team(q.teamId);
    status.append(el('div', { class: 'chip turn' }, `Am Zug: ${t ? t.name : '?'}`));
  } else if (q.step === 'buzz' && !q.buzzedTeamId) {
    status.append(el('div', { class: 'chip buzzopen' }, '⚡ Buzzer frei – wer weiß es?'));
    setBuzzIndicator('armed');
  } else if (q.buzzedTeamId && q.step === 'buzz') {
    const t = team(q.buzzedTeamId);
    status.append(el('div', { class: 'chip buzzed' }, `${t ? t.name : '?'} hat gebuzzert!`));
    setBuzzIndicator('hit');
  }
  if (q.step !== 'buzz') setBuzzIndicator(q.step === 'primary' ? 'idle' : 'idle');

  for (const entry of q.log) {
    const t = team(entry.teamId);
    if (!t) continue;
    const label =
      entry.result === 'pass' ? 'wusste es nicht'
        : entry.result === 'correct' ? `richtig +${entry.delta}`
          : entry.delta ? `falsch ${entry.delta}` : 'falsch';
    status.append(el('div', { class: 'chip' }, `${t.name}: ${label}`));
  }

  const answer = $('#q-answer');
  answer.hidden = !q.revealed;
  answer.textContent = q.revealed ? q.answer : '';
  const note = $('#q-note');
  note.hidden = !(q.revealed && q.note);
  note.textContent = q.note || '';

  // Tonsignale bei Zustandswechseln
  const prevQ = prev?.current;
  if (prevQ && prevQ.log.length < q.log.length) {
    sound(q.log[q.log.length - 1].result === 'correct' ? 'correct' : 'wrong');
  }
  if (prevQ && !prevQ.revealed && q.revealed && !q.log.some((e) => e.result === 'correct')) {
    sound('reveal');
  }
}

function setBuzzIndicator(mode) {
  const node = $('#buzz-indicator');
  node.classList.toggle('armed', mode === 'armed');
  node.classList.toggle('hit', mode === 'hit');
}

function flashBuzz() {
  const node = $('#buzz-indicator');
  node.classList.add('hit');
}

function renderPlayers(prev) {
  const box = $('#players');
  const key = state.teams.map((t) => t.id).join('|');
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = '';
    for (const team of state.teams) {
      box.append(
        el('div', { class: 'player', 'data-team': team.id, style: { borderColor: team.color } },
          el('div', { class: 'pname' }, team.name),
          el('div', { class: 'pmembers' }, ''),
          el('div', { class: 'pscore' }, '0'),
        ),
      );
    }
  }

  const activeId = state.teams[state.turnIndex]?.id;
  for (const team of state.teams) {
    const node = box.querySelector(`[data-team="${team.id}"]`);
    if (!node) continue;
    node.querySelector('.pmembers').textContent = team.members.map((m) => m.name).join(', ');
    const scoreNode = node.querySelector('.pscore');
    scoreNode.textContent = team.score;
    scoreNode.classList.toggle('neg', team.score < 0);
    node.classList.toggle('active', team.id === activeId);
    node.classList.toggle('buzzed', state.current?.buzzedTeamId === team.id && state.current?.step === 'buzz');

    const before = lastScores.get(team.id);
    if (before != null && before !== team.score) {
      const delta = team.score - before;
      const badge = el('div', { class: `delta ${delta > 0 ? 'plus' : 'minus'}` }, `${delta > 0 ? '+' : ''}${delta}`);
      node.append(badge);
      setTimeout(() => badge.remove(), 1700);
    }
    lastScores.set(team.id, team.score);
  }
}

function renderScoreboard() {
  const box = $('#scoreboard');
  const show = state.phase === 'roundEnd' || state.phase === 'gameOver';
  box.hidden = !show;
  if (!show) return;

  const final = state.phase === 'gameOver';
  $('#score-title').textContent = final ? 'Endstand' : `Runde ${state.round} beendet`;
  const list = $('#score-list');
  list.innerHTML = '';
  const ranked = [...state.teams].sort((a, b) => b.score - a.score);
  ranked.forEach((team, i) => {
    list.append(
      el('li', { class: i === 0 ? 'first' : '' },
        el('span', { class: 'rank' }, `${i + 1}.`),
        el('span', {}, team.name),
        el('span', { class: 'pts' }, String(team.score)),
      ),
    );
  });
  $('#btn-next-round').hidden = final;
  $('#btn-new-game').hidden = !final;
}

/* --------------------------------------------------------------- Steuerung */

function renderControls() {
  const hint = $('#control-hint');
  const bar = $('#control-buttons');
  bar.innerHTML = '';
  const q = state.current;

  if (state.phase === 'board') {
    const active = state.teams[state.turnIndex];
    hint.textContent = `Am Zug: ${active ? active.name : '?'} – Feld anklicken oder auf dem Handy antippen.`;
    bar.append(button('Zug überspringen', 'btn-ghost btn-sm', () => {
      const next = state.teams[(state.turnIndex + 1) % state.teams.length];
      act('setTurn', { teamId: next.id });
    }));
    return;
  }

  if (state.phase === 'roundEnd' || state.phase === 'gameOver') {
    hint.textContent = state.phase === 'gameOver' ? 'Spiel beendet.' : 'Bereit für die nächste Runde?';
    return;
  }

  if (!q) { hint.textContent = ''; return; }

  const teamName = (id) => state.teams.find((t) => t.id === id)?.name || '?';

  if (q.step === 'primary') {
    hint.innerHTML = `Am Zug: <b>${escapeHtml(teamName(q.teamId))}</b> · Lösung: <b>${escapeHtml(q.answer || '')}</b>`;
    bar.append(
      button('Richtig ✓', 'btn-good', () => act('judge', { correct: true }), '1'),
      button('Falsch ✗', 'btn-bad', () => act('judge', { correct: false }), '2'),
      button('Weiß nicht → Buzzer frei', 'btn-ghost', () => act('pass'), '3'),
    );
  } else if (q.step === 'buzz' && !q.buzzedTeamId) {
    hint.innerHTML = `Buzzer ist frei · Lösung: <b>${escapeHtml(q.answer || '')}</b>`;
    for (const team of state.teams) {
      if (team.id === q.teamId || q.lockedOut.includes(team.id)) continue;
      bar.append(button(`Buzz: ${team.name}`, 'btn-ghost btn-sm', () => act('buzzFor', { teamId: team.id })));
    }
    bar.append(
      button('Keiner weiß es → auflösen', 'btn-primary', () => act('endQuestion'), '4'),
    );
  } else if (q.step === 'buzz' && q.buzzedTeamId) {
    hint.innerHTML = `<b>${escapeHtml(teamName(q.buzzedTeamId))}</b> hat gebuzzert (±${q.halfValue}) · Lösung: <b>${escapeHtml(q.answer || '')}</b>`;
    bar.append(
      button('Richtig ✓', 'btn-good', () => act('judge', { correct: true }), '1'),
      button('Falsch ✗', 'btn-bad', () => act('judge', { correct: false }), '2'),
      button('Buzz zurücknehmen', 'btn-ghost btn-sm', () => act('resetBuzz')),
    );
  } else {
    hint.innerHTML = `Lösung: <b>${escapeHtml(q.answer || '')}</b>`;
    if (!q.revealed) bar.append(button('Auflösen', 'btn-primary', () => act('reveal'), '4'));
    bar.append(button('Weiter', 'btn-primary', () => act('close'), 'Leertaste'));
  }
}

function button(label, cls, onclick, key) {
  const node = el('button', { class: `btn ${cls}`, onclick }, label);
  if (key) node.append(el('kbd', {}, key));
  return node;
}

$('#btn-next-round').addEventListener('click', () => act('nextRound'));
$('#btn-new-game').addEventListener('click', () => act('backToLobby'));
$('#btn-menu').addEventListener('click', openMenu);
$('#btn-close-menu').addEventListener('click', () => ($('#menu').hidden = true));
$('#btn-abort').addEventListener('click', () => {
  if (confirm('Spiel wirklich beenden und zurück in die Lobby?')) {
    act('backToLobby');
    $('#menu').hidden = true;
  }
});

function openMenu() {
  const list = $('#menu-teams');
  list.innerHTML = '';
  for (const team of state.teams) {
    list.append(
      el('li', {},
        el('span', { class: 'dot', style: { background: team.color, width: '12px', height: '12px', borderRadius: '50%' } }),
        el('span', { class: 'tname' }, team.name),
        el('span', { class: 'sc' }, String(team.score)),
        button('−100', 'btn-sm btn-ghost', () => { act('adjustScore', { teamId: team.id, delta: -100 }); setTimeout(openMenu, 120); }),
        button('+100', 'btn-sm btn-ghost', () => { act('adjustScore', { teamId: team.id, delta: 100 }); setTimeout(openMenu, 120); }),
        button('dran', 'btn-sm btn-ghost', () => { act('setTurn', { teamId: team.id }); setTimeout(openMenu, 120); }),
      ),
    );
  }
  $('#menu').hidden = false;
}

/* ------------------------------------------------------------ Tastatur */

document.addEventListener('keydown', (ev) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if (!state || state.phase === 'lobby') return;
  const q = state.current;
  const key = ev.key.toLowerCase();

  if (key === 'escape') { $('#menu').hidden = !$('#menu').hidden; return; }
  if (!q) {
    if (key === ' ' && state.phase === 'roundEnd') { ev.preventDefault(); act('nextRound'); }
    return;
  }
  if (key === '1') { ev.preventDefault(); act('judge', { correct: true }); }
  else if (key === '2') { ev.preventDefault(); act('judge', { correct: false }); }
  else if (key === '3' && q.step === 'primary') { ev.preventDefault(); act('pass'); }
  else if (key === '4') {
    ev.preventDefault();
    act(q.step === 'buzz' && !q.buzzedTeamId ? 'endQuestion' : 'reveal');
  }
  else if (key === ' ') { ev.preventDefault(); act('close'); }
});

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
