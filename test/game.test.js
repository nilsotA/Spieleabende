import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../server/game.js';

const SET = {
  name: 'Test',
  rounds: [
    { categories: [cat('A'), cat('B')] },
    { categories: [cat('C'), cat('D')] },
  ],
};

function cat(name) {
  return {
    name,
    questions: Array.from({ length: 4 }, (_, i) => ({
      text: `${name}-Frage ${i}`,
      answer: `${name}-Antwort ${i}`,
    })),
  };
}

function setup(teams = ['Team 1', 'Team 2', 'Team 3']) {
  const state = G.createState();
  for (const name of teams) G.addTeam(state, name);
  G.startGame(state, SET);
  return state;
}

const score = (state, i) => state.teams[i].score;

test('Runde 1 nutzt die Basiswerte, Runde 2 verdoppelt', () => {
  const state = setup();
  assert.deepEqual(
    state.board.categories[0].cells.map((c) => c.value),
    [100, 200, 300, 500],
  );
  G.startRound(state, 2);
  assert.deepEqual(
    state.board.categories[0].cells.map((c) => c.value),
    [200, 400, 600, 1000],
  );
});

test('richtige Antwort des Zugteams gibt die vollen Punkte', () => {
  const state = setup();
  G.pickCell(state, 0, 2); // 300
  G.judge(state, true);
  assert.equal(score(state, 0), 300);
  assert.equal(state.current.step, 'result');
  assert.equal(state.current.revealed, true);
});

test('nur das Team am Zug darf ein Feld wählen', () => {
  const state = setup();
  assert.throws(() => G.pickCell(state, 0, 0, state.teams[1].id), G.GameError);
  G.pickCell(state, 0, 0, state.teams[0].id);
  assert.equal(state.phase, 'question');
});

test('Buzzer bleibt gesperrt, solange das Zugteam noch nicht geantwortet hat', () => {
  const state = setup();
  G.joinTeam(state, 'geraet-2', state.teams[1].id, 'Bea');
  G.pickCell(state, 0, 0);
  assert.throws(() => G.buzz(state, 'geraet-2'), G.GameError);
});

test('nach falscher Antwort ist der Buzzer frei, richtig gibt die Hälfte', () => {
  const state = setup();
  G.joinTeam(state, 'geraet-2', state.teams[1].id, 'Bea');
  G.pickCell(state, 0, 3); // 500
  G.judge(state, false);
  assert.equal(score(state, 0), -250, 'Standard: die Hälfte Abzug für das Zugteam');
  assert.equal(state.current.step, 'buzz');

  G.buzz(state, 'geraet-2');
  assert.equal(state.current.buzzedTeamId, state.teams[1].id);
  G.judge(state, true);
  assert.equal(score(state, 1), 250);
  assert.equal(state.current.step, 'result');
});

test('falsch gebuzzert kostet die Hälfte und sperrt das Team', () => {
  const state = setup();
  G.joinTeam(state, 'g2', state.teams[1].id, 'Bea');
  G.joinTeam(state, 'g3', state.teams[2].id, 'Cem');
  G.pickCell(state, 0, 3); // 500
  G.passQuestion(state);

  G.buzz(state, 'g2');
  G.judge(state, false);
  assert.equal(score(state, 1), -250);
  assert.deepEqual(state.current.lockedOut, [state.teams[1].id]);
  assert.throws(() => G.buzz(state, 'g2'), G.GameError, 'gesperrtes Team darf nicht nochmal');

  G.buzz(state, 'g3');
  G.judge(state, true);
  assert.equal(score(state, 2), 250);
});

test('das Zugteam darf bei der eigenen Frage nicht mitbuzzern', () => {
  const state = setup();
  G.joinTeam(state, 'g1', state.teams[0].id, 'Ada');
  G.pickCell(state, 0, 0);
  G.judge(state, false);
  assert.throws(() => G.buzz(state, 'g1'), G.GameError);
});

test('nur der erste Buzz zählt', () => {
  const state = setup();
  G.joinTeam(state, 'g2', state.teams[1].id, 'Bea');
  G.joinTeam(state, 'g3', state.teams[2].id, 'Cem');
  G.pickCell(state, 0, 0);
  G.passQuestion(state);
  G.buzz(state, 'g2');
  assert.throws(() => G.buzz(state, 'g3'), G.GameError);
});

test('wenn niemand mehr buzzern darf, endet die Frage automatisch', () => {
  const state = setup(['Team 1', 'Team 2']);
  G.joinTeam(state, 'g2', state.teams[1].id, 'Bea');
  G.pickCell(state, 0, 0);
  G.judge(state, false);
  G.buzz(state, 'g2');
  G.judge(state, false);
  assert.equal(state.current.step, 'result');
  assert.equal(state.current.revealed, true);
});

test('Zug wandert reihum weiter', () => {
  const state = setup();
  G.pickCell(state, 0, 0);
  G.judge(state, true);
  G.closeQuestion(state);
  assert.equal(state.turnIndex, 1);
});

test('Einstellung „wer richtig liegt, bleibt dran“', () => {
  const state = setup();
  state.settings.turnMode = 'keepOnCorrect';
  G.pickCell(state, 0, 0);
  G.judge(state, true);
  G.closeQuestion(state);
  assert.equal(state.turnIndex, 0);

  G.pickCell(state, 0, 1);
  G.judge(state, false);
  G.endQuestion(state);
  G.closeQuestion(state);
  assert.equal(state.turnIndex, 1);
});

test('voreingestellt kostet ein Fehlgriff des Zugteams die Hälfte', () => {
  // Ohne Abzug ist ein Feldaufruf risikofrei: Man nimmt das teuerste und rät.
  // Die Voreinstellung ist deshalb die halbe Strafe – wer ändern will, kann.
  const state = setup();
  assert.equal(state.settings.wrongPenalty, 'half');

  G.pickCell(state, 0, 3); // 500
  G.judge(state, false);
  assert.equal(score(state, 0), -250);

  const zweiter = setup();
  G.pickCell(zweiter, 0, 3);
  G.passQuestion(zweiter);
  assert.equal(score(zweiter, 0), -250, '„weiß nicht" kostet genauso viel');
});

test('optionaler Abzug für das Zugteam', () => {
  const state = setup();
  state.settings.wrongPenalty = 'half';
  G.pickCell(state, 0, 3); // 500
  G.judge(state, false);
  assert.equal(score(state, 0), -250);
});

test('volles Board beendet die Runde, danach Spielende', () => {
  const state = setup();
  const playAll = () => {
    for (let c = 0; c < state.board.categories.length; c++) {
      for (let r = 0; r < 4; r++) {
        G.pickCell(state, c, r);
        G.endQuestion(state);
        G.closeQuestion(state);
      }
    }
  };
  playAll();
  assert.equal(state.phase, 'roundEnd');
  G.nextRound(state);
  assert.equal(state.round, 2);
  assert.equal(state.board.multiplier, 2);
  playAll();
  assert.equal(state.phase, 'gameOver');
});

test('Spieler sehen die Antwort erst nach dem Auflösen', () => {
  const state = setup();
  G.joinTeam(state, 'g2', state.teams[1].id, 'Bea');
  G.pickCell(state, 0, 0);

  const player = G.viewFor(state, { isHost: false, clientId: 'g2' });
  assert.equal(player.current.answer, null);
  const host = G.viewFor(state, { isHost: true, clientId: null });
  assert.equal(host.current.answer, 'A-Antwort 0');

  G.endQuestion(state);
  assert.equal(G.viewFor(state, { isHost: false, clientId: 'g2' }).current.answer, 'A-Antwort 0');
});

test('viewFor meldet dem Gerät, ob es buzzern darf', () => {
  const state = setup();
  G.joinTeam(state, 'g2', state.teams[1].id, 'Bea');
  G.pickCell(state, 0, 0);
  assert.equal(G.viewFor(state, { isHost: false, clientId: 'g2' }).you.canBuzz, false);
  G.passQuestion(state);
  assert.equal(G.viewFor(state, { isHost: false, clientId: 'g2' }).you.canBuzz, true);
  G.buzz(state, 'g2');
  assert.equal(G.viewFor(state, { isHost: false, clientId: 'g2' }).you.canBuzz, false);
  assert.equal(G.viewFor(state, { isHost: false, clientId: 'g2' }).you.onTheHook, true);
});

test('ein Gerät gehört immer nur zu einem Team', () => {
  const state = G.createState();
  G.addTeam(state, 'A');
  G.addTeam(state, 'B');
  G.joinTeam(state, 'g1', state.teams[0].id, 'Ada');
  G.joinTeam(state, 'g1', state.teams[1].id, 'Ada');
  assert.equal(state.teams[0].members.length, 0);
  assert.equal(state.teams[1].members.length, 1);
});

test('jedes Team bekommt ein eigenes Wappen', () => {
  const state = G.createState();
  for (let i = 0; i < 8; i++) G.addTeam(state, `T${i}`);
  const wappen = state.teams.map((t) => t.wappen);
  assert.equal(new Set(wappen).size, 8, 'acht Teams, acht verschiedene Wappen');
  for (const w of wappen) assert.ok(G.TEAM_WAPPEN.includes(w));

  // Wie bei der Farbe: Nach einem Löschen wird das freigewordene Wappen wieder
  // vergeben, statt dass das nächste Team eins doppelt bekommt.
  const weg = state.teams[2].wappen;
  G.removeTeam(state, state.teams[2].id);
  G.addTeam(state, 'Neu');
  assert.equal(state.teams[7].wappen, weg);
});

test('Wappen tauschen – nur in der Lobby und nur, wenn es frei ist', () => {
  const state = G.createState();
  G.addTeam(state, 'A');
  G.addTeam(state, 'B');
  const frei = G.TEAM_WAPPEN.find((w) => !state.teams.some((t) => t.wappen === w));

  G.setTeamWappen(state, state.teams[0].id, frei);
  assert.equal(state.teams[0].wappen, frei);

  // Das eigene nochmal antippen ist kein Fehler, sondern ein Nichts.
  G.setTeamWappen(state, state.teams[0].id, frei);
  assert.equal(state.teams[0].wappen, frei);

  assert.throws(() => G.setTeamWappen(state, state.teams[1].id, frei), /anderes Team/);
  assert.throws(() => G.setTeamWappen(state, state.teams[1].id, '🍕'), /gibt es nicht/);

  G.startGame(state, SET);
  const nochFrei = G.TEAM_WAPPEN.find((w) => !state.teams.some((t) => t.wappen === w));
  assert.throws(() => G.setTeamWappen(state, state.teams[0].id, nochFrei), /Lobby/);
});

test('alte Spielstände ohne Wappen bekommen in der Sicht eins', () => {
  const state = setup(['A', 'B']);
  for (const team of state.teams) delete team.wappen;
  const sicht = G.viewFor(state, { isHost: true, clientId: 'h' });
  const wappen = sicht.teams.map((t) => t.wappen);
  assert.equal(new Set(wappen).size, 2);
  for (const w of wappen) assert.ok(G.TEAM_WAPPEN.includes(w));
});

test('Spiel braucht mindestens zwei Teams', () => {
  const state = G.createState();
  G.addTeam(state, 'Allein');
  assert.throws(() => G.startGame(state, SET), G.GameError);
});

test('Host kann stellvertretend buzzern', () => {
  const state = setup();
  G.pickCell(state, 0, 1); // 200
  G.passQuestion(state);
  G.buzzFor(state, state.teams[2].id);
  G.judge(state, true);
  assert.equal(score(state, 2), 100);
});

/* ------------------------------------------------------------ Regressionen */
// Jeder Test hier steht für einen Fehler, der schon einmal drin war.

test('„Weiter" verbrennt keine laufende Frage', () => {
  const state = setup();
  G.pickCell(state, 0, 3); // 500
  assert.throws(() => G.closeQuestion(state), G.GameError);
  G.judge(state, false);
  assert.throws(() => G.closeQuestion(state), G.GameError, 'auch bei offenem Buzzer nicht');
  G.endQuestion(state);
  G.closeQuestion(state);
  assert.equal(state.phase, 'board');
});

test('Auflösen ist gesperrt, solange jemand antworten muss', () => {
  const state = setup();
  G.joinTeam(state, 'g2', state.teams[1].id, 'Bea');
  G.pickCell(state, 0, 0);
  assert.throws(() => G.revealAnswer(state), G.GameError, 'nicht während das Zugteam dran ist');
  G.judge(state, false);
  G.buzz(state, 'g2');
  assert.throws(() => G.revealAnswer(state), G.GameError, 'nicht während ein Buzzer dran ist');
  assert.equal(G.viewFor(state, { isHost: false, clientId: 'g2' }).current.answer, null);
});

test('buzzAfterCorrect deckt die Lösung nicht vorzeitig auf', () => {
  const state = setup();
  state.settings.buzzAfterCorrect = true;
  G.joinTeam(state, 'g2', state.teams[1].id, 'Bea');
  G.pickCell(state, 0, 3);
  G.judge(state, true);
  const view = G.viewFor(state, { isHost: false, clientId: 'g2' });
  assert.equal(view.you.canBuzz, true, 'die anderen dürfen noch');
  assert.equal(view.current.answer, null, 'aber ohne die Lösung zu sehen');
});

test('Teamwechsel mitten in der Frage ist gesperrt', () => {
  const state = setup();
  G.joinTeam(state, 'handy', state.teams[1].id, 'Bea');
  G.pickCell(state, 0, 3);
  G.passQuestion(state);
  G.buzz(state, 'handy');
  G.judge(state, false); // -250, Team 2 gesperrt
  assert.throws(() => G.joinTeam(state, 'handy', state.teams[2].id, 'Bea'), G.GameError);
  assert.throws(() => G.leaveTeams(state, 'handy'), G.GameError);
  assert.equal(state.teams[2].score, 0);
});

test('keepOnCorrect gibt den Zug an den, der wirklich gelöst hat', () => {
  const state = setup();
  state.settings.turnMode = 'keepOnCorrect';
  G.joinTeam(state, 'g3', state.teams[2].id, 'Cem');
  G.pickCell(state, 0, 0);
  G.judge(state, false);
  G.buzz(state, 'g3');
  G.judge(state, true);
  G.closeQuestion(state);
  assert.equal(state.teams[state.turnIndex].id, state.teams[2].id);
});

test('resetBuzz wirkt nur bei offenem Buzzer', () => {
  const state = setup();
  G.joinTeam(state, 'g2', state.teams[1].id, 'Bea');
  G.pickCell(state, 0, 3);
  assert.throws(() => G.resetBuzz(state), G.GameError, 'nicht während das Zugteam dran ist');
  G.judge(state, false);
  G.buzz(state, 'g2');
  G.resetBuzz(state);
  assert.equal(state.current.buzzedTeamId, null);
  assert.equal(G.viewFor(state, { isHost: false, clientId: 'g2' }).you.canBuzz, true);

  G.buzz(state, 'g2');
  G.judge(state, true);
  assert.equal(state.teams[1].score, 250);
  assert.throws(() => G.resetBuzz(state), G.GameError, 'eine gewertete Frage bleibt gewertet');
  assert.equal(state.teams[1].score, 250);
});

test('volles Team lässt den Spieler in seinem alten Team', () => {
  const state = G.createState();
  G.addTeam(state, 'Voll');
  G.addTeam(state, 'Annas Team');
  for (const id of ['a', 'b', 'c', 'd']) G.joinTeam(state, id, state.teams[0].id, id);
  G.joinTeam(state, 'anna', state.teams[1].id, 'Anna');
  assert.throws(() => G.joinTeam(state, 'anna', state.teams[0].id, 'Anna'), G.GameError);
  assert.equal(G.teamOfClient(state, 'anna')?.id, state.teams[1].id, 'Anna bleibt wo sie war');
});

test('getrennte Geräte blockieren keinen Platz im Team', () => {
  const state = G.createState();
  G.addTeam(state, 'Team');
  G.addTeam(state, 'Anderes');
  for (const id of ['a', 'b', 'c', 'd']) G.joinTeam(state, id, state.teams[0].id, id);
  G.setMemberOnline(state, 'a', false);
  G.joinTeam(state, 'e', state.teams[0].id, 'Neu');
  assert.equal(state.teams[0].members.length, 5);
  assert.equal(G.viewFor(state, { isHost: true }).teams[0].members[0].online, false);

  G.removeMember(state, state.teams[0].id, 'a');
  assert.equal(state.teams[0].members.length, 4);
});

test('neues Spiel nimmt Karteileichen nicht mit', () => {
  // „Karteileiche“ heißt: seit Stunden weg. Ein Handy, das gerade in der Pause
  // gesperrt hat, ist keine – wer nach dem Aufwecken weiterspielen will, soll
  // sein Team noch vorfinden.
  const state = G.createState();
  G.addTeam(state, 'Team');
  G.addTeam(state, 'Zwei');
  G.joinTeam(state, 'da', state.teams[0].id, 'Da');
  G.joinTeam(state, 'pause', state.teams[0].id, 'Pause');
  G.joinTeam(state, 'weg', state.teams[0].id, 'Weg');
  G.setMemberOnline(state, 'pause', false); // eben erst gesperrt
  G.setMemberOnline(state, 'weg', false);
  // Der ist vor drei Stunden nach Hause gegangen.
  const alt = state.teams[0].members.find((m) => m.clientId === 'weg');
  alt.wegSeit = Date.now() - 3 * 60 * 60 * 1000;
  G.adjustScore(state, state.teams[0].id, 400);
  const fresh = G.backToLobby(state);
  assert.deepEqual(fresh.teams[0].members.map((m) => m.name), ['Da', 'Pause']);
  assert.equal(fresh.teams[0].score, 0);
});

test('wer zurückkommt, verliert seinen Vermerk wieder', () => {
  // Sonst zählt beim übernächsten Neustart noch die alte Abwesenheit mit und
  // wirft jemanden raus, der den ganzen Abend dabei war.
  const state = G.createState();
  G.addTeam(state, 'Team');
  G.joinTeam(state, 'x', state.teams[0].id, 'X');
  G.setMemberOnline(state, 'x', false);
  assert.ok(state.teams[0].members[0].wegSeit, 'Abmeldung wird vermerkt');
  G.setMemberOnline(state, 'x', true);
  assert.equal(state.teams[0].members[0].wegSeit, undefined);
});

test('gelöschtes Team gibt Farbe und Namen wieder frei', () => {
  // Sonst tragen zwei Pulte dieselbe Farbe – und an der Leiste ist Farbe das
  // Einzige, woran man die Teams aus vier Metern auseinanderhält.
  const state = G.createState();
  for (const n of ['A', 'B', 'C']) G.addTeam(state, n);
  const farbeB = state.teams[1].color;
  G.removeTeam(state, state.teams[1].id);
  G.addTeam(state, 'D');
  const farben = state.teams.map((t) => t.color);
  assert.equal(new Set(farben).size, farben.length, 'jede Farbe nur einmal');
  assert.equal(state.teams[2].color, farbeB, 'die frei gewordene Farbe wird wiederverwendet');

  // Und der Standardname zählt nicht die Teams, sondern sucht die freie Nummer.
  G.addTeam(state, '');
  assert.equal(new Set(state.teams.map((t) => t.name)).size, state.teams.length);
});

test('„dran" mitten in der Frage überspringt kein Team', () => {
  // setTurn verschiebt nur den Zeiger; weitergezählt wird ab dem Team, das die
  // Frage hatte. Sonst kommt nach dem Schließen ein Team gar nicht dran.
  const state = setup(); // Team 1, 2, 3 – Team 1 ist am Zug
  G.pickCell(state, 0, 0);
  G.setTurn(state, state.teams[2].id); // der Host korrigiert mitten in der Frage
  G.judge(state, true);
  G.closeQuestion(state);
  assert.equal(state.teams[state.turnIndex].name, 'Team 2', 'nach Team 1 kommt Team 2');
});

test('Host-Buzz überschreibt keinen echten Buzz', () => {
  // Der Host greift zur Fernbedienung, während schon jemand gedrückt hat –
  // sonst nimmt sein Griff dem Handy die Frage weg, das schneller war.
  const state = setup();
  G.joinTeam(state, 'g2', state.teams[1].id, 'Bea');
  G.pickCell(state, 0, 3);
  G.passQuestion(state);
  G.buzz(state, 'g2');

  assert.throws(() => G.buzzFor(state, state.teams[2].id), G.GameError);
  assert.equal(state.current.buzzedTeamId, state.teams[1].id, 'Bea bleibt am Zug');

  G.resetBuzz(state);
  G.buzzFor(state, state.teams[2].id);
  assert.equal(state.current.buzzedTeamId, state.teams[2].id);
});

test('beendete Frage lässt keinen Buzz stehen', () => {
  // Sonst halten Fernbedienung und Handys die Frage für offen und zeigen weiter
  // „Bea hat gebuzzert" statt „Weiter" – der Abend bleibt an der Stelle hängen.
  const state = setup();
  G.joinTeam(state, 'g2', state.teams[1].id, 'Bea');
  G.pickCell(state, 0, 3);
  G.passQuestion(state);
  G.buzz(state, 'g2');
  G.judge(state, true);

  assert.equal(state.current.step, 'result');
  assert.equal(state.current.buzzedTeamId, null);
  assert.equal(state.current.buzzedBy, null);
  assert.equal(state.current.onTheHook, null);
  assert.equal(G.viewFor(state, { isHost: false, clientId: 'g2' }).current.buzzedTeamId, null);
});

test('endQuestion verschluckt keinen Buzz, der im selben Moment ankommt', () => {
  // Der Host hört den Buzzer und drückt trotzdem „keiner weiß es" – wer zuerst
  // dran war, entscheidet der Server, nicht die Reaktionszeit des Hosts.
  const state = setup();
  G.joinTeam(state, 'g2', state.teams[1].id, 'Bea');
  G.pickCell(state, 0, 3);
  G.passQuestion(state);
  G.buzz(state, 'g2');

  assert.throws(() => G.endQuestion(state), G.GameError);
  assert.equal(state.current.revealed, false, 'die Lösung bleibt verdeckt');
  assert.equal(state.current.buzzedTeamId, state.teams[1].id, 'Bea ist weiter am Zug');

  // Zurücknehmen ist der Weg, wenn der Host den Buzz nicht gelten lassen will.
  G.resetBuzz(state);
  G.endQuestion(state);
  assert.equal(state.current.step, 'result');
});

test('Auflösen ist auch bei offenem Buzzer gesperrt', () => {
  const state = setup();
  G.pickCell(state, 0, 0);
  G.passQuestion(state); // Buzzer offen, niemand am Zug
  assert.equal(state.current.onTheHook, null);
  assert.throws(() => G.revealAnswer(state), G.GameError, 'sonst wäre die Lösung eine Vorlage');
  G.endQuestion(state);
  G.revealAnswer(state);
  assert.equal(state.current.revealed, true);
});

/* ------------------------------------------------------------------ Bilanz */

test('Bilanz zählt richtig, falsch und „weiß nicht"', () => {
  const state = setup();
  const [a, b] = state.teams;

  // Team A antwortet richtig.
  G.pickCell(state, 0, 0);
  G.judge(state, true);
  G.closeQuestion(state);
  assert.equal(a.bilanz.richtig, 1);
  assert.equal(a.bilanz.geholt, 100);
  assert.equal(a.bilanz.geklaut, 0, 'am eigenen Feld ist nichts geklaut');

  // Team B passt, Team C buzzert sich rein und trifft.
  G.pickCell(state, 0, 1);
  G.passQuestion(state);
  assert.equal(b.bilanz.gepasst, 1);
  G.buzzFor(state, state.teams[2].id);
  G.judge(state, true);
  G.closeQuestion(state);
  assert.equal(state.teams[2].bilanz.geklaut, 1, 'am fremden Feld geholt');
  assert.equal(state.teams[2].bilanz.geholt, 100, 'halbe Punkte von 200');
});

test('Bilanz zählt verlorene Punkte positiv und trennt Verbuzzern', () => {
  const state = setup();
  state.settings.wrongPenalty = 'full';
  const [a, b] = state.teams;

  G.pickCell(state, 0, 3); // 500 Punkte
  G.judge(state, false); // Zugteam daneben
  assert.equal(a.bilanz.falsch, 1);
  assert.equal(a.bilanz.verloren, 500, 'positiv gezählt');
  assert.equal(a.bilanz.daneben, 0, 'am eigenen Feld ist es kein Verbuzzern');

  G.buzzFor(state, b.id);
  G.judge(state, false);
  assert.equal(b.bilanz.falsch, 1);
  assert.equal(b.bilanz.daneben, 1, 'per Buzzer danebengelegen');
  assert.equal(b.bilanz.verloren, 250, 'die Hälfte von 500');
});

test('„weiß nicht" kostet dasselbe wie eine falsche Antwort', () => {
  for (const [abzug, erwartet] of [['none', 0], ['half', -250], ['full', -500]]) {
    // Zwei gleich aufgebaute Abende: einmal geraten und danebengelegen,
    // einmal ehrlich gepasst. Am Ende muss dasselbe auf der Tafel stehen.
    const geraten = setup();
    const gepasst = setup();
    for (const state of [geraten, gepasst]) {
      state.settings.wrongPenalty = abzug;
      G.pickCell(state, 0, 3); // 500 Punkte
    }
    G.judge(geraten, false);
    G.passQuestion(gepasst);

    assert.equal(geraten.teams[0].score, erwartet, `falsch bei „${abzug}"`);
    assert.equal(gepasst.teams[0].score, erwartet, `weiß nicht bei „${abzug}"`);
    assert.equal(gepasst.teams[0].bilanz.falsch, 1, 'zählt als falsche Antwort');
    assert.equal(gepasst.teams[0].bilanz.gepasst, 1, 'und bleibt trotzdem ein „weiß nicht"');
    assert.equal(gepasst.teams[0].bilanz.verloren, Math.abs(erwartet), 'verlorene Punkte positiv gezählt');
    // Beide Male dürfen die Übrigen ran.
    assert.equal(gepasst.current.step, 'buzz');
    assert.equal(geraten.current.step, 'buzz');
  }
});

test('„weiß nicht" reißt die Serie genauso wie eine falsche Antwort', () => {
  const state = setup(['Team 1', 'Team 2']);
  state.settings.turnMode = 'keepOnCorrect';

  G.pickCell(state, 0, 0);
  G.judge(state, true);
  G.closeQuestion(state);
  assert.equal(state.teams[0].serie, 1);

  // Dasselbe Team ist wieder dran und weiß es nicht.
  G.pickCell(state, 0, 1);
  G.passQuestion(state);
  assert.equal(state.teams[0].serie, 0, 'Serie ist gerissen');
  assert.equal(state.teams[0].serieBest, 1, 'die beste Serie bleibt notiert');
});

test('„weiß nicht" mit Abzug landet im Protokoll und beim teuersten Reinfall', () => {
  const state = setup();
  state.settings.wrongPenalty = 'full';
  G.pickCell(state, 0, 3); // 500 Punkte
  G.passQuestion(state);

  const eintrag = state.current.log.at(-1);
  assert.equal(eintrag.result, 'pass', 'im Protokoll bleibt es ein „weiß nicht"');
  assert.equal(eintrag.delta, -500, 'mit dem Abzug daneben');
  assert.equal(state.rekorde.teuersterReinfall?.delta, -500);
});

test('ein neues Spiel setzt die Bilanz zurück', () => {
  const state = setup();
  G.pickCell(state, 0, 0);
  G.judge(state, true);
  G.closeQuestion(state);
  assert.equal(state.teams[0].bilanz.richtig, 1);

  // Über die Lobby, wie „Neues Spiel" auf dem Host-Screen: Ein Satz lässt sich
  // nicht mitten aus einer laufenden Runde heraus neu starten.
  Object.assign(state, G.backToLobby(state));
  G.startGame(state, SET);
  assert.deepEqual(
    state.teams.map((t) => t.bilanz.richtig + t.bilanz.geholt),
    [0, 0, 0],
  );

  // Und auch der Weg über die Lobby räumt auf.
  G.pickCell(state, 0, 0);
  G.judge(state, true);
  G.closeQuestion(state);
  const frisch = G.backToLobby(state);
  assert.deepEqual(frisch.teams.map((t) => t.bilanz.richtig), [0, 0, 0]);
});

test('ein Spielstand ohne Bilanz überlebt die erste Wertung', () => {
  // Genau die Lage nach einem Update: Der Server stellt einen Stand wieder her,
  // der vor dieser Buchhaltung gespeichert wurde. Kein Team bringt eine Bilanz
  // mit – die Wertung darf daran nicht sterben.
  const state = setup();
  for (const team of state.teams) delete team.bilanz;

  G.pickCell(state, 0, 0);
  assert.doesNotThrow(() => G.judge(state, true));
  assert.equal(state.teams[0].bilanz.richtig, 1);
  G.closeQuestion(state);

  // Auch „weiß nicht" und ein falscher Buzz legen die Bilanz sauber an.
  for (const team of state.teams) delete team.bilanz;
  G.pickCell(state, 0, 1);
  assert.doesNotThrow(() => G.passQuestion(state));
  // Nicht das Zugteam – das darf sich bei seiner eigenen Frage nicht reinbuzzern.
  const fremd = state.teams.find((t) => t.id !== state.current.teamId);
  G.buzzFor(state, fremd.id);
  assert.doesNotThrow(() => G.judge(state, false));
  assert.equal(fremd.bilanz.daneben, 1);

  // Und die Sicht aufs Handy liefert trotzdem eine vollständige Bilanz.
  for (const team of state.teams) delete team.bilanz;
  const sicht = G.viewFor(state, { isHost: false, clientId: 'x' });
  assert.equal(sicht.teams[0].bilanz.richtig, 0);
  assert.equal(sicht.teams[0].bilanz.geholt, 0);
});

test('geklaute Punkte werden getrennt gezählt', () => {
  const state = setup();
  const [a, b] = state.teams;

  // Team A punktet am eigenen Feld – das ist nichts Geklautes.
  G.pickCell(state, 0, 3); // 500
  G.judge(state, true);
  G.closeQuestion(state);
  assert.equal(a.bilanz.geholt, 500);
  assert.equal(a.bilanz.geklautPunkte, 0);

  // Team B passt, A buzzert sich rein und trifft: halbe Punkte, und die zählen.
  G.pickCell(state, 1, 3); // 500, Team B ist dran
  assert.equal(state.current.teamId, b.id);
  G.passQuestion(state);
  G.buzzFor(state, a.id);
  G.judge(state, true);
  assert.equal(a.bilanz.geklautPunkte, 250, 'die Hälfte von 500');
  assert.equal(a.bilanz.geholt, 750, 'die Gesamtsumme enthält beides');
  assert.equal(a.bilanz.geklaut, 2 - 1, 'einmal geklaut');
});

test('eine Bilanz ohne die neueren Felder wird ergänzt statt zu NaN', () => {
  // Genau der Spielstand, der zwischen zwei Fassungen gespeichert wurde: Die
  // Bilanz ist da, kennt aber ein später hinzugekommenes Feld noch nicht.
  const state = setup();
  for (const team of state.teams) {
    team.bilanz = { richtig: 3, falsch: 1, gepasst: 0, geklaut: 0, daneben: 0, geholt: 900, verloren: 0 };
    delete team.bilanz.geklautPunkte;
  }
  const [a, b] = state.teams;
  G.pickCell(state, 0, 0);
  assert.equal(state.current.teamId, a.id);
  G.passQuestion(state);
  G.buzzFor(state, b.id);
  G.judge(state, true);

  assert.equal(b.bilanz.geklautPunkte, 50, 'das fehlende Feld wurde ergänzt, nicht zu NaN addiert');
  assert.ok(Number.isFinite(b.bilanz.geholt), 'und die alten Werte bleiben Zahlen');
  assert.equal(b.bilanz.richtig, 4, 'die vorhandene Zählung läuft weiter');

  // Auch die Sicht aufs Handy liefert das neue Feld.
  const sicht = G.viewFor(state, { isHost: false, clientId: 'x' });
  assert.equal(typeof sicht.teams[0].bilanz.geklautPunkte, 'number');
});

/* ------------------------------------ Regeln, die sich gegenseitig bedingen */
// Die Einstellungen lassen sich einzeln umlegen, und ihre Kombinationen sind
// genau die Fälle, über die am Tisch gestritten wird. Hier stehen sie fest.

test('keepOnCorrect + Nachbuzzern: der Erste, der richtig lag, bleibt dran', () => {
  const state = setup();
  state.settings.turnMode = 'keepOnCorrect';
  state.settings.buzzAfterCorrect = true;
  const [a, b] = state.teams;

  G.pickCell(state, 0, 0);
  assert.equal(state.current.teamId, a.id);
  G.judge(state, true); // Zugteam richtig – der Buzzer bleibt trotzdem offen
  assert.equal(state.current.step, 'buzz');
  G.buzzFor(state, b.id);
  G.judge(state, true); // auch das zweite Team liegt richtig
  G.closeQuestion(state);

  assert.equal(state.teams[state.turnIndex].id, a.id,
    'zwei Richtige, aber der Erste behält den Zug – sonst wäre es Zufall, wer schneller drückt');
  assert.equal(a.score, 100, 'volle Punkte fürs Zugteam');
  assert.equal(b.score, 50, 'halbe fürs Nachbuzzern');
});

test('keepOnCorrect ohne einen einzigen Richtigen zählt normal weiter', () => {
  const state = setup();
  state.settings.turnMode = 'keepOnCorrect';
  const [a, b] = state.teams;

  G.pickCell(state, 0, 0);
  G.judge(state, false);
  G.buzzFor(state, b.id);
  G.judge(state, false);
  G.endQuestion(state);
  G.closeQuestion(state);

  assert.equal(state.teams[state.turnIndex].id, b.id,
    'niemand hat gelöst – dann geht es reihum vom Team weiter, das die Frage hatte');
  assert.notEqual(state.turnIndex, state.teams.indexOf(a));
});

test('voller Abzug trifft nur das Zugteam, der Buzzer kostet weiter die Hälfte', () => {
  const state = setup();
  state.settings.wrongPenalty = 'full';
  const [a, b] = state.teams;

  G.pickCell(state, 0, 3); // 500
  G.judge(state, false);
  assert.equal(a.score, -500, 'das Zugteam zahlt voll');
  G.buzzFor(state, b.id);
  G.judge(state, false);
  assert.equal(b.score, -250, 'wer sich reinbuzzert, zahlt die Hälfte – unabhängig von der Einstellung');
});

test('Abzug greift auch in Runde 2, dort auf die verdoppelten Werte', () => {
  const state = setup();
  state.settings.wrongPenalty = 'half';
  G.startRound(state, 2);
  const a = state.teams[0];

  G.pickCell(state, 0, 3); // in Runde 2: 1000
  assert.equal(state.current.value, 1000);
  G.judge(state, false);
  assert.equal(a.score, -500, 'die Hälfte von 1000');
});

test('Nachbuzzern nach richtiger Antwort endet, wenn keiner mehr darf', () => {
  const state = setup(['Team 1', 'Team 2']);
  state.settings.buzzAfterCorrect = true;
  const [a, b] = state.teams;

  G.pickCell(state, 0, 0);
  G.judge(state, true);
  assert.equal(state.current.step, 'buzz', 'der Buzzer geht auf');
  G.buzzFor(state, b.id);
  G.judge(state, false);
  // Bei zwei Teams ist danach niemand mehr übrig: Das Zugteam darf nicht, und
  // das andere hat seinen Versuch gehabt.
  assert.equal(state.current.step, 'result', 'die Frage schließt sich von selbst');
  assert.equal(state.current.revealed, true);
  assert.equal(a.score, 100);
  assert.equal(b.score, -50);
});

test('die Einstellungen gelten ab sofort, auch mitten im Spiel', () => {
  const state = setup();
  const a = state.teams[0];

  state.settings.wrongPenalty = 'none';
  G.pickCell(state, 0, 3); // 500, kein Abzug eingestellt
  G.judge(state, false);
  assert.equal(a.score, 0);
  G.endQuestion(state);
  G.closeQuestion(state);

  // Der Host stellt um – die nächste Frage rechnet schon anders.
  state.settings.wrongPenalty = 'full';
  G.pickCell(state, 1, 3); // 500
  G.judge(state, false);
  assert.equal(state.teams[1].score, -500, 'die neue Regel greift sofort');
});

test('„nur der Host wählt" hält das Handy vom Feldaufruf ab', () => {
  // Manche Runden laufen besser, wenn der Host die Felder aufruft: Er sieht das
  // Brett, der Tisch ruft zu, und niemand tippt versehentlich das teuerste Feld
  // an. Das Handy muss dann abprallen – aber mit einer Erklärung.
  const state = setup(); // startet den Satz bereits
  const dran = state.teams[state.turnIndex];

  // Voreinstellung: Das Zugteam darf selbst.
  assert.equal(state.settings.feldwahl, 'team');
  G.pickCell(state, 0, 0, dran.id);
  assert.equal(state.phase, 'question');
  G.endQuestion(state);
  G.closeQuestion(state);

  state.settings.feldwahl = 'host';
  const jetztDran = state.teams[state.turnIndex];
  assert.throws(
    () => G.pickCell(state, 0, 1, jetztDran.id),
    /Host ruft die Fragen auf/,
    'auch das Zugteam kommt jetzt nicht mehr durch',
  );
  assert.equal(state.phase, 'board', 'und das Brett bleibt unangetastet');
  assert.equal(state.board.categories[0].cells[1].used, false, 'das Feld ist nicht verbraucht');

  // Der Host selbst ruft ohne Team-Kennung auf – der geht durch.
  G.pickCell(state, 0, 1);
  assert.equal(state.phase, 'question');
  assert.equal(state.current.teamId, jetztDran.id, 'und zwar für das Team, das dran ist');
});

test('die Feldwahl lässt sich mitten im Spiel umstellen', () => {
  const state = setup(); // startet den Satz bereits
  state.settings.feldwahl = 'host';
  assert.throws(() => G.pickCell(state, 0, 0, state.teams[state.turnIndex].id), /Host ruft/);
  state.settings.feldwahl = 'team';
  G.pickCell(state, 0, 0, state.teams[state.turnIndex].id);
  assert.equal(state.phase, 'question', 'zurückgestellt geht es sofort wieder');
});

/* ----------------------------------------------------------------- Stechen */

/** Spielt beide Runden leer, ohne dass jemand punktet – Endstand 0:0:0. */
function bisGleichstand(state) {
  for (let runde = 1; runde <= 2; runde++) {
    for (const [ci, cat] of state.board.categories.entries()) {
      for (const [ri] of cat.cells.entries()) {
        G.pickCell(state, ci, ri);
        G.endQuestion(state);
        G.closeQuestion(state);
      }
    }
    if (state.phase === 'roundEnd') G.nextRound(state);
  }
  return state;
}

const STECHFRAGE = { text: 'Wie viele Beine hat eine Spinne?', answer: '8', category: 'Tiere' };

test('ein Stechen gibt es erst am Ende und nur bei Gleichstand', () => {
  const state = setup();
  assert.throws(() => G.startStechen(state, STECHFRAGE), /erst, wenn das Spiel durch ist/);
  bisGleichstand(state);
  assert.equal(state.phase, 'gameOver');
  G.adjustScore(state, state.teams[0].id, 100);
  assert.throws(() => G.startStechen(state, STECHFRAGE), /schon ein Sieger/);
  G.adjustScore(state, state.teams[0].id, -100);
  G.startStechen(state, STECHFRAGE);
  assert.equal(state.phase, 'question');
  assert.equal(state.current.stechen, true);
});

test('im Stechen darf jedes Team an der Spitze buzzern, sonst niemand', () => {
  const state = setup();
  bisGleichstand(state);
  // Ein Team fällt zurück – es hat mit dem Stechen nichts zu tun.
  G.adjustScore(state, state.teams[2].id, -100);
  G.startStechen(state, STECHFRAGE);
  assert.deepEqual(state.current.lockedOut, [state.teams[2].id]);
  assert.equal(state.current.teamId, null, 'es gibt kein Zugteam');
  assert.throws(() => G.buzzFor(state, state.teams[2].id), /schon versucht/);
  G.buzzFor(state, state.teams[1].id);
  assert.equal(state.current.buzzedTeamId, state.teams[1].id);
});

test('das Stechen ändert keine Punkte, sondern kürt einen Sieger', () => {
  const state = setup();
  bisGleichstand(state);
  G.startStechen(state, STECHFRAGE);

  // Erst daneben: kostet nichts, ist aber raus.
  G.buzzFor(state, state.teams[0].id);
  G.judge(state, false);
  assert.equal(score(state, 0), 0, 'kein Abzug im Stechen');
  assert.equal(state.teams[0].bilanz.falsch, 0, 'und kein Eintrag in der Bilanz');
  assert.ok(state.current.lockedOut.includes(state.teams[0].id));
  assert.equal(state.current.step, 'buzz', 'die Übrigen sind weiter dran');
  assert.equal(state.stechenSieger, null);

  // Dann richtig: entscheidet den Abend, ohne einen Punkt zu vergeben.
  G.buzzFor(state, state.teams[1].id);
  G.judge(state, true);
  assert.equal(state.stechenSieger, state.teams[1].id);
  assert.equal(score(state, 1), 0, 'auch der Sieg bringt keine Punkte');
  assert.equal(state.current.step, 'result');
  assert.equal(state.current.revealed, true, 'die Lösung steht danach da');

  G.closeQuestion(state);
  assert.equal(state.phase, 'gameOver', 'zurück in den Endstand');
  assert.equal(G.ranking(state)[0].id, state.teams[1].id, 'und der Sieger steht oben');
});

test('weiß es keiner, geht es mit einer neuen Frage weiter', () => {
  const state = setup();
  bisGleichstand(state);
  G.startStechen(state, STECHFRAGE);
  // Alle drei liegen daneben – danach ist die Frage von selbst durch.
  for (const team of state.teams) {
    G.buzzFor(state, team.id);
    G.judge(state, false);
  }
  assert.equal(state.current.step, 'result');
  assert.equal(state.current.revealed, true);
  G.closeQuestion(state);
  assert.equal(state.phase, 'gameOver');
  assert.equal(state.stechenSieger, null, 'entschieden ist noch nichts');

  // Dieselbe Frage kommt nicht noch einmal: Der Server schließt sie über
  // state.stechenTexte aus.
  assert.deepEqual(state.stechenTexte, [STECHFRAGE.text]);
  G.startStechen(state, { text: 'Und noch eine?', answer: 'Ja' });
  assert.equal(state.stechenLauf, 2);
  assert.notEqual(G.lageSignatur(state), 'fnull.null#buzz#', 'die Lage trägt den Zähler');
});

test('ein neues Spiel weiß nichts mehr vom Stechen', () => {
  const state = setup();
  bisGleichstand(state);
  G.startStechen(state, STECHFRAGE);
  G.buzzFor(state, state.teams[0].id);
  G.judge(state, true);
  G.closeQuestion(state);
  assert.ok(state.stechenSieger);
  Object.assign(state, G.backToLobby(state));
  G.startGame(state, SET);
  assert.equal(state.stechenSieger, null);
  assert.equal(state.stechenLauf, 0);
  assert.deepEqual(state.stechenTexte, []);
});

test('ein Satz lässt sich nicht mitten im Spiel neu starten', () => {
  // „Spiel starten" gibt es auf dem Host-Screen nur in der Lobby. Der Server
  // ließ es trotzdem in jeder Lage zu – auch bei einer offenen Frage auf der
  // Leinwand. Alle Punkte auf null, neues Brett, und zurückzunehmen ist davon
  // nichts: Der Spielstart räumt den Rückweg selbst ab.
  const state = setup();
  G.pickCell(state, 0, 0);
  G.judge(state, true);
  assert.equal(state.teams[0].score > 0, true);

  assert.throws(() => G.startGame(state, SET), /Neues Spiel/);
  assert.equal(state.phase, 'question', 'die laufende Frage steht noch');
  assert.ok(state.teams[0].score > 0, 'und die Punkte auch');

  // Über die Lobby geht es – und dann ist auch wirklich alles zurückgesetzt.
  Object.assign(state, G.backToLobby(state));
  G.startGame(state, SET);
  assert.equal(state.phase, 'board');
  assert.deepEqual(state.teams.map((t) => t.score), [0, 0, 0]);
});
