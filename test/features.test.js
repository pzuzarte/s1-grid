"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const Backup = require("../backup.js");
const Music = require("../music.js");
const S1Params = require("../params.js");

const note = (extra) => ({ time: 0, note: 60, velocity: 1, length: 240, probability: 100, ...extra });

test("sub-steps split a note's first step by the S-1's patterns", () => {
  assert.deepEqual(Music.noteParts(note()), [{ time: 0, length: 240 }]);
  assert.deepEqual(Music.noteParts(note({ substep: 1 })), [{ time: 0, length: 120 }, { time: 120, length: 120 }]);
  // 9 is ooo_, the value found in a real pattern file.
  assert.deepEqual(Music.noteParts(note({ substep: 9 })).map((part) => part.time), [0, 60, 120]);
  assert.deepEqual(Music.noteParts(note({ substep: 6, time: 480 })), [{ time: 560, length: 80 }]);
});

test("a long note with a sub-step holds from its last part", () => {
  const parts = Music.noteParts(note({ substep: 1, length: 480 }));
  assert.deepEqual(parts, [{ time: 0, length: 120 }, { time: 120, length: 360 }]);
});

test("MIDI export writes sub-steps as separate notes", () => {
  const parsed = Music.parseMidi(Music.midiFile([note({ substep: 2 })], { bpm: 120 }));
  assert.deepEqual(parsed.notes.map((item) => [item.time, item.length]), [[0, 80], [80, 80], [160, 80]]);
});

test("scale moves follow the scale, and refuse to leave the MIDI range", () => {
  const moved = Music.shiftInScale([note({ note: 60 }), note({ note: 64 })], 1, 0, "major");
  assert.deepEqual(moved.map((item) => item.note), [62, 65]);
  assert.deepEqual(Music.shiftInScale([note({ note: 60 })], -1, 0, "major").map((item) => item.note), [59]);
  assert.equal(Music.shiftInScale([note({ note: 127 })], 1, 0, "chromatic"), null);
});

test("rotating wraps around the pattern and keeps notes inside it", () => {
  const moved = Music.rotateNotes([note({ time: 3600 }), note({ time: 240, note: 62 })], 240, 3840);
  assert.deepEqual(moved.map((item) => [item.time, item.note]), [[0, 60], [480, 62]]);
  const back = Music.rotateNotes([note({ time: 0 })], -240, 3840);
  assert.equal(back[0].time, 3600);
  assert.equal(Music.rotateNotes([note({ time: 3360, length: 480 })], 240, 3840)[0].length, 240);
});

test("chains accept pattern numbers and refuse anything else", () => {
  assert.deepEqual(Music.parseChain("1 1 2, 16"), [0, 0, 1, 15]);
  assert.deepEqual(Music.parseChain("  "), []);
  assert.equal(Music.parseChain("1 17"), null);
  assert.equal(Music.parseChain("1 two"), null);
});

const validOptions = { scales: Music.SCALES, validatePatch: () => [] };
const fullState = () => ({
  root: 2,
  scale: "minor",
  bpm: 97.5,
  chain: "1 2",
  chainOn: true,
  values: { 74: 40 },
  slots: Array.from({ length: 16 }, (_, index) => ({
    bars: 4, notes: index ? [] : [note({ substep: 3 })], ...(index ? {} : { lanes: { 74: [{ time: 30, value: 10 }] } }),
  })),
  sources: Array.from({ length: 16 }, (_, index) => (index ? null : { name: "Bass", text: "x", motions: [], lanes: {} })),
});

test("a backup restores every pattern, sound and patch", () => {
  const file = JSON.parse(JSON.stringify(Backup.pack(fullState(), new Date(0))));
  assert.equal(file.saved, "1970-01-01T00:00:00.000Z");
  assert.deepEqual(Object.keys(file.sources[0]), ["name", "text"]);
  const back = Backup.unpack(file, validOptions);
  assert.equal(back.bpm, 97.5);
  assert.deepEqual(back.values, { 74: 40 });
  assert.equal(back.slots[0].notes[0].substep, 3);
  assert.deepEqual(back.slots[0].lanes, { 74: [{ time: 30, value: 10 }] });
  assert.equal(back.sources[0].name, "Bass");
  assert.equal(back.chainOn, true);
});

test("a damaged or unrelated backup is refused", () => {
  const damaged = (change) => {
    const file = JSON.parse(JSON.stringify(Backup.pack(fullState())));
    change(file);
    return file;
  };
  assert.throws(() => Backup.unpack({ app: "other" }, validOptions), /isn't an S-1 Grid backup/);
  assert.throws(() => Backup.unpack(null, validOptions), /isn't an S-1 Grid backup/);
  assert.throws(() => Backup.unpack(damaged((f) => { f.version = 99; }), validOptions), /different version/);
  assert.throws(() => Backup.unpack(damaged((f) => { f.slots.pop(); }), validOptions), /16 patterns/);
  assert.throws(() => Backup.unpack(damaged((f) => { f.slots[0].notes[0].note = 500; }), validOptions), /damaged note/);
  assert.throws(() => Backup.unpack(damaged((f) => { f.slots[0].lanes[74][0].value = "x"; }), validOptions), /knob movement/);
  assert.throws(() => Backup.unpack(damaged(() => {}), { ...validOptions, validatePatch: () => ["bad"] }), /damaged patch/);
});

test("vary only nudges known levels that are part of the sound", () => {
  const { changes, unknown } = S1Params.vary({ 74: 100, 76: 64, 14: 3 }, 0.1, () => 1);
  assert.equal(changes[74], 113);
  assert.equal(changes[76], undefined);
  assert.equal(changes[14], undefined);
  assert.ok(unknown > 0);
  assert.equal(S1Params.vary({ 74: 127 }, 0.5, () => 1).changes[74], 127);
  assert.equal(S1Params.vary({ 74: 0 }, 0.5, () => 0).changes[74], 0);
});
