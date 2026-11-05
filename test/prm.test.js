"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const Prm = require("../prm.js");

const onePatternFile = () => {
  const template = makeTemplate();
  return Prm.render(template, {
    notes: [{ time: 240, note: 60, velocity: 1, length: 240, probability: 100, substep: 9 }], bars: 1, bpm: 120,
  });
};

test("sub-steps save to the S-1's file and read back", () => {
  const { text, warnings } = onePatternFile();
  assert.deepEqual(warnings, []);
  assert.match(text, /^STEP_NOTE 2\t= .*SUBSTEP=9 PROB=10$/m);
  assert.match(text, /^STEP_NOTE 1\t= .*SUBSTEP=0 PROB=10$/m);
  assert.equal(Prm.readNotes(text)[0].substep, 9);
  assert.equal(Prm.describe(text).substeps, 1);
});

test("mixed sub-steps in one step warn, as the S-1 has one per step", () => {
  const { warnings } = Prm.render(makeTemplate(), {
    notes: [
      { time: 0, note: 60, velocity: 1, length: 240, substep: 2 },
      { time: 0, note: 64, velocity: 1, length: 240 },
    ],
    bars: 1,
    bpm: 120,
  });
  assert.ok(warnings.some((text) => text.includes("one sub-step per step")));
});

test("drawn knob movements save to the S-1's file and read back", () => {
  const motions = [
    { time: 0, cc: 74, value: 10 },
    { time: 30, cc: 74, value: 20 },
    { time: 270, cc: 71, value: 127 },
  ];
  const { text } = Prm.render(makeTemplate(), { notes: [], bars: 1, bpm: 120, motions });
  assert.equal(Prm.validate(text).length, 0);
  assert.equal(Prm.readSetting(text, "MOTION_CC1"), 74);
  assert.equal(Prm.readSetting(text, "MOTION_CC2"), 71);
  assert.equal(Prm.readSetting(text, "MOTION_CC3"), -1);
  assert.match(text, /^STEP_MOTION 11\t= M1=10 M2=-1 M3=-1 M4=-1 M5=-1 M6=-1 M7=-1 M8=-1 PB=-32768$/m);
  assert.match(text, /^STEP_MOTION 12\t= M1=20 /m);
  assert.match(text, /^STEP_MOTION 22\t= M1=-1 M2=127 /m);
  assert.deepEqual(Prm.readMotions(text), motions.map((item) => ({ ...item })));
  assert.deepEqual(Prm.readLanes(text)[74], [{ time: 0, value: 10 }, { time: 30, value: 20 }]);
});

test("drawn knob movements warn when they don't fit on the S-1", () => {
  const nine = Array.from({ length: 9 }, (_, index) => ({ time: 0, cc: 20 + index, value: 1 }));
  const many = Prm.render(makeTemplate(), { notes: [], bars: 1, bpm: 120, motions: nine });
  assert.ok(many.warnings.some((text) => text.includes("8 knobs")));
  const late = Prm.render(makeTemplate(), { notes: [], bars: 1, bpm: 120, motions: [{ time: 3840, cc: 74, value: 1 }] });
  assert.ok(late.warnings.some((text) => text.includes("past step 16")));
});

test("delay sync and note value save to the file and read back", () => {
  const lines = makeTemplate().split("\n");
  const padding = lines.findIndex((line) => line.startsWith("PADDING"));
  lines[padding] = "TEMPO_SYNC\t= 1";
  lines[padding + 1] = "DELAY_TEMPO\t= 15";
  const start = lines.join("\n");
  assert.deepEqual(Prm.validate(start), []);
  assert.deepEqual(Prm.readDelay(start), { sync: 1, note: 15 });

  const options = { notes: [], bars: 1, bpm: 120 };
  const kept = Prm.render(start, options).text;
  assert.deepEqual(Prm.readDelay(kept), { sync: 1, note: 15 });
  const changed = Prm.render(start, { ...options, delay: { sync: 0, note: 12 } }).text;
  assert.deepEqual(Prm.readDelay(changed), { sync: 0, note: 12 });
  assert.equal(Prm.DELAY_NOTES[12], "1/8");
  const bad = Prm.render(start, { ...options, delay: { sync: 5, note: 16 } }).text;
  assert.deepEqual(Prm.readDelay(bad), { sync: 1, note: 15 });
});

test("a file without these delay settings stays valid when they're given", () => {
  const { text } = Prm.render(makeTemplate(), { notes: [], bars: 1, bpm: 120, delay: { sync: 1, note: 3 } });
  assert.deepEqual(Prm.validate(text), []);
  assert.deepEqual(Prm.readDelay(text), {});
});

test("a suggested patch name avoids names in use, ignoring case", () => {
  assert.equal(Prm.uniqueName("S-1 1-01", []), "S-1 1-01");
  assert.equal(Prm.uniqueName("S-1 1-01", ["s-1 1-01"]), "S-1 1-01 (2)");
  assert.equal(Prm.uniqueName("S-1 1-01", ["S-1 1-01", "S-1 1-01 (2)"]), "S-1 1-01 (3)");
});

function makeTemplate() {
  const lines = ["LENG\t= 16", "TEMPO\t= 10000", "TRANSPOSE\t= 0", "MOTION_CC1\t= 74"];
  for (let slot = 2; slot <= 8; slot += 1) lines.push(`MOTION_CC${slot}\t= -1`);
  const seen = new Set(["TRANSPOSE"]);
  for (const [name] of Object.values(Prm.SETTINGS)) {
    if (!seen.has(name)) lines.push(`${name}\t= 11`);
    seen.add(name);
  }
  lines.push("KEEP_ME\t= 42");
  for (let step = 1; step <= 64; step += 1) {
    lines.push(`STEP_NOTE ${step}\t= NOTE1=-1 VELO1=0 LENG1=0 NOTE2=-1 VELO2=0 LENG2=0 NOTE3=-1 VELO3=0 LENG3=0 NOTE4=-1 VELO4=0 LENG4=0 SUBSTEP=0 PROB=10`);
  }
  for (let step = 1; step <= 64; step += 1) {
    for (let tick = 1; tick <= 8; tick += 1) {
      lines.push(`STEP_MOTION ${step * 10 + tick}\t= M1=${tick} M2=-1 M3=-1 M4=-1 M5=-1 M6=-1 M7=-1 M8=-1 PB=-32768`);
    }
  }
  while (lines.length < 689) lines.splice(4, 0, `PADDING${lines.length}\t= 0`);
  return `${lines.join("\n")}\n`;
}

const TEMPLATE = makeTemplate();
const note = (time, pitch, length = 192, velocity = 1, probability = 100) => ({ time, note: pitch, length, velocity, probability });
const render = (notes, options = {}) => Prm.render(TEMPLATE, { notes, bars: 1, bpm: 120, ...options });

test("the test template is valid", () => {
  assert.deepEqual(Prm.validate(TEMPLATE), []);
});

test("pattern names match the S-1's files", () => {
  assert.equal(Prm.fileName(0), "S1_PTN1-01.PRM");
  assert.equal(Prm.fileName(15), "S1_PTN1-16.PRM");
  assert.equal(Prm.fileName(16), "S1_PTN2-01.PRM");
  assert.equal(Prm.fileName(63), "S1_PTN4-16.PRM");
  assert.equal(Prm.slotLabel(63), "4-16");
});

test("notes land on their steps, with velocity and gate", () => {
  const { text, warnings } = render([note(0, 60), note(480, 64, 120, 0.5)]);
  const steps = Prm.readSteps(text);
  assert.deepEqual(steps[0].voices, [{ note: 60, velocity: 127, gate: 80 }]);
  assert.deepEqual(steps[1].voices, []);
  assert.deepEqual(steps[2].voices, [{ note: 64, velocity: 64, gate: 50 }]);
  assert.deepEqual(warnings, []);
});

test("length, tempo and other settings are written, and unknown lines are kept", () => {
  const { text } = render([], { bars: 2, bpm: 133.5 });
  assert.equal(Prm.readSetting(text, "LENG"), 32);
  assert.equal(Prm.readSetting(text, "TEMPO"), 13350);
  assert.equal(Prm.readSetting(text, "KEEP_ME"), 42);
});

test("a long note ties across steps, as the manual describes", () => {
  const { text } = render([note(0, 60, 600)]);
  const steps = Prm.readSteps(text);
  assert.deepEqual(steps.slice(0, 4).map((s) => s.voices.map((v) => [v.note, v.gate])), [
    [[60, 100]], [[60, 100]], [[60, 50]], [],
  ]);
});

test("a note ending on a step line doesn't spill into the next step", () => {
  const steps = Prm.readSteps(render([note(0, 60, 480)]).text);
  assert.deepEqual(steps.slice(0, 3).map((s) => s.voices.map((v) => v.gate)), [[100], [100], []]);
});

test("separate notes on one pitch stay separate instead of tying", () => {
  const steps = Prm.readSteps(render([note(0, 60, 240), note(240, 60, 240)]).text);
  assert.equal(steps[0].voices[0].gate, 95);
  assert.equal(steps[1].voices[0].gate, 100);
});

test("a long note stops at the end of the pattern", () => {
  const steps = Prm.readSteps(render([note(3600, 60, 2000)]).text);
  assert.equal(steps[15].voices[0].gate, 100);
  assert.equal(steps[16].voices.length, 0);
});

test("chords use one voice each", () => {
  const steps = Prm.readSteps(render([note(0, 60), note(0, 64), note(0, 67)]).text);
  assert.deepEqual(steps[0].voices.map((v) => v.note), [60, 64, 67]);
});

test("more than 4 notes on a step are left out, with a warning", () => {
  const { text, warnings } = render([note(0, 60), note(0, 62), note(0, 64), note(0, 65), note(0, 67)]);
  assert.equal(Prm.readSteps(text)[0].voices.length, 4);
  assert.ok(warnings.some((w) => w.includes("4 notes per step")));
});

test("notes off the grid are rounded, with a warning", () => {
  const { text, warnings } = render([note(160, 60), note(100, 62)]);
  const steps = Prm.readSteps(text);
  assert.deepEqual(steps[1].voices.map((v) => v.note), [60]);
  assert.deepEqual(steps[0].voices.map((v) => v.note), [62]);
  assert.ok(warnings.some((w) => w.includes("rounded")));
});

test("patterns over 64 steps are cut, with a warning", () => {
  const { text, warnings } = Prm.render(TEMPLATE, { notes: [note(0, 60), note(15360, 62)], bars: 8, bpm: 120 });
  assert.equal(Prm.readSetting(text, "LENG"), 64);
  assert.ok(warnings.some((w) => w.includes("64 steps")));
  assert.ok(warnings.some((w) => w.includes("left out")));
});

test("probability is stored per step in tens", () => {
  const steps = Prm.readSteps(render([note(0, 60, 192, 1, 50), note(240, 62, 192, 1, 44)]).text);
  assert.equal(steps[0].probability, 5);
  assert.equal(steps[1].probability, 4);
  assert.equal(steps[2].probability, 10);
  const mixed = render([note(0, 60, 192, 1, 50), note(0, 64, 192, 1, 100)]);
  assert.equal(Prm.readSteps(mixed.text)[0].probability, 10);
  assert.ok(mixed.warnings.some((w) => w.includes("probability")));
});

test("motions from the replaced pattern are cleared", () => {
  const { text } = render([]);
  assert.ok(!/^STEP_MOTION .*M1=[1-8] /m.test(text));
  assert.equal(Prm.readSetting(text, "MOTION_CC1"), -1);
  assert.equal(text.split("\n").length, TEMPLATE.split("\n").length);
});

test("sound settings use each setting's own scale, and unknown ones stay", () => {
  const { text } = render([], {
    values: {
      74: 127, 71: 0, 14: 3, 81: 127, 82: 0, 85: 76, 86: 52, 76: 64, 18: 127, 102: 3, 104: 127, 77: 76, 10: 99, 1: 50,
    },
  });
  const read = (key) => Prm.readSetting(text, key);
  assert.equal(read("VCF_CUTOFF"), 255);
  assert.equal(read("VCF_RESONANCE"), 0);
  assert.equal(read("VCO_RANGE"), 3);
  assert.equal(read("CHORD_VOICE2_SW"), 1);
  assert.equal(read("CHORD_VOICE3_SW"), 0);
  assert.equal(read("CHORD_VOICE2_KEY_SHIFT"), 12);
  assert.equal(read("CHORD_VOICE3_KEY_SHIFT"), -12);
  assert.equal(read("FINE_TUNE"), 128);
  assert.equal(read("VCO_BEND_SENS"), 240);
  assert.equal(read("OSC_DRAW_MULT"), 7);
  assert.equal(read("OSC_CHOP_COMB"), 255);
  assert.equal(read("TRANSPOSE"), 12);
  assert.equal(read("VCO_SAW_LEVEL"), 11); // Unknown, so left as it was.
  assert.ok(!/\bPAN\b/.test(text));
});

test("files that don't match the expected format are refused", () => {
  assert.throws(() => Prm.render("LENG\t= 16\n", { notes: [], bars: 1, bpm: 120 }), /lines/);
  const missing = TEMPLATE.replace(/^VCF_CUTOFF\t= 11\n/m, "PADDINGX\t= 0\n");
  assert.throws(() => Prm.render(missing, { notes: [], bars: 1, bpm: 120 }), /VCF_CUTOFF/);
  const oddBytes = TEMPLATE.replace("KEEP_ME", "KEEPéME");
  assert.throws(() => Prm.render(oddBytes, { notes: [], bars: 1, bpm: 120 }), /characters/);
});

test("note counts come from the first voice of each step", () => {
  assert.equal(Prm.noteCount(TEMPLATE), 0);
  assert.equal(Prm.noteCount(render([note(0, 60), note(240, 62)]).text), 2);
});

test("notes are read back in the grid's format", () => {
  const { text } = render([note(0, 60, 192, 1, 50), note(480, 64, 120, 0.5), note(480, 67, 120, 0.5)]);
  const notes = Prm.readNotes(text);
  assert.deepEqual(notes.map((n) => [n.time, n.note, n.length, n.probability]), [
    [0, 60, 192, 50], [480, 64, 120, 100], [480, 67, 120, 100],
  ]);
  assert.equal(notes[1].velocity, 64 / 127);
});

test("tied steps are read as one long note, and separate notes stay separate", () => {
  const long = Prm.readNotes(render([note(0, 60, 600)]).text);
  assert.deepEqual(long.map((n) => [n.time, n.length]), [[0, 600]]);
  const twice = Prm.readNotes(render([note(0, 60, 240), note(240, 60, 240)]).text);
  assert.deepEqual(twice.map((n) => n.time), [0, 240]);
});

test("steps past the pattern's length aren't read", () => {
  const { text } = render([note(0, 60)], { bars: 2 });
  const short = text.replace(/^LENG\t= \d+/m, "LENG\t= 6").replace(/^STEP_NOTE 10\t= NOTE1=-1 VELO1=0 LENG1=0/m, "STEP_NOTE 10\t= NOTE1=70 VELO1=90 LENG1=50");
  assert.deepEqual(Prm.readNotes(short).map((n) => n.note), [60]);
  assert.equal(Prm.readBars(short), 6 / 16);
});

test("sound values convert to MIDI and back", () => {
  for (const [cc, [name, convert]] of Object.entries(Prm.SETTINGS)) {
    if (["OSC_DRAW_MULT", "OSC_CHOP_COMB"].includes(name)) continue;
    for (const value of [0, 1, 2, 64, 76, 100, 127]) {
      if (name.endsWith("_SW") && ![0, 127].includes(value)) continue;
      const list = /^(LFO_WAVE_FORM|VCO_RANGE|VCO_PWM_SOURCE|VCO_SUB_TYPE)$/.test(name);
      if (list && value > 5) continue;
      assert.equal(convert.toCc(convert(value)), value, `controller ${cc} (${name}) value ${value}`);
    }
  }
});

test("values read from a pattern use MIDI's range", () => {
  const { text } = render([], { values: { 74: 100, 85: 76, 76: 64, 14: 3 } });
  const values = Prm.readValues(text);
  assert.equal(values[74], 100);
  assert.equal(values[85], 76);
  assert.equal(values[76], 64);
  assert.equal(values[14], 3);
  Object.values(values).forEach((value) => assert.ok(value >= 0 && value <= 127));
});

test("tempo and motions are read", () => {
  const { text } = render([], { bpm: 133.5 });
  assert.equal(Prm.readBpm(text), 133.5);
  assert.equal(Prm.describe(text).motions, 0);
  assert.equal(Prm.describe(TEMPLATE).motions, 512);
  assert.equal(Prm.describe(text.replace("SUBSTEP=0", "SUBSTEP=9")).substeps, 1);
  const bend = text.replace(/^STEP_MOTION 11\t.*$/m, "STEP_MOTION 11\t= M1=-1 M2=-1 M3=-1 M4=-1 M5=-1 M6=-1 M7=-1 M8=-1 PB=100");
  assert.equal(Prm.describe(bend).motions, 1);
});

test("motions are read with their controller and time, and can be kept when saving", () => {
  const withMotion = TEMPLATE
    .replace(/^MOTION_CC1\t= -?\d+$/m, "MOTION_CC1\t= 74")
    .replace(/^STEP_MOTION (\d+)\t.*$/gm, "STEP_MOTION $1\t= M1=-1 M2=-1 M3=-1 M4=-1 M5=-1 M6=-1 M7=-1 M8=-1 PB=-32768")
    .replace(/^STEP_MOTION 23\t.*$/m, "STEP_MOTION 23\t= M1=50 M2=-1 M3=-1 M4=-1 M5=-1 M6=-1 M7=-1 M8=-1 PB=-32768");
  assert.deepEqual(Prm.readMotions(withMotion), [{ time: 300, cc: 74, value: 50 }]);
  const kept = Prm.render(withMotion, { notes: [note(0, 60)], bars: 1, bpm: 120, keepMotions: true });
  assert.deepEqual(Prm.readMotions(kept.text), [{ time: 300, cc: 74, value: 50 }]);
  const cleared = Prm.render(withMotion, { notes: [note(0, 60)], bars: 1, bpm: 120 });
  assert.deepEqual(Prm.readMotions(cleared.text), []);
});

// Read-only checks against a real backup, which isn't part of the repository.
const BACKUP = path.join(process.env.HOME || "", "Desktop/s1-backups/BACKUP-2026-11-04");
const realFiles = fs.existsSync(BACKUP) ? fs.readdirSync(BACKUP).filter((n) => n.endsWith(".PRM")) : [];

test("every real pattern file passes validation, and only intended lines change", { skip: !realFiles.length }, () => {
  assert.equal(realFiles.length, 64);
  for (const name of realFiles) {
    const original = fs.readFileSync(path.join(BACKUP, name), "ascii");
    assert.deepEqual(Prm.validate(original), [], name);
    const { text } = Prm.render(original, { notes: [note(0, 60)], bars: 1, bpm: 120, values: { 74: 100 } });
    const before = original.split("\n");
    const after = text.split("\n");
    assert.equal(after.length, before.length);
    after.forEach((line, index) => {
      if (line === before[index]) return;
      assert.match(line, /^(LENG|TEMPO|VCF_CUTOFF|MOTION_CC\d|STEP_NOTE \d+|STEP_MOTION \d+)\t= /, `${name}: ${line}`);
    });
  }
});

test("the settings map only uses keys in real files", { skip: !realFiles.length }, () => {
  const text = fs.readFileSync(path.join(BACKUP, realFiles[0]), "ascii");
  for (const [name] of Object.values(Prm.SETTINGS)) {
    assert.notEqual(Prm.readSetting(text, name), null, name);
  }
});

test("the file proven on the S-1 can be reproduced", { skip: !realFiles.length }, () => {
  const tested = path.join(path.dirname(BACKUP), "RESTORE-test-pattern-4-16", "S1_PTN4-16.PRM");
  if (!fs.existsSync(tested)) return;
  const original = fs.readFileSync(path.join(BACKUP, "S1_PTN4-16.PRM"), "ascii");
  const notes = [60, 62, 64, 65, 67, 69, 71, 72].map((pitch, step) => note(step * 240, pitch, 192, [0, 4, 7].includes(step) ? 1 : 100 / 127));
  [60, 64, 67].forEach((pitch) => notes.push(note(1920 + 0, pitch, 240, 110 / 127)));
  [60, 64, 67, 72].forEach((pitch) => notes.push(note(2880, pitch, 96, 70 / 127)));
  const { text } = Prm.render(original, { notes, bars: 1, bpm: 120, values: { 74: (220 * 127) / 255 } });
  const proven = fs.readFileSync(tested, "ascii");
  const stepsOf = (value) => value.split("\n").filter((line) => line.startsWith("STEP_NOTE"));
  assert.deepEqual(stepsOf(text), stepsOf(proven));
});

test("every real pattern's notes survive being read and written again", { skip: !realFiles.length }, () => {
  const key = (steps) => steps.map((step) => step.voices.map((v) => `${v.note}:${v.gate}`).sort().join(","));
  for (const name of realFiles) {
    const original = fs.readFileSync(path.join(BACKUP, name), "ascii");
    const length = Prm.readSetting(original, "LENG");
    const { text } = Prm.render(original, {
      notes: Prm.readNotes(original), bars: Prm.readBars(original), bpm: Prm.readBpm(original),
    });
    assert.deepEqual(key(Prm.readSteps(text)).slice(0, length), key(Prm.readSteps(original)).slice(0, length), name);
  }
});

test("real patterns' sound values stay in range and round-trip closely", { skip: !realFiles.length }, () => {
  for (const name of realFiles) {
    const original = fs.readFileSync(path.join(BACKUP, name), "ascii");
    const values = Prm.readValues(original);
    Object.values(values).forEach((value) => assert.ok(Number.isInteger(value) && value >= 0 && value <= 127));
    const { text } = Prm.render(original, { notes: [], bars: 1, bpm: 120, values });
    for (const [cc, [key]] of Object.entries(Prm.SETTINGS)) {
      const before = Prm.readSetting(original, key);
      const after = Prm.readSetting(text, key);
      assert.ok(Math.abs(before - after) <= 2, `${name} ${key} (controller ${cc}): ${before} became ${after}`);
    }
  }
});

test("motions in real patterns are read in range and in order", { skip: !realFiles.length }, () => {
  let total = 0;
  for (const name of realFiles) {
    const motions = Prm.readMotions(fs.readFileSync(path.join(BACKUP, name), "ascii"));
    total += motions.length;
    motions.forEach((m, i) => {
      assert.ok(m.value >= 0 && m.value <= 127 && m.cc >= 0 && m.cc <= 127 && m.time >= 0, name);
      if (i) assert.ok(motions[i - 1].time <= m.time, name);
    });
  }
  assert.ok(total > 0);
});
