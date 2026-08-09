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
  assert.equal(score(state, 0), 0, 'Standard: kein Abzug für das Zugteam');
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
  const state = G.createState();
  G.addTeam(state, 'Team');
  G.addTeam(state, 'Zwei');
  G.joinTeam(state, 'da', state.teams[0].id, 'Da');
  G.joinTeam(state, 'weg', state.teams[0].id, 'Weg');
  G.setMemberOnline(state, 'weg', false);
  G.adjustScore(state, state.teams[0].id, 400);
  const fresh = G.backToLobby(state);
  assert.deepEqual(fresh.teams[0].members.map((m) => m.name), ['Da']);
  assert.equal(fresh.teams[0].score, 0);
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
