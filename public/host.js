import { $, el, connect, action, toast, sound, installAudioUnlock } from '/common.js';

let state = null;
let localSet = null;      // per Datei geladener Fragensatz (noch nicht gespeichert)
let lastScores = new Map();
let peek = false;         // Lösung auf dem großen Screen kurz sichtbar?

const act = (type, payload) => action(type, payload, 'host');

installAudioUnlock();

/* --------------------------------------------------------------- Verbindung */

connect({
  role: 'host',
  onState: (next) => {
    const prev = state;
    state = next;
    render(prev);
  },
  onEvent: (name) => {
    if (name === 'buzz') sound('buzz');
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
    const parsed = JSON.parse(await file.text());
    localSet = parsed;
    const select = $('#set-select');
    // Vorhandenen Datei-Eintrag ersetzen statt einen zweiten anzulegen.
    select.querySelector('option[value="__local"]')?.remove();
    select.prepend(el('option', { value: '__local' }, `${parsed.name || file.name} (aus Datei)`));
    select.value = '__local';
    describeSet(localSet);
    toast('Fragensatz geladen.');
  } catch (err) {
    toast('Datei konnte nicht gelesen werden: ' + err.message, 'error');
  } finally {
    ev.target.value = ''; // dieselbe Datei soll erneut wählbar bleiben
  }
});

$('#set-select').addEventListener('change', async (ev) => {
  if (ev.target.value === '__local') return describeSet(localSet);
  localSet = null;
  try {
    const set = await (await fetch(`/api/set?file=${encodeURIComponent(ev.target.value)}`)).json();
    if (set.error) throw new Error(set.error);
    describeSet(set);
  } catch (err) {
    $('#set-info').textContent = err.message || '';
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
    const keepLocal = select.querySelector('option[value="__local"]');
    select.innerHTML = '';
    if (keepLocal) select.append(keepLocal);
    if (!sets.length && !keepLocal) {
      select.append(el('option', { value: '' }, 'Keine Fragensätze gefunden'));
      return;
    }
    for (const set of sets) {
      select.append(
        el('option', { value: set.file, disabled: !!set.error },
          set.error ? `${set.file} – ${set.error}` : `${set.name} (${set.questions} Fragen)`),
      );
    }
    select.dispatchEvent(new Event('change'));
  } catch {
    toast('Fragensätze konnten nicht geladen werden.', 'error');
  }
}

function describeSet(set) {
  if (!set) return;
  $('#set-info').innerHTML = '';
  (set.rounds || []).forEach((r, i) => {
    $('#set-info').append(
      el('div', {}, `Runde ${i + 1}: ${r.categories.map((c) => c.name).join(' · ')}`),
    );
  });
}

async function loadUrls() {
  try {
    const info = await (await fetch('/api/info')).json();
    $('#join-urls').innerHTML = '';
    for (const url of info.urls) $('#join-urls').append(el('code', {}, url));
    $('#remote-url').textContent = `${info.urls[0]}/remote`;
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

  if (inLobby) {
    // Sonst schweben beim nächsten Spielstart Phantom-Abzüge über den Teams.
    lastScores.clear();
    return renderLobby();
  }

  renderBoard();
  renderQuestion(prev);
  renderPlayers();
  renderScoreboard();
  renderControls();
  if (!$('#menu').hidden) fillMenu();
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
              ? team.members.map((m) => (m.online ? m.name : `${m.name} (offline)`)).join(', ')
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

function renderBoard() {
  const board = $('#board');
  const data = state.board;
  if (!data) return;
  const cols = data.categories.length;
  const rows = Math.max(...data.categories.map((c) => c.cells.length), 1);

  // Schlüssel aus dem Inhalt, nicht nur aus der Rundennummer: ein zweites Spiel
  // mit anderem Fragensatz hätte sonst weiter die alten Kategorien im Kopf.
  const key = [state.setName, state.round, data.categories.map((c) => `${c.name}/${c.cells.length}`).join('|')].join('#');
  if (board.dataset.key !== key) {
    board.dataset.key = key;
    board.innerHTML = '';
    board.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    board.style.gridTemplateRows = `auto repeat(${rows}, minmax(0, 1fr))`;
    data.categories.forEach((cat, catIdx) => {
      board.append(el('div', { class: 'cat', style: { gridColumn: catIdx + 1, gridRow: 1 } },
        el('span', {}, cat.name)));
      cat.cells.forEach((cell, rowIdx) => {
        board.append(
          el('button', {
            class: 'tile',
            'data-cell': `${catIdx}-${rowIdx}`,
            style: { gridColumn: catIdx + 1, gridRow: rowIdx + 2, '--i': catIdx + rowIdx },
            onclick: () => {
              sound('pick');
              act('pick', { catIdx, rowIdx });
            },
          }, el('span', {}, String(cell.value))),
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
        setTimeout(() => tile.classList.remove('picked'), 500);
      }
    });
  });

  $('#round-label').textContent = `Runde ${state.round} / ${state.roundCount}`;
  $('#round-mult').textContent = data.multiplier > 1 ? `${data.multiplier}× Punkte` : '';

  const active = state.teams[state.turnIndex];
  $('#turn-name').textContent = active ? active.name : '—';
  $('#turn-pill').hidden = !(state.phase === 'board' || state.phase === 'question');
  if (active) $('#turn-pill').style.setProperty('--team', active.color);
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

  const status = $('#q-status');
  status.innerHTML = '';
  const teamName = (id) => state.teams.find((t) => t.id === id)?.name || '?';

  if (q.step === 'primary') {
    status.append(el('div', { class: 'chip turn' }, `Am Zug: ${teamName(q.teamId)}`));
    setBuzzIndicator('idle');
  } else if (q.step === 'buzz' && !q.buzzedTeamId) {
    status.append(el('div', { class: 'chip buzzopen' }, `⚡ Buzzer frei · ${q.halfValue} Punkte`));
    setBuzzIndicator('armed');
  } else if (q.buzzedTeamId) {
    status.append(el('div', { class: 'chip buzzed' }, `${teamName(q.buzzedTeamId)} hat gebuzzert!`));
    setBuzzIndicator(q.step === 'buzz' ? 'hit' : 'idle');
  } else {
    setBuzzIndicator('idle');
  }

  for (const entry of q.log) {
    const label =
      entry.result === 'pass' ? 'wusste es nicht'
        : entry.result === 'correct' ? `richtig +${entry.delta}`
          : entry.delta ? `falsch ${entry.delta}` : 'falsch';
    status.append(el('div', { class: `chip log ${entry.result}` }, `${teamName(entry.teamId)}: ${label}`));
  }

  const answer = $('#q-answer');
  answer.hidden = !q.revealed;
  answer.textContent = q.revealed ? q.answer : '';
  const note = $('#q-note');
  note.hidden = !(q.revealed && q.note);
  note.textContent = q.note || '';

  // Tonsignale nur bei echten Übergängen derselben Frage.
  const prevQ = prev?.current;
  const sameQuestion = prevQ && prevQ.catIdx === q.catIdx && prevQ.rowIdx === q.rowIdx;
  if (sameQuestion && prevQ.log.length < q.log.length) {
    sound(q.log[q.log.length - 1].result === 'correct' ? 'correct' : 'wrong');
  }
  if (sameQuestion && !prevQ.revealed && q.revealed && !q.log.some((e) => e.result === 'correct')) {
    sound('reveal');
  }
}

function setBuzzIndicator(mode) {
  const node = $('#buzz-indicator');
  node.classList.toggle('armed', mode === 'armed');
  node.classList.toggle('hit', mode === 'hit');
}

function renderPlayers() {
  const box = $('#players');
  const key = state.teams.map((t) => t.id).join('|');
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = '';
    for (const team of state.teams) {
      box.append(
        el('div', { class: 'player', 'data-team': team.id, style: { '--team': team.color } },
          el('div', { class: 'pname' }, team.name),
          el('div', { class: 'pmembers' }, ''),
          el('div', { class: 'pscore' }, '0'),
        ),
      );
    }
    for (const id of [...lastScores.keys()]) {
      if (!state.teams.some((t) => t.id === id)) lastScores.delete(id);
    }
  }

  const activeId = state.teams[state.turnIndex]?.id;
  for (const team of state.teams) {
    const node = box.querySelector(`[data-team="${team.id}"]`);
    if (!node) continue;
    node.querySelector('.pmembers').textContent = team.members
      .map((m) => (m.online ? m.name : `${m.name} ⚪`))
      .join(', ');
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
      node.classList.add(delta > 0 ? 'gain' : 'loss');
      setTimeout(() => {
        badge.remove();
        node.classList.remove('gain', 'loss');
      }, 1700);
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
  const ranked = [...state.teams].sort((a, b) => b.score - a.score);
  const key = ranked.map((t) => `${t.id}:${t.score}`).join('|') + `#${state.phase}`;
  if (list.dataset.key !== key) {
    list.dataset.key = key;
    list.innerHTML = '';
    ranked.forEach((team, i) => {
      list.append(
        el('li', { class: i === 0 ? 'first' : '', style: { '--i': i, '--team': team.color } },
          el('span', { class: 'rank' }, `${i + 1}`),
          el('span', { class: 'sname' }, team.name),
          el('span', { class: 'pts' }, String(team.score)),
        ),
      );
    });
  }
  $('#btn-next-round').hidden = final;
  $('#btn-new-game').hidden = !final;
}

/* --------------------------------------------------------------- Steuerung */

$('#btn-peek').addEventListener('click', () => {
  peek = !peek;
  renderControls();
});

function renderControls() {
  const hint = $('#control-hint');
  const bar = $('#control-buttons');
  bar.innerHTML = '';
  const q = state.current;
  const teamName = (id) => state.teams.find((t) => t.id === id)?.name || '?';

  // Die Lösung gehört nicht ungefragt auf die Leinwand.
  const wrap = $('#solution-wrap');
  const solution = $('#solution');
  const showSolution = !!q && !!q.answer && !q.revealed;
  wrap.hidden = !showSolution;
  if (showSolution) {
    solution.textContent = `Lösung: ${q.answer}`;
    solution.classList.toggle('blurred', !peek);
  }

  if (state.phase === 'board') {
    hint.textContent = `Am Zug: ${teamName(state.teams[state.turnIndex]?.id)} – Feld anklicken oder auf dem Handy antippen.`;
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

  if (q.step === 'primary') {
    hint.textContent = `${teamName(q.teamId)} antwortet.`;
    bar.append(
      button('Richtig ✓', 'btn-good', () => act('judge', { correct: true }), '1'),
      button('Falsch ✗', 'btn-bad', () => act('judge', { correct: false }), '2'),
      button('Weiß nicht → Buzzer frei', 'btn-ghost', () => act('pass'), '3'),
    );
  } else if (q.step === 'buzz' && !q.buzzedTeamId) {
    hint.textContent = 'Buzzer ist frei.';
    for (const team of state.teams) {
      if (team.id === q.teamId || q.lockedOut.includes(team.id)) continue;
      bar.append(button(`Buzz: ${team.name}`, 'btn-ghost btn-sm', () => act('buzzFor', { teamId: team.id })));
    }
    bar.append(button('Keiner weiß es → auflösen', 'btn-primary', () => act('endQuestion'), '4'));
  } else if (q.buzzedTeamId && q.step === 'buzz') {
    hint.textContent = `${teamName(q.buzzedTeamId)} hat gebuzzert (±${q.halfValue}).`;
    bar.append(
      button('Richtig ✓', 'btn-good', () => act('judge', { correct: true }), '1'),
      button('Falsch ✗', 'btn-bad', () => act('judge', { correct: false }), '2'),
      button('Buzz zurücknehmen', 'btn-ghost btn-sm', () => act('resetBuzz')),
    );
  } else {
    hint.textContent = 'Frage beendet.';
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
$('#btn-close-menu').addEventListener('click', closeMenu);
$('#menu').addEventListener('click', (ev) => {
  if (ev.target.id === 'menu') closeMenu();
});
$('#btn-abort').addEventListener('click', () => {
  if (confirm('Spiel wirklich beenden und zurück in die Lobby?')) {
    act('backToLobby');
    closeMenu();
  }
});

function openMenu() {
  fillMenu();
  $('#menu').hidden = false;
  // Alles dahinter stilllegen, sonst wandert der Tabulator aufs Board.
  $('#view-game').inert = true;
  $('#btn-close-menu').focus();
}

function closeMenu() {
  $('#menu').hidden = true;
  $('#view-game').inert = false;
}

function fillMenu() {
  const list = $('#menu-teams');
  list.innerHTML = '';
  for (const team of state.teams) {
    const offline = team.members.filter((m) => !m.online);
    list.append(
      el('li', {},
        el('span', { class: 'dot', style: { background: team.color } }),
        el('span', { class: 'tname' },
          team.name,
          offline.length
            ? el('span', { class: 'muted small' }, ` · ${offline.length} offline`)
            : null),
        el('span', { class: 'sc' }, String(team.score)),
        button('−100', 'btn-sm btn-ghost', () => act('adjustScore', { teamId: team.id, delta: -100 })),
        button('+100', 'btn-sm btn-ghost', () => act('adjustScore', { teamId: team.id, delta: 100 })),
        button('dran', 'btn-sm btn-ghost', () => act('setTurn', { teamId: team.id })),
        offline.length
          ? button('Offline entfernen', 'btn-sm btn-ghost', () => {
            for (const m of offline) act('removeMember', { teamId: team.id, clientId: m.clientId });
          })
          : null,
      ),
    );
  }
}

/* ------------------------------------------------------------ Tastatur */

document.addEventListener('keydown', (ev) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if (!state || state.phase === 'lobby') return;

  const menuOpen = !$('#menu').hidden;
  const key = ev.key.toLowerCase();

  if (key === 'escape') {
    ev.preventDefault();
    return menuOpen ? closeMenu() : openMenu();
  }
  // Solange das Menü offen ist, gehören die Tasten dem Menü.
  if (menuOpen) return;

  const q = state.current;
  if (!q) {
    if (key === ' ' && state.phase === 'roundEnd') { ev.preventDefault(); act('nextRound'); }
    return;
  }

  const judging = q.step === 'primary' || (q.step === 'buzz' && q.buzzedTeamId);
  if (key === '1' && judging) { ev.preventDefault(); act('judge', { correct: true }); }
  else if (key === '2' && judging) { ev.preventDefault(); act('judge', { correct: false }); }
  else if (key === '3' && q.step === 'primary') { ev.preventDefault(); act('pass'); }
  else if (key === '4' && q.step === 'buzz' && !q.buzzedTeamId) { ev.preventDefault(); act('endQuestion'); }
  else if (key === ' ' && q.step === 'result') { ev.preventDefault(); act('close'); }
  else if (key === 'l') { ev.preventDefault(); peek = !peek; renderControls(); }
});
