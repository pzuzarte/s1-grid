"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const Music = require("../music.js");

const C = 0;
const A = 9;
const seeded = (seed = 1) => {
  let value = seed;
  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
};

test("note names use middle C as C4", () => {
  assert.equal(Music.noteName(60), "C4");
  assert.equal(Music.noteName(61), "C#4");
  assert.equal(Music.noteName(36), "C2");
});

test("a key contains the right notes", () => {
  assert.deepEqual(Music.notesInKey(C, "major", 60, 72), [60, 62, 64, 65, 67, 69, 71, 72]);
  assert.deepEqual(Music.notesInKey(A, "minor", 57, 69), [57, 59, 60, 62, 64, 65, 67, 69]);
  assert.deepEqual(Music.notesInKey(C, "minorPentatonic", 60, 72), [60, 63, 65, 67, 70, 72]);
  assert.equal(Music.notesInKey(C, "chromatic", 60, 71).length, 12);
  assert.ok(Music.inKey(61, 1, "major"));
  assert.ok(!Music.inKey(61, C, "major"));
});

test("changing the root keeps each note's place in the scale", () => {
  // C major to D major.
  assert.deepEqual([60, 64, 67, 71].map((n) => Music.mapNote(n, C, "major", 2, "major")), [62, 66, 69, 73]);
  // C major to A major goes down, as the smallest move.
  assert.equal(Music.mapNote(60, C, "major", A, "major"), 57);
});

test("changing the scale keeps the root and changes the quality", () => {
  // C major to C minor: E becomes Eb, A becomes Ab, B becomes Bb.
  assert.deepEqual([60, 64, 69, 71].map((n) => Music.mapNote(n, C, "major", C, "minor")), [60, 63, 68, 70]);
});

test("a key change and back returns the same notes", () => {
  const notes = Music.notesInKey(C, "major", 48, 84);
  const there = notes.map((n) => Music.mapNote(n, C, "major", 5, "dorian"));
  const back = there.map((n) => Music.mapNote(n, 5, "dorian", C, "major"));
  assert.deepEqual(back, notes);
});

test("scales of different sizes land on notes in the new key", () => {
  for (const note of Music.notesInKey(C, "major", 48, 72)) {
    const mapped = Music.mapNote(note, C, "major", 7, "minorPentatonic");
    assert.ok(Music.inKey(mapped, 7, "minorPentatonic"), `note ${note} became ${mapped}`);
  }
});

test("notes outside the key move with the root", () => {
  assert.equal(Music.mapNote(61, C, "major", 2, "major"), 63);
});

test("mapped notes stay in the MIDI range and keep their other details", () => {
  assert.ok(Music.mapNote(127, C, "major", 5, "major") <= 127);
  assert.ok(Music.mapNote(0, 5, "major", C, "major") >= 0);
  const [mapped] = Music.mapNotes([{ time: 480, note: 60, velocity: 0.5, length: 90 }], C, "major", 2, "major");
  assert.deepEqual(mapped, { time: 480, note: 62, velocity: 0.5, length: 90 });
});

test("chords are built from the key's own notes", () => {
  assert.deepEqual(Music.chordNotes(60, "triad", C, "major"), [60, 64, 67]); // C major
  assert.deepEqual(Music.chordNotes(62, "triad", C, "major"), [62, 65, 69]); // D minor
  assert.deepEqual(Music.chordNotes(71, "triad", C, "major"), [71, 74, 77]); // B diminished
  assert.deepEqual(Music.chordNotes(57, "seventh", A, "minor"), [57, 60, 64, 67]); // A minor 7
  assert.deepEqual(Music.chordNotes(60, "fifth", C, "major"), [60, 67]);
  assert.deepEqual(Music.chordNotes(60, "note", C, "major"), [60]);
});

test("chords in other scale sizes still stay in key, without duplicates", () => {
  for (const scale of ["minorPentatonic", "majorPentatonic", "blues", "chromatic"]) {
    for (const chord of ["fifth", "triad", "seventh"]) {
      const notes = Music.chordNotes(60, chord, C, scale);
      assert.equal(new Set(notes).size, notes.length, `${scale} ${chord}`);
      notes.forEach((n) => assert.ok(Music.inKey(n, C, scale), `${scale} ${chord} ${n}`));
    }
  }
});

test("chords above the MIDI range drop notes rather than break", () => {
  const notes = Music.chordNotes(124, "triad", C, "major");
  notes.forEach((n) => assert.ok(n <= 127));
});

for (const kind of Object.keys(Music.GENERATORS)) {
  test(`${kind} writes valid notes in every key`, () => {
    for (const [root, scale] of [[C, "major"], [A, "minor"], [6, "dorian"], [3, "minorPentatonic"], [11, "blues"]]) {
      for (let seed = 1; seed < 8; seed += 1) {
        const lengthTicks = 15360;
        const notes = Music.generate(kind, { root, scale, low: 36, lengthTicks, random: seeded(seed) });
        assert.ok(notes.length > 0, `${kind} ${scale} is empty`);
        for (const n of notes) {
          assert.ok(Music.inKey(n.note, root, scale) || Music.inKey(n.note - 12, root, scale), `${kind} ${scale} note ${n.note}`);
          assert.ok(Number.isInteger(n.time) && n.time >= 0 && n.time < lengthTicks);
          assert.ok(n.length > 0 && n.time + n.length <= lengthTicks);
          assert.ok(n.velocity > 0 && n.velocity <= 1);
          assert.ok(n.note >= 0 && n.note <= 127);
        }
      }
    }
  });
}

test("generators give the same result for the same random numbers", () => {
  const make = () => Music.generate("melody", { root: C, scale: "major", low: 48, lengthTicks: 7680, random: seeded(5) });
  assert.deepEqual(make(), make());
});

test("generated chords have one chord per bar", () => {
  const notes = Music.generate("chords", { root: C, scale: "major", low: 48, lengthTicks: 7680, random: seeded(3) });
  assert.deepEqual([...new Set(notes.map((n) => n.time))], [0, 3840]);
  assert.equal(notes.length, 6);
});

test("MIDI files have a valid header, tempo, and timed notes", () => {
  const bytes = Music.midiFile([
    { time: 0, note: 60, velocity: 1, length: 240 },
    { time: 240, note: 62, velocity: 0.5, length: 240 },
  ], { bpm: 120, channel: 2 });
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), "MThd");
  assert.equal(String.fromCharCode(...bytes.slice(14, 18)), "MTrk");
  assert.equal((bytes[12] << 8) | bytes[13], 960);
  const length = (bytes[18] << 24) | (bytes[19] << 16) | (bytes[20] << 8) | bytes[21];
  assert.equal(bytes.length, 22 + length);
  const track = [...bytes.slice(22)];
  assert.deepEqual(track.slice(0, 7), [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20]); // 500000 microseconds
  assert.deepEqual(track.slice(7, 11), [0, 0x92, 60, 127]);
  // 240 ticks is one byte, and the first note ends as the second starts.
  assert.deepEqual(track.slice(11, 15), [0x81, 0x70, 0x82, 60].slice(0, 4));
  assert.deepEqual(track.slice(-4), [0, 0xff, 0x2f, 0]);
});

test("a pattern's key is detected from its notes", () => {
  const notes = (list) => list.map((note, i) => ({ time: i * 240, note, length: 240 }));
  assert.deepEqual(Music.detectKey(notes([57, 60, 64, 57, 60, 64, 65, 67, 57])), { root: 9, scale: "minor" });
  assert.deepEqual(Music.detectKey(notes([60, 64, 67, 60, 65, 69, 67, 71, 72, 60])), { root: 0, scale: "major" });
  assert.equal(Music.detectKey([]), null);
});
