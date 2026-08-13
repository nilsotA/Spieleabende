// Spiellogik für das Quizduell-Board.
// Reine Zustandsmaschine ohne Netzwerk-Abhängigkeiten – damit testbar.

export const TEAM_COLORS = [
  '#e63950', '#2f7dd1', '#37b16b', '#e5a020',
  '#9b59d0', '#22b3b3', '#e2703a', '#d94fa0',
];

/**
 * Wappen der Teams. Auf der Leinwand unterscheidet die Farbe die Teams – aber
 * am Tisch sagt niemand „die Blauen", sondern „wir sind der Fuchs". Das Wappen
 * steht überall neben dem Namen und ist auch von hinten im Raum noch zu
 * erkennen, wo drei Blautöne längst gleich aussehen.
 *
 * Mehr Wappen als Teams (12 zu 8): So bleibt beim Aussuchen immer eine echte
 * Auswahl übrig, statt dass die letzten Teams nehmen müssen, was übrig ist.
 */
export const TEAM_WAPPEN = ['🦊', '🐻', '🐼', '🦁', '🐸', '🦉', '🐙', '🦄', '🐝', '🐳', '🦖', '🐧'];

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

/**
 * Die Bilanz eines Teams – reine Buchhaltung für den Rückblick am Ende.
 * Auf Punkte und Ablauf hat davon nichts Einfluss.
 */
function leereBilanz() {
  return {
    richtig: 0,
    falsch: 0,
    gepasst: 0, // „weiß nicht" abgegeben
    geklaut: 0, // per Buzzer beim fremden Feld gepunktet
    daneben: 0, // per Buzzer danebengelegen
    geholt: 0, // Summe der gewonnenen Punkte
    verloren: 0, // Summe der verlorenen Punkte, positiv gezählt
    geklautPunkte: 0, // davon am fremden Feld per Buzzer geholt
  };
}

/**
 * Bilanz eines Teams, notfalls frisch angelegt.
 *
 * Ein Spielstand, der vor dieser Buchhaltung gespeichert wurde, bringt sie
 * nicht mit – und der Server stellt beim Start den letzten Stand wieder her.
 * Ohne diese Stelle stürbe der Abend beim ersten Punkt an einem `undefined`.
 */
function bilanzVon(team) {
  if (!team.bilanz) {
    team.bilanz = leereBilanz();
    return team.bilanz;
  }
  // Auch eine vorhandene Bilanz kann Felder nicht kennen, die erst später
  // dazugekommen sind – ein `+=` darauf ergäbe NaN und der Punktestand wäre
  // für den Rest des Abends kaputt.
  for (const [feld, leer] of Object.entries(leereBilanz())) {
    if (team.bilanz[feld] === undefined) team.bilanz[feld] = leer;
  }
  return team.bilanz;
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
      // Abzug für das Zugteam, wenn es falsch liegt oder passt:
      // 'none' | 'half' | 'full'. Voreingestellt die Hälfte – ohne Abzug ist
      // ein Feld aufrufen risikofrei, und dann wird der Reihe nach das teuerste
      // genommen und ins Blaue geraten.
      wrongPenalty: 'half',
      // Buzzern erlauben, nachdem das Zugteam richtig geantwortet hat?
      buzzAfterCorrect: false,
      // Wer ruft das Feld auf?
      // 'team' = das Team, das dran ist, tippt es auf seinem Handy an
      // 'host' = nur der Host, über Leinwand oder Fernbedienung
      feldwahl: 'team',
      // Sekunden für den freigegebenen Buzzer, 0 = aus. Voreingestellt aus:
      // Die Regeln des Spiels kennen keine Uhr, und wer sie nicht will, soll
      // sie nicht wegklicken müssen. Sie wertet auch nichts von selbst – sie
      // zeigt nur, dass die Zeit läuft, und dem Host, dass er auflösen kann.
      buzzUhr: 0,
    },
    message: null,
    // Pause: Zwei Stunden Spiel heißen mindestens einmal Küche. Solange sie
    // läuft, kann kein Handy ein Feld aufrufen und niemand buzzern – sonst
    // steht der Abend nach der Pause an einer Frage, die keiner gestellt hat.
    pause: false,
    // Seit wann die Pause läuft – nur, um die Buzzer-Uhr um dieselbe Zeit nach
    // hinten zu schieben. Auf dem Bildschirm taucht das nie auf.
    pauseSeit: null,
    // Was man sich am nächsten Tag erzählt. Reine Buchhaltung fürs Ende – auf
    // Punkte und Ablauf hat davon nichts Einfluss.
    rekorde: leereRekorde(),
    // Stechen (siehe startStechen): wie viele Entscheidungsfragen schon liefen,
    // welche Texte dabei verbraucht sind und wer es am Ende geholt hat.
    stechenLauf: 0,
    stechenTexte: [],
    stechenSieger: null,
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
    // Gleiche Regel wie bei der Farbe: das erste noch freie Wappen.
    wappen: TEAM_WAPPEN.find((w) => !state.teams.some((t) => t.wappen === w))
      || TEAM_WAPPEN[state.teams.length % TEAM_WAPPEN.length],
    score: 0,
    // Von Anfang an vollständig. Serie und Bestserie entstanden früher erst bei
    // der ersten Wertung; bis dahin stand dort `undefined`. Gelesen wurde das
    // überall mit `|| 0` abgefangen, aber ein Zustand, der je nach Alter des
    // Teams anders aussieht, ist eine Falle für den nächsten Handgriff.
    serie: 0,
    serieBest: 0,
    members: [],
    bilanz: leereBilanz(),
  });
  return state;
}

export function renameTeam(state, teamId, name) {
  const team = findTeam(state, teamId);
  team.name = String(name || '').trim().slice(0, 24) || team.name;
  return state;
}

/**
 * Wappen wechseln. Nur in der Lobby – wenn das Spiel läuft, ist das Wappen
 * das, woran man ein Team auf der Leinwand wiedererkennt; mitten in einer
 * Runde umzustecken würde genau diese Wiedererkennung zerstören.
 *
 * Zwei Teams mit demselben Wappen wären ein Rückschritt gegenüber der Farbe,
 * deshalb bleibt ein vergebenes Wappen vergeben. Das Handy zeigt belegte
 * Wappen gar nicht erst als wählbar an – die Prüfung hier fängt nur den Fall
 * ab, dass zwei Geräte im selben Moment dasselbe antippen.
 */
export function setTeamWappen(state, teamId, wappen) {
  if (state.phase !== 'lobby') throw new GameError('Das Wappen lässt sich nur in der Lobby ändern.');
  const team = findTeam(state, teamId);
  if (!TEAM_WAPPEN.includes(wappen)) throw new GameError('Dieses Wappen gibt es nicht.');
  if (team.wappen === wappen) return state;
  if (state.teams.some((t) => t.wappen === wappen)) {
    throw new GameError('Das Wappen hat sich gerade ein anderes Team geschnappt.');
  }
  team.wappen = wappen;
  return state;
}

export function removeTeam(state, teamId) {
  if (state.phase !== 'lobby') throw new GameError('Teams können nur in der Lobby geändert werden.');
  state.teams = state.teams.filter((t) => t.id !== teamId);
  // Der Zeiger aufs Zugteam muss mitschrumpfen. Über die Fernbedienung lässt
  // sich „dran" auch in der Lobby setzen; stand er danach auf dem entfernten
  // Team, zeigte er hinter das Ende der Liste. `state.teams[turnIndex]` war
  // dann `undefined`, und der nächste Feldaufruf wäre kein abgelehnter Zug
  // gewesen, sondern ein Absturz.
  if (state.turnIndex >= state.teams.length) state.turnIndex = 0;
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
  requireNotMidQuestion(state, clientId);
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
      if (member.clientId === clientId) {
        member.online = online;
        // Merken, wann jemand weggefallen ist. Ein gesperrtes iPhone und ein
        // Gast, der vor zwei Stunden nach Hause ist, sehen im Zustand sonst
        // exakt gleich aus – und beim Neustart fliegen beide gleich raus.
        if (!online) member.wegSeit = Date.now();
        else delete member.wegSeit;
      }
    }
  }
  return state;
}

/**
 * Wie lange ein abgemeldetes Gerät seinen Platz im Team behält.
 *
 * Zwischen zwei Fragensätzen wird geredet, nachgeschenkt und geraucht; die
 * Handys sperren derweil und lassen die Verbindung fallen. Wer danach
 * weiterspielen will, soll sein Team noch vorfinden und nicht neu beitreten
 * müssen. Zwei Stunden decken jede Pause eines Abends ab und sind kurz genug,
 * dass ein Gast von letzter Woche nicht mitgeschleppt wird.
 */
const WEG_FRIST = 2 * 60 * 60 * 1000;

function countOnline(team) {
  return team.members.filter((m) => m.online !== false).length;
}

/**
 * Während einer laufenden Frage bleibt die Teamzuordnung fest – sonst könnte ein
 * Gerät, das schon falsch gebuzzert hat, das Team wechseln und es nochmal
 * versuchen. Der Text unterscheidet, wen es trifft: Wer noch in keinem Team
 * steht, will einsteigen und nicht wechseln, und „Teamwechsel geht nicht" wäre
 * für ihn eine Antwort auf eine Frage, die er nie gestellt hat.
 */
function requireNotMidQuestion(state, clientId = null) {
  if (state.phase !== 'question') return;
  const drin = clientId ? !!teamOfClient(state, clientId) : true;
  throw new GameError(drin
    ? 'Teamwechsel geht erst wieder, wenn die Frage durch ist.'
    : 'Gleich – sobald die laufende Frage durch ist, kannst du einsteigen.');
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
    team.bilanz = leereBilanz();
  }
  state.rekorde = leereRekorde();
  // Ein neues Spiel fängt nicht in der Pause an – auch wenn das alte darin
  // stecken geblieben ist.
  state.pause = false;
  state.pauseSeit = null;
  state.stechenLauf = 0;
  state.stechenTexte = [];
  state.stechenSieger = null;
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
  if (state.pause) throw new GameError('Ihr seid gerade in der Pause.');
  if (state.phase !== 'board') throw new GameError('Gerade ist keine Feldauswahl möglich.');
  const cat = state.board.categories[catIdx];
  const cell = cat && cat.cells[rowIdx];
  if (!cell) throw new GameError('Dieses Feld gibt es nicht.');
  if (cell.used) throw new GameError('Dieses Feld wurde schon gespielt.');

  const activeTeam = state.teams[state.turnIndex];
  // `byTeamId` ist gesetzt, wenn der Aufruf von einem Spielerhandy kommt; der
  // Host ruft ohne auf. Steht die Feldwahl auf „nur Host", ist das der Punkt,
  // an dem ein Handy abprallt – und zwar mit einer Erklärung, nicht stumm.
  if (byTeamId && state.settings.feldwahl === 'host') {
    throw new GameError('Der Host ruft die Fragen auf – sagt ihm einfach, welches Feld ihr wollt.');
  }
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

/**
 * Zugteam weiß es nicht → für alle anderen freigeben.
 *
 * Das zählt wie eine falsche Antwort: gleicher Abzug, gleiche Serie gerissen,
 * gleicher Eintrag in der Bilanz. Sonst wäre „weiß nicht" der sichere Ausweg,
 * sobald ein Abzug eingestellt ist – geraten hätte dann nur noch, wer nichts zu
 * verlieren hat, und die Einstellung wäre wirkungslos.
 *
 * Im Protokoll bleibt der Unterschied trotzdem stehen: Auf der Leinwand ist
 * „wusste es nicht" eine andere Geschichte als „falsch geraten", auch wenn
 * beide gleich viel kosten. Und die ehrlichste Haut des Abends will man am Ende
 * ja auszeichnen können.
 */
export function passQuestion(state) {
  const q = requireQuestion(state);
  if (q.step !== 'primary') throw new GameError('Das geht nur, solange das Zugteam dran ist.');
  const team = findTeam(state, q.teamId);
  bilanzVon(team).gepasst += 1;
  verrechneFalsch(state, q, team, true, 'pass');
  return openBuzz(state);
}

/**
 * Die Folgen einer nicht getroffenen Antwort – für „falsch" und „weiß nicht"
 * derselbe Weg, damit die beiden nicht auseinanderlaufen können.
 *
 * `art` landet nur im Protokoll; an den Punkten ändert sie nichts.
 */
function verrechneFalsch(state, q, team, isPrimary, art) {
  const full = q.value;
  const half = halfPoints(full);
  team.serie = 0;

  const bilanz = bilanzVon(team);
  let delta = 0;
  if (isPrimary) {
    if (state.settings.wrongPenalty === 'full') delta = -full;
    else if (state.settings.wrongPenalty === 'half') delta = -half;
  } else {
    delta = -half;
  }
  team.score += delta;
  bilanz.falsch += 1;
  bilanz.verloren += -delta; // positiv gezählt, damit die Zahl für sich steht
  if (!isPrimary) bilanz.daneben += 1;
  q.log.push({ teamId: team.id, result: art, delta });
  q.lastDelta = { teamId: team.id, delta };
  // Der teuerste Reinfall des Abends – da lacht am Ende der ganze Tisch.
  if (delta < 0 && delta < (state.rekorde.teuersterReinfall?.delta ?? 0)) {
    state.rekorde.teuersterReinfall = {
      teamId: team.id, delta, kategorie: q.category, wert: q.value,
    };
  }
  if (!isPrimary) q.lockedOut.push(team.id);
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
  if (state.pause) throw new GameError('Ihr seid gerade in der Pause.');
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
  // Nur eine positive Zeit ist eine gemessene Zeit. Steht der Beginn des
  // Buzzers aus irgendeinem Grund in der Zukunft – ein Serverneustart mitten in
  // der Pause reicht dafür –, wäre das Ergebnis ein Rekord, den niemand mehr
  // unterbieten kann, und er stünde bis zum Abendende im Rückblick.
  if (q.buzzOpenedAt && ms > 0 && (!state.rekorde.schnellsterBuzz || ms < state.rekorde.schnellsterBuzz.ms)) {
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

  // Das Stechen läuft neben der Buchhaltung her: keine Punkte, keine Serie,
  // keine Bilanz. Es geht nur noch um die Frage, wer den Abend gewinnt – die
  // Zahlen auf der Tafel sind ja schon gespielt und sollen so stehen bleiben.
  if (q.stechen) {
    q.log.push({ teamId: team.id, result: correct ? 'correct' : 'wrong', delta: 0 });
    q.lastDelta = { teamId: team.id, delta: 0 };
    if (correct) {
      state.stechenSieger = team.id;
      q.revealed = true;
      beende(q);
      return state;
    }
    // Falsch heißt hier raus – und die Übrigen dürfen wieder drücken. Ist
    // keiner mehr da, löst openBuzz die Frage auf und der Host stellt die
    // nächste.
    q.lockedOut.push(team.id);
    return openBuzz(state);
  }

  const isPrimary = q.step === 'primary';
  const full = q.value;

  // Serie richtiger Antworten – reine Anzeige, sie bringt keine Punkte und
  // ändert an den Regeln nichts. Sie zählt für das Team, das gerade antwortet:
  // beim Zugteam wie beim Team, das sich reingebuzzert hat.
  team.serie = correct ? (team.serie || 0) + 1 : 0;
  if (team.serie > (team.serieBest || 0)) team.serieBest = team.serie;

  const bilanz = bilanzVon(team);

  if (correct) {
    const delta = isPrimary ? full : halfPoints(full);
    team.score += delta;
    bilanz.richtig += 1;
    bilanz.geholt += delta;
    // Am fremden Feld gepunktet – die Zahl, mit der am Ende geprahlt wird.
    if (!isPrimary) {
      bilanz.geklaut += 1;
      bilanz.geklautPunkte += delta;
    }
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

  // Falsch – denselben Weg wie „weiß nicht", damit beide nicht auseinanderlaufen.
  verrechneFalsch(state, q, team, isPrimary, 'wrong');
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

  // Eine Stechfrage gehört zu keinem Brett: Danach geht es zurück in den
  // Endstand – entweder mit Sieger oder für die nächste Entscheidungsfrage.
  if (q.stechen) {
    state.current = null;
    state.phase = 'gameOver';
    state.message = state.stechenSieger
      ? `${findTeam(state, state.stechenSieger).name} entscheidet das Stechen!`
      : 'Das wusste keiner – noch eine Frage?';
    return state;
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

/**
 * Pause an oder aus.
 *
 * Ein Spieleabend dauert zwei Stunden, und mindestens einmal steht der halbe
 * Tisch in der Küche. Bisher blieb das Brett dabei offen stehen: Wer im
 * Vorbeigehen aufs Handy tippte, rief ein Feld auf, das niemand hörte – und
 * nach der Pause stand eine Frage da, die keiner gestellt hatte.
 *
 * Die Pause ändert nichts am Spielstand, sie legt ihn nur still. Der Host darf
 * währenddessen weiter alles – Punkte korrigieren, zurücknehmen, das Menü
 * benutzen; genau dafür ist so eine Pause oft da. Gesperrt sind die beiden
 * Wege, die von den Handys kommen: ein Feld aufrufen und buzzern.
 *
 * Auch mitten in einer Frage möglich: Der Durst kommt nicht nur zwischen zwei
 * Feldern. Die Frage bleibt stehen und läuft danach weiter.
 */
export function setPause(state, an) {
  if (state.phase === 'lobby') throw new GameError('In der Lobby gibt es nichts zu pausieren.');
  const vorher = !!state.pause;
  state.pause = !!an;
  state.message = state.pause ? 'Pause' : null;

  // Die Uhr am freigegebenen Buzzer hält mit an.
  //
  // Sie hängt daran, seit wann der Buzzer offen steht – und das lief in der
  // Pause munter weiter. Nachgestellt: drei Sekunden Pause, und die Uhr stand
  // 3,4 Sekunden weiter; nach einer echten Küchenpause hätte sie beim
  // Weiterspielen sofort „Zeit ist um" gezeigt, obwohl niemand nachgedacht
  // hatte. Der Beginn wandert deshalb um die Dauer der Pause nach vorn.
  if (state.pause && !vorher) {
    state.pauseSeit = Date.now();
  } else if (!state.pause && vorher && state.pauseSeit) {
    // Nur der Teil der Pause zählt, der nach dem Öffnen des Buzzers lag.
    //
    // Der Host darf in der Pause weiter werten – „Weiß nicht → Buzzer frei"
    // geht also mitten in der Pause. Wurde dann die volle Pausendauer
    // aufgeschlagen, lag der Beginn hinterher in der Zukunft: Die Uhr auf der
    // Leinwand stand still, und der erste Buzz maß eine negative Zeit. Ein
    // negativer Wert ist als „schnellster Buzz des Abends" von keinem ehrlichen
    // Druck mehr zu unterbieten – gemessen −291 ms nach 600 ms Pause, bei einer
    // echten Küchenpause entsprechend zehn Minuten.
    const jetzt = Date.now();
    const q = state.current;
    if (q?.buzzOpenedAt) q.buzzOpenedAt += jetzt - Math.max(state.pauseSeit, q.buzzOpenedAt);
    state.pauseSeit = null;
  }
  return state;
}

/* ----------------------------------------------------------------- Stechen */

/** Alle Teams, die den Höchststand teilen. */
export function spitzenTeams(state) {
  if (!state.teams.length) return [];
  const best = Math.max(...state.teams.map((t) => t.score));
  return state.teams.filter((t) => t.score === best);
}

/**
 * Stechen: eine Entscheidungsfrage, wenn oben zwei gleichauf stehen.
 *
 * Ein Abend, der mit „Unentschieden" endet, endet nicht wirklich – es fehlt
 * der Moment, in dem einer gewinnt. Die Regeln des Spiels bleiben davon
 * unberührt: Das Stechen ändert keine Punkte und läuft erst, wenn das Brett
 * leer ist und der Host es startet.
 *
 * Es läuft wie ein freigegebener Buzzer, nur ohne Zugteam: Wer zuerst drückt,
 * antwortet. Richtig gewinnt den Abend, falsch scheidet aus dem Stechen aus –
 * dann sind die übrigen dran. Weiß es keiner, gibt es die nächste Frage.
 */
export function startStechen(state, frage) {
  if (state.phase !== 'gameOver') {
    throw new GameError('Ein Stechen gibt es erst, wenn das Spiel durch ist.');
  }
  if (state.stechenSieger) throw new GameError('Das Stechen ist schon entschieden.');
  const spitze = spitzenTeams(state);
  if (spitze.length < 2) throw new GameError('Es steht schon ein Sieger fest.');
  if (!frage || !frage.text) throw new GameError('Es ist keine Frage mehr übrig.');

  state.stechenLauf = (state.stechenLauf || 0) + 1;
  state.stechenTexte = [...(state.stechenTexte || []), frage.text];
  state.current = {
    stechen: true,
    catIdx: null,
    rowIdx: null,
    category: frage.category || 'Stechen',
    // Ohne Punktwert: Das Stechen entscheidet, wer gewinnt, nicht wie hoch.
    value: 0,
    text: frage.text,
    image: null,
    answer: frage.answer || '',
    note: frage.note || null,
    step: 'buzz',
    // Kein Zugteam – deshalb darf hier jeder buzzern, der noch im Rennen ist.
    teamId: null,
    onTheHook: null,
    buzzedTeamId: null,
    lockedOut: state.teams.filter((t) => !spitze.includes(t)).map((t) => t.id),
    revealed: false,
    buzzOpenedAt: Date.now(),
    log: [],
  };
  state.phase = 'question';
  state.message = state.stechenLauf > 1 ? 'Noch eine Entscheidungsfrage!' : 'Stechen!';
  return state;
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
    bilanz: leereBilanz(),
    // Karteileichen von Geräten, die längst weg sind, nicht ins nächste Spiel
    // schleppen – aber nur die wirklich alten. Wer bloß gerade ein gesperrtes
    // Handy in der Tasche hat, bleibt in seinem Team und ist nach dem
    // Aufwecken sofort wieder dabei.
    members: t.members.filter((m) => m.online !== false
      || (m.wegSeit && Date.now() - m.wegSeit < WEG_FRIST)),
  }));
  const fresh = createState();
  fresh.teams = teams;
  fresh.settings = state.settings;
  return fresh;
}

export function ranking(state) {
  const sieger = state.stechenSieger;
  return [...state.teams].sort((a, b) => b.score - a.score
    // Wer das Stechen geholt hat, steht vor den Punktgleichen – sonst
    // entschiede die Reihenfolge im Team-Array, wer oben auf der Tafel steht.
    || (a.id === sieger ? -1 : 0) || (b.id === sieger ? 1 : 0));
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
/**
 * Kennung der Lage, auf die sich eine Wertung bezieht.
 *
 * Der Host drückt „Richtig", und in der Millisekunde davor hat jemand
 * gebuzzert: Dann trifft der Druck nicht mehr die Situation, die auf dem Screen
 * stand, sondern die nächste – und schreibt dem Buzzer die Punkte gut, die dem
 * Zugteam gedacht waren. Die Entprellung im Browser deckt den Zitterfinger ab,
 * aber nicht zwei Host-Geräte und nicht ein Nachtippen bei träger Verbindung.
 *
 * Deshalb fährt diese Kennung in jeder Ansicht mit, und Wertungen schicken sie
 * zurück. Stimmt sie nicht mehr, war der Druck für eine andere Lage gedacht.
 *
 * Sie steht bewusst nur auf der laufenden Frage: Ein beitretendes Handy oder
 * eine Punktekorrektur ändern sie nicht, sonst würde jede zweite Wertung
 * grundlos abprallen.
 */
export function lageSignatur(state) {
  const q = state.current;
  if (!q) return `${state.phase}#${state.round}`;
  // Beim Stechen gibt es kein Feld – dort trennt der Zähler die Fragen, sonst
  // sähe die zweite Entscheidungsfrage aus wie die erste.
  const feld = q.stechen ? `s${state.stechenLauf}` : `f${q.catIdx}.${q.rowIdx}`;
  return `${feld}#${q.step}#${q.buzzedTeamId || ''}`;
}

export function viewFor(state, { isHost, clientId }) {
  const view = {
    phase: state.phase,
    round: state.round,
    roundCount: state.roundCount,
    setName: state.setName,
    turnIndex: state.turnIndex,
    message: state.message,
    pause: !!state.pause,
    settings: state.settings,
    // Die Auswahl kommt vom Server mit, damit die Liste nur an einer Stelle
    // steht. Sonst hätte das Handy eine eigene Kopie, die beim nächsten
    // zusätzlichen Wappen still auseinanderläuft.
    wappenAuswahl: TEAM_WAPPEN,
    teams: state.teams.map((t, i) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      // Spielstände aus der Zeit vor den Wappen haben keins gespeichert. Statt
      // im Handy überall auf `undefined` zu prüfen, bekommen sie hier eins.
      wappen: t.wappen || TEAM_WAPPEN[i % TEAM_WAPPEN.length],
      score: t.score,
      serie: t.serie || 0,
      serieBest: t.serieBest || 0,
      // Alte Spielstände kennen die Bilanz nicht oder nur teilweise – fehlende
      // Felder werden aufgefüllt, statt dass das Handy auf `undefined` läuft.
      bilanz: { ...leereBilanz(), ...(t.bilanz || {}) },
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
    // Womit sich eine Wertung zurückmelden muss – siehe lageSignatur().
    lage: lageSignatur(state),
    // Nur am Ende interessant, aber billig genug, um immer mitzufahren.
    rekorde: state.rekorde || null,
    stechenLauf: state.stechenLauf || 0,
    stechenSieger: state.stechenSieger || null,
  };

  if (state.current) {
    const q = state.current;
    view.current = {
      stechen: !!q.stechen,
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
      // Wie lange der Buzzer schon offen steht – vom Server gerechnet, nicht
      // vom Gerät. Die Uhr eines Handys geht gern zwei Minuten falsch, und ein
      // Balken, der auf einem Gerät schon leer ist und auf dem anderen noch
      // voll, wäre schlimmer als keiner.
      // Nie negativ: Wird der Server während einer Pause neu gestartet, ist
      // `pauseSeit` aus dem geholten Spielstand alt, und die Verschiebung beim
      // Weiterspielen kann den Beginn in die Zukunft legen. Ein Balken mit
      // scaleX über 1 stünde dann über die Bühne hinaus.
      buzzOffenMs: q.buzzOpenedAt ? Math.max(0, Date.now() - q.buzzOpenedAt) : null,
      // Wie knapp war das Rennen? Der Server weiß es längst, hat es aber für
      // sich behalten – dabei ist genau das der Moment, über den danach geredet
      // wird. Nur bei einem echten Handy-Buzz: Wenn der Host stellvertretend
      // drückt, misst die Zahl seine Reaktion, nicht die des Tisches.
      // Aus demselben Grund wie oben nie negativ: Neben dem Teamnamen stand
      // sonst „· −4,35 s".
      buzzMs: q.buzzedAt && q.buzzOpenedAt && q.buzzQuelle === 'handy'
        ? Math.max(0, q.buzzedAt - q.buzzOpenedAt)
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
