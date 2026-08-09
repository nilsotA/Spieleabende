// Spiellogik für das Quizduell-Board.
// Reine Zustandsmaschine ohne Netzwerk-Abhängigkeiten – damit testbar.

export const TEAM_COLORS = [
  '#e63950', '#2f7dd1', '#37b16b', '#e5a020',
  '#9b59d0', '#22b3b3', '#e2703a', '#d94fa0',
];

/** Punktwerte je Zeile in Runde 1. Runde 2 verdoppelt (siehe roundMultiplier). */
export const BASE_VALUES = [100, 200, 300, 500];

export function roundMultiplier(round) {
  return round <= 1 ? 1 : 2;
}

/** Hälfte der Punkte – für Buzzer-Antworten. */
export function halfPoints(value) {
  return Math.round(value / 2);
}

function leereRekorde() {
  return {
    schnellsterBuzz: null, // { teamId, name, ms }
    teuersterReinfall: null, // { teamId, delta, kategorie, wert }
  };
}

export function createState() {
  return {
    phase: 'lobby', // lobby | board | question | roundEnd | gameOver
    round: 0,
    roundCount: 0,
    setName: null,
    teams: [],
    board: null,
    turnIndex: 0,
    current: null,
    settings: {
      // 'rotate'       = nach jeder Frage ist das nächste Team dran
      // 'keepOnCorrect'= wer richtig antwortet, bleibt dran
      turnMode: 'rotate',
      // Abzug für das Zugteam bei falscher Antwort: 'none' | 'half' | 'full'
      wrongPenalty: 'none',
      // Buzzern erlauben, nachdem das Zugteam richtig geantwortet hat?
      buzzAfterCorrect: false,
    },
    message: null,
    // Was man sich am nächsten Tag erzählt. Reine Buchhaltung fürs Ende – auf
    // Punkte und Ablauf hat davon nichts Einfluss.
    rekorde: leereRekorde(),
  };
}

/* ------------------------------------------------------------------ Teams */

export function addTeam(state, name) {
  if (state.phase !== 'lobby') throw new GameError('Teams können nur in der Lobby geändert werden.');
  if (state.teams.length >= 8) throw new GameError('Maximal 8 Teams.');
  // Auch der Standardname zählt nicht die Teams, sondern sucht die erste freie
  // Nummer – sonst gibt es nach einem Löschen zweimal „Team 3".
  let n = 1;
  while (state.teams.some((t) => t.name === `Team ${n}`)) n++;
  const clean = String(name || '').trim().slice(0, 24) || `Team ${n}`;
  const id = `t${n}_${Math.random().toString(36).slice(2, 7)}`;
  state.teams.push({
    id,
    name: clean,
    // Die erste noch freie Farbe, nicht die nach Anzahl: Wer ein Team löscht
    // und ein neues anlegt, bekam sonst zweimal dieselbe Farbe an der Leiste.
    color: TEAM_COLORS.find((f) => !state.teams.some((t) => t.color === f))
      || TEAM_COLORS[state.teams.length % TEAM_COLORS.length],
    score: 0,
    members: [],
  });
  return state;
}

export function renameTeam(state, teamId, name) {
  const team = findTeam(state, teamId);
  team.name = String(name || '').trim().slice(0, 24) || team.name;
  return state;
}

export function removeTeam(state, teamId) {
  if (state.phase !== 'lobby') throw new GameError('Teams können nur in der Lobby geändert werden.');
  state.teams = state.teams.filter((t) => t.id !== teamId);
  return state;
}

export function findTeam(state, teamId) {
  const team = state.teams.find((t) => t.id === teamId);
  if (!team) throw new GameError('Team nicht gefunden.');
  return team;
}

export function teamOfClient(state, clientId) {
  return state.teams.find((t) => t.members.some((m) => m.clientId === clientId)) || null;
}

/**
 * Spieler (Gerät) einem Team zuordnen. Ein Gerät gehört immer zu genau einem Team.
 * Während einer laufenden Frage gesperrt: sonst könnte ein Gerät, das schon falsch
 * gebuzzert hat, einfach das Team wechseln und es nochmal versuchen.
 */
export function joinTeam(state, clientId, teamId, name) {
  requireNotMidQuestion(state);
  const target = findTeam(state, teamId);
  const alreadyIn = target.members.some((m) => m.clientId === clientId);
  // Kapazität VOR dem Entfernen prüfen – sonst steht der Spieler bei einem Fehler
  // plötzlich in gar keinem Team mehr.
  if (!alreadyIn && countOnline(target) >= 4) {
    throw new GameError('Dieses Team ist voll (max. 4 Geräte).');
  }
  for (const team of state.teams) {
    team.members = team.members.filter((m) => m.clientId !== clientId);
  }
  target.members.push({
    clientId,
    name: String(name || 'Spieler').trim().slice(0, 24),
    online: true,
  });
  return state;
}

export function leaveTeams(state, clientId) {
  requireNotMidQuestion(state);
  for (const team of state.teams) {
    team.members = team.members.filter((m) => m.clientId !== clientId);
  }
  return state;
}

/** Host entfernt ein einzelnes Gerät – z.B. eine Karteileiche nach Handywechsel. */
export function removeMember(state, teamId, clientId) {
  const team = findTeam(state, teamId);
  team.members = team.members.filter((m) => m.clientId !== clientId);
  return state;
}

/**
 * Verbindungsstatus eines Geräts. Getrennte Geräte bleiben im Team stehen
 * (damit ein Reconnect nahtlos klappt), zählen aber nicht gegen das Limit.
 */
export function setMemberOnline(state, clientId, online) {
  for (const team of state.teams) {
    for (const member of team.members) {
      if (member.clientId === clientId) member.online = online;
    }
  }
  return state;
}

function countOnline(team) {
  return team.members.filter((m) => m.online !== false).length;
}

function requireNotMidQuestion(state) {
  if (state.phase === 'question') {
    throw new GameError('Teamwechsel geht erst wieder, wenn die Frage durch ist.');
  }
}

export function adjustScore(state, teamId, delta) {
  const team = findTeam(state, teamId);
  const d = Math.trunc(Number(delta) || 0);
  team.score += d;
  return state;
}

/* ------------------------------------------------------------------- Spiel */

export function startGame(state, questionSet) {
  if (state.teams.length < 2) throw new GameError('Mindestens 2 Teams / Spieler nötig.');
  if (!questionSet || !Array.isArray(questionSet.rounds) || questionSet.rounds.length === 0) {
    throw new GameError('Kein gültiger Fragensatz geladen.');
  }
  state.setName = questionSet.name || 'Fragensatz';
  state.roundCount = questionSet.rounds.length;
  state.questionSet = questionSet;
  state.round = 0;
  state.turnIndex = 0;
  for (const team of state.teams) {
    team.score = 0;
    team.serie = 0;
    team.serieBest = 0;
  }
  state.rekorde = leereRekorde();
  return startRound(state, 1);
}

export function startRound(state, round) {
  const set = state.questionSet;
  const data = set.rounds[round - 1];
  if (!data) throw new GameError(`Runde ${round} existiert nicht.`);
  const mult = roundMultiplier(round);
  state.round = round;
  state.board = {
    multiplier: mult,
    categories: data.categories.map((cat) => ({
      name: cat.name,
      cells: cat.questions.map((q, rowIdx) => ({
        value: (BASE_VALUES[rowIdx] ?? BASE_VALUES[BASE_VALUES.length - 1]) * mult,
        text: q.text || '',
        answer: q.answer || '',
        image: q.image || null,
        note: q.note || null,
        used: false,
      })),
    })),
  };
  state.current = null;
  state.phase = 'board';
  state.message = round > 1 ? `Runde ${round}: doppelte Punkte!` : null;
  return state;
}

export function pickCell(state, catIdx, rowIdx, byTeamId = null) {
  if (state.phase !== 'board') throw new GameError('Gerade ist keine Feldauswahl möglich.');
  const cat = state.board.categories[catIdx];
  const cell = cat && cat.cells[rowIdx];
  if (!cell) throw new GameError('Dieses Feld gibt es nicht.');
  if (cell.used) throw new GameError('Dieses Feld wurde schon gespielt.');

  const activeTeam = state.teams[state.turnIndex];
  if (byTeamId && byTeamId !== activeTeam.id) {
    throw new GameError('Nur das Team, das dran ist, darf ein Feld wählen.');
  }

  cell.used = true;
  state.current = {
    catIdx,
    rowIdx,
    category: cat.name,
    value: cell.value,
    text: cell.text,
    image: cell.image,
    answer: cell.answer,
    note: cell.note,
    step: 'primary', // primary | buzz | result
    teamId: activeTeam.id,
    onTheHook: activeTeam.id, // wer gerade antworten darf
    buzzedTeamId: null,
    lockedOut: [],
    revealed: false,
    buzzOpenedAt: null,
    log: [],
  };
  state.phase = 'question';
  state.message = null;
  return state;
}

/** Zugteam weiß es nicht → direkt für alle anderen freigeben (ohne Abzug). */
export function passQuestion(state) {
  const q = requireQuestion(state);
  if (q.step !== 'primary') throw new GameError('Das geht nur, solange das Zugteam dran ist.');
  q.log.push({ teamId: q.teamId, result: 'pass', delta: 0 });
  return openBuzz(state);
}

export function openBuzz(state) {
  const q = requireQuestion(state);
  if (q.step === 'result') throw new GameError('Die Frage ist bereits beendet.');
  const eligible = state.teams.filter(
    (t) => t.id !== q.teamId && !q.lockedOut.includes(t.id),
  );
  if (eligible.length === 0) {
    q.revealed = true;
    beende(q);
    return state;
  }
  q.step = 'buzz';
  q.buzzedTeamId = null;
  q.onTheHook = null;
  q.buzzOpenedAt = Date.now();
  return state;
}

/** Ein Gerät buzzert. Erster Buzz gewinnt – der Server entscheidet. */
export function buzz(state, clientId) {
  const q = requireQuestion(state);
  if (q.step !== 'buzz') throw new GameError('Buzzer ist noch gesperrt.');
  if (q.buzzedTeamId) throw new GameError('Zu spät – jemand war schneller.');
  const team = teamOfClient(state, clientId);
  if (!team) throw new GameError('Du gehörst zu keinem Team.');
  if (team.id === q.teamId) throw new GameError('Dein Team hatte die Frage bereits.');
  if (q.lockedOut.includes(team.id)) throw new GameError('Dein Team hat es schon versucht.');
  q.buzzedTeamId = team.id;
  q.onTheHook = team.id;
  q.buzzedAt = Date.now();
  q.buzzQuelle = 'handy';
  q.buzzedBy = team.members.find((m) => m.clientId === clientId)?.name || team.name;

  // Nur echte Handy-Buzz zählen für den Rekord: Drückt der Host stellvertretend,
  // misst die Zahl seine Reaktion, nicht die des Tisches.
  const ms = q.buzzedAt - q.buzzOpenedAt;
  if (q.buzzOpenedAt && (!state.rekorde.schnellsterBuzz || ms < state.rekorde.schnellsterBuzz.ms)) {
    state.rekorde.schnellsterBuzz = { teamId: team.id, name: q.buzzedBy, ms };
  }
  return state;
}

/** Host buzzert stellvertretend für ein Team – für Runden ganz ohne Handys. */
export function buzzFor(state, teamId) {
  const q = requireQuestion(state);
  if (q.step !== 'buzz') throw new GameError('Buzzer ist noch gesperrt.');
  // Wie buzz(): Ein bereits vergebener Buzz wird nicht überschrieben. Sonst
  // nimmt ein Griff des Hosts dem Handy, das schneller war, die Frage weg.
  if (q.buzzedTeamId) throw new GameError('Es hat schon jemand gebuzzert – erst werten oder den Buzz zurücknehmen.');
  const team = findTeam(state, teamId);
  if (team.id === q.teamId) throw new GameError('Dieses Team hatte die Frage bereits.');
  if (q.lockedOut.includes(team.id)) throw new GameError('Dieses Team hat es schon versucht.');
  q.buzzedTeamId = team.id;
  q.onTheHook = team.id;
  q.buzzedAt = Date.now();
  q.buzzQuelle = 'host';
  q.buzzedBy = team.name;
  return state;
}

/**
 * Frage in den Ergebniszustand versetzen. Der Buzz wird dabei gelöscht: Sonst
 * halten Fernbedienung und Handys die Frage für noch offen und zeigen weiter
 * „X hat gebuzzert" statt „Weiter".
 */
function beende(q) {
  q.step = 'result';
  q.onTheHook = null;
  q.buzzedTeamId = null;
  q.buzzedBy = null;
  return q;
}

/** Niemand weiß es mehr: auflösen und Frage abschließen. */
export function endQuestion(state) {
  const q = requireQuestion(state);
  // Ein Buzz, der im selben Moment eintrifft, darf nicht verschluckt werden –
  // der Host hört ihn ja und sähe sonst die Lösung ohne Wertung.
  if (q.buzzedTeamId) {
    throw new GameError('Es hat gerade jemand gebuzzert – erst werten oder den Buzz zurücknehmen.');
  }
  q.revealed = true;
  beende(q);
  return state;
}

/**
 * Antwort bewerten.
 *  - Zugteam richtig → volle Punkte.
 *  - Zugteam falsch  → optionaler Abzug, danach Buzzer frei.
 *  - Buzzer richtig  → halbe Punkte, Frage beendet.
 *  - Buzzer falsch   → halbe Punkte Abzug, nächstes Team darf buzzern.
 */
export function judge(state, correct) {
  const q = requireQuestion(state);
  if (q.step === 'result') throw new GameError('Die Frage ist bereits beendet.');
  if (!q.onTheHook) throw new GameError('Es ist niemand am Zug – erst muss jemand buzzern.');

  const team = findTeam(state, q.onTheHook);
  const isPrimary = q.step === 'primary';
  const full = q.value;
  const half = halfPoints(full);

  // Serie richtiger Antworten – reine Anzeige, sie bringt keine Punkte und
  // ändert an den Regeln nichts. Sie zählt für das Team, das gerade antwortet:
  // beim Zugteam wie beim Team, das sich reingebuzzert hat.
  team.serie = correct ? (team.serie || 0) + 1 : 0;
  if (team.serie > (team.serieBest || 0)) team.serieBest = team.serie;

  if (correct) {
    const delta = isPrimary ? full : half;
    team.score += delta;
    q.log.push({ teamId: team.id, result: 'correct', delta });
    q.lastDelta = { teamId: team.id, delta };
    // Achtung: erst aufdecken, wenn die Frage wirklich durch ist. Sonst könnten
    // die übrigen Teams die Lösung ablesen und trotzdem noch mitpunkten.
    if (isPrimary && state.settings.buzzAfterCorrect) {
      return openBuzz(state);
    }
    q.revealed = true;
    beende(q);
    return state;
  }

  // Falsch
  let delta = 0;
  if (isPrimary) {
    if (state.settings.wrongPenalty === 'full') delta = -full;
    else if (state.settings.wrongPenalty === 'half') delta = -half;
  } else {
    delta = -half;
  }
  team.score += delta;
  q.log.push({ teamId: team.id, result: 'wrong', delta });
  q.lastDelta = { teamId: team.id, delta };
  // Der teuerste Reinfall des Abends – da lacht am Ende der ganze Tisch.
  if (delta < 0 && delta < (state.rekorde.teuersterReinfall?.delta ?? 0)) {
    state.rekorde.teuersterReinfall = {
      teamId: team.id, delta, kategorie: q.category, wert: q.value,
    };
  }
  if (!isPrimary) q.lockedOut.push(team.id);
  return openBuzz(state);
}

/**
 * Reines Sicherheitsnetz: Aufdecken geht erst, wenn die Frage abgeschlossen ist.
 * Bei offenem Buzzer wäre die Lösung eine Vorlage für die halben Punkte –
 * dafür gibt es endQuestion, das die Frage gleichzeitig beendet.
 */
export function revealAnswer(state) {
  const q = requireQuestion(state);
  if (q.step !== 'result') {
    throw new GameError('Erst werten oder über „auflösen" beenden.');
  }
  q.revealed = true;
  return state;
}

/** Buzz zurücknehmen (Fehlbedienung), Buzzer bleibt für die Übrigen offen. */
export function resetBuzz(state) {
  const q = requireQuestion(state);
  if (q.step !== 'buzz') throw new GameError('Der Buzzer ist gerade nicht offen.');
  q.buzzedTeamId = null;
  q.buzzedBy = null;
  q.buzzQuelle = null;
  q.onTheHook = null;
  return openBuzz(state);
}

/** Frage schließen, Zug weitergeben, zurück aufs Board. */
export function closeQuestion(state) {
  const q = requireQuestion(state);
  // Ohne diesen Riegel würde ein zu früher Druck auf „Weiter" die Frage
  // ungewertet verbrennen – das Feld wäre weg und niemand hätte sie gesehen.
  if (q.step !== 'result') {
    throw new GameError('Die Frage läuft noch – erst werten oder auflösen.');
  }
  const solvedBy = q.log.find((e) => e.result === 'correct');

  if (state.settings.turnMode === 'keepOnCorrect' && solvedBy) {
    // Wer gelöst hat, ist als Nächstes dran – auch wenn er sich reingebuzzert hat.
    setTurn(state, solvedBy.teamId);
  } else {
    // Weitergezählt wird ab dem Team, das die Frage hatte – nicht ab dem
    // turnIndex. Der kann sich zwischendurch verschoben haben, wenn der Host
    // im Menü „dran" gesetzt hat; dann übersprang das Reihum ein Team.
    const hatte = state.teams.findIndex((t) => t.id === q.teamId);
    const von = hatte >= 0 ? hatte : state.turnIndex;
    state.turnIndex = (von + 1) % Math.max(state.teams.length, 1);
  }
  state.current = null;

  if (boardComplete(state)) {
    state.phase = state.round >= state.roundCount ? 'gameOver' : 'roundEnd';
    state.message =
      state.phase === 'gameOver'
        ? 'Spiel beendet!'
        : `Runde ${state.round} beendet.`;
  } else {
    state.phase = 'board';
  }
  return state;
}

export function boardComplete(state) {
  if (!state.board) return false;
  return state.board.categories.every((cat) => cat.cells.every((c) => c.used));
}

export function nextRound(state) {
  if (state.phase !== 'roundEnd') throw new GameError('Die Runde läuft noch.');
  return startRound(state, state.round + 1);
}

export function setTurn(state, teamId) {
  const idx = state.teams.findIndex((t) => t.id === teamId);
  if (idx < 0) throw new GameError('Team nicht gefunden.');
  state.turnIndex = idx;
  return state;
}

export function backToLobby(state) {
  const teams = state.teams.map((t) => ({
    ...t,
    score: 0,
    serie: 0,
    serieBest: 0,
    // Karteileichen von Geräten, die längst weg sind, nicht ins nächste Spiel schleppen.
    members: t.members.filter((m) => m.online !== false),
  }));
  const fresh = createState();
  fresh.teams = teams;
  fresh.settings = state.settings;
  return fresh;
}

export function ranking(state) {
  return [...state.teams].sort((a, b) => b.score - a.score);
}

/* ------------------------------------------------------------------- Hilfen */

function requireQuestion(state) {
  if (state.phase !== 'question' || !state.current) {
    throw new GameError('Gerade läuft keine Frage.');
  }
  return state.current;
}

export class GameError extends Error {}

/**
 * Sicht für ein bestimmtes Gerät. Spieler dürfen die Antwort erst sehen,
 * wenn sie aufgedeckt ist – und nie den Rest des Boards ausspähen.
 */
export function viewFor(state, { isHost, clientId }) {
  const view = {
    phase: state.phase,
    round: state.round,
    roundCount: state.roundCount,
    setName: state.setName,
    turnIndex: state.turnIndex,
    message: state.message,
    settings: state.settings,
    teams: state.teams.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      score: t.score,
      serie: t.serie || 0,
      serieBest: t.serieBest || 0,
      members: t.members.map((m) => ({
        name: m.name,
        clientId: m.clientId,
        online: m.online !== false,
      })),
    })),
    board: state.board && {
      multiplier: state.board.multiplier,
      categories: state.board.categories.map((cat) => ({
        name: cat.name,
        cells: cat.cells.map((c) => ({ value: c.value, used: c.used })),
      })),
    },
    current: null,
    you: null,
    // Nur am Ende interessant, aber billig genug, um immer mitzufahren.
    rekorde: state.rekorde || null,
  };

  if (state.current) {
    const q = state.current;
    view.current = {
      catIdx: q.catIdx,
      rowIdx: q.rowIdx,
      category: q.category,
      value: q.value,
      text: q.text,
      image: q.image,
      step: q.step,
      teamId: q.teamId,
      onTheHook: q.onTheHook,
      buzzedTeamId: q.buzzedTeamId,
      buzzedBy: q.buzzedBy || null,
      // Wie knapp war das Rennen? Der Server weiß es längst, hat es aber für
      // sich behalten – dabei ist genau das der Moment, über den danach geredet
      // wird. Nur bei einem echten Handy-Buzz: Wenn der Host stellvertretend
      // drückt, misst die Zahl seine Reaktion, nicht die des Tisches.
      buzzMs: q.buzzedAt && q.buzzOpenedAt && q.buzzQuelle === 'handy'
        ? q.buzzedAt - q.buzzOpenedAt
        : null,
      lockedOut: q.lockedOut,
      revealed: q.revealed,
      lastDelta: q.lastDelta || null,
      log: q.log,
      halfValue: halfPoints(q.value),
      answer: isHost || q.revealed ? q.answer : null,
      note: isHost || q.revealed ? q.note : null,
    };
  }

  if (clientId) {
    const team = teamOfClient(state, clientId);
    const q = state.current;
    view.you = {
      clientId,
      teamId: team ? team.id : null,
      teamName: team ? team.name : null,
      isMyTurn: !!team && state.teams[state.turnIndex]?.id === team.id,
      canBuzz:
        !!team &&
        state.phase === 'question' &&
        !!q &&
        q.step === 'buzz' &&
        !q.buzzedTeamId &&
        q.teamId !== team.id &&
        !q.lockedOut.includes(team.id),
      onTheHook: !!team && !!q && q.onTheHook === team.id,
    };
  }

  return view;
}
