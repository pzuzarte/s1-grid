"use strict";
/* Writes patterns into the S-1's .PRM pattern files, as used by its USB backup and
   restore. Roland doesn't document this format. It's plain text with a fixed layout
   of 689 lines, worked out from the S-1's own files and the S-1 Utility project.

   A new file always starts from the S-1's existing file for that pattern, and only
   the lines that need to change are changed. */
const Prm = (() => {
  const STEP_TICKS = 240;
  const MAX_STEPS = 64;
  const STEP_LINES = 64;
  const MOTION_LINES = 512;
  const EXPECTED_LINES = 689;
  const MOTION_TICKS = STEP_TICKS / 8;
  const MOTION_LANES = 8;
  const MAX_SUB_STEP = 13;
  const VOICES = 4;
  const FULL_GATE = 100;
  // A gate of 100 ties into the same note on the next step, so a separate note
  // that follows on the same pitch needs a slightly shorter gate to retrigger.
  const RETRIGGER_GATE = 95;
  const EMPTY_MOTION = "M1=-1 M2=-1 M3=-1 M4=-1 M5=-1 M6=-1 M7=-1 M8=-1 PB=-32768";

  // Each conversion goes from a MIDI value to the file's value, and back again.
  const clampCc = (value) => Math.max(0, Math.min(127, Math.round(value)));
  const conversion = (toFile, toCc) => Object.assign(toFile, { toCc });
  const scale = (max) => conversion((cc) => Math.round((cc * max) / 127), (value) => clampCc((value * 127) / max));
  const direct = conversion((cc) => cc, clampCc);
  const flag = conversion((cc) => (cc >= 64 ? 1 : 0), (value) => (value ? 127 : 0));
  const signed = conversion((cc) => cc - 64, (value) => clampCc(value + 64));
  const floor7 = conversion(
    (cc) => (cc <= 3 ? 7 : Math.round(7 + ((cc - 3) * 248) / 124)),
    (value) => clampCc(3 + ((value - 7) * 124) / 248));
  const fineTune = conversion(
    (cc) => Math.min(255, Math.max(0, 128 + (cc - 64) * 2)),
    (value) => clampCc(64 + (value - 128) / 2));

  // MIDI controller -> pattern file setting. Controls with no entry, such as pan
  // and mod wheel, aren't stored in a pattern.
  const SETTINGS = {
    3: ["LFO_RATE", scale(255)],
    5: ["PORTAMENTO_TIME", scale(255)],
    12: ["LFO_WAVE_FORM", direct],
    13: ["VCO_MOD_DEPTH", scale(255)],
    14: ["VCO_RANGE", direct],
    15: ["VCO_PULSE_WIDTH", scale(255)],
    16: ["VCO_PWM_SOURCE", direct],
    17: ["LFO_MOD_DEPTH", scale(255)],
    18: ["VCO_BEND_SENS", scale(240)],
    19: ["VCO_PWM_LEVEL", scale(255)],
    20: ["VCO_SAW_LEVEL", scale(255)],
    21: ["VCO_SUB_LEVEL", scale(255)],
    22: ["VCO_SUB_TYPE", direct],
    23: ["VCO_NOISE_LEVEL", scale(255)],
    24: ["VCF_ENV_DEPTH", scale(255)],
    25: ["VCF_MOD_DEPTH", scale(255)],
    26: ["VCF_KEY_FOLLOW", scale(255)],
    27: ["VCF_BEND_SENS", scale(255)],
    28: ["VCA_ENV_MODE", direct],
    29: ["ENV_TRG_MODE", direct],
    30: ["ENV_SUSTAIN", scale(255)],
    31: ["PORTAMENTO_MODE", direct],
    71: ["VCF_RESONANCE", scale(255)],
    72: ["ENV_RELEASE", scale(255)],
    73: ["ENV_ATTACK", scale(255)],
    74: ["VCF_CUTOFF", scale(255)],
    75: ["ENV_DECAY", scale(255)],
    76: ["FINE_TUNE", fineTune],
    77: ["TRANSPOSE", signed],
    78: ["NOISE_MODE", direct],
    79: ["LFO_MODE", direct],
    80: ["ASSIGN_MODE", direct],
    81: ["CHORD_VOICE2_SW", flag],
    82: ["CHORD_VOICE3_SW", flag],
    83: ["CHORD_VOICE4_SW", flag],
    85: ["CHORD_VOICE2_KEY_SHIFT", signed],
    86: ["CHORD_VOICE3_KEY_SHIFT", signed],
    87: ["CHORD_VOICE4_KEY_SHIFT", signed],
    89: ["REVERB_TIME", scale(255)],
    90: ["DELAY_TIME", scale(255)],
    91: ["REVERB_LEVEL", scale(255)],
    92: ["DELAY_LEVEL", scale(255)],
    93: ["CHORUS", direct],
    102: ["OSC_DRAW_MULT", floor7],
    103: ["OSC_CHOP_OVERTONE", scale(255)],
    104: ["OSC_CHOP_COMB", floor7],
    105: ["LFO_KEY_TRIG", direct],
    106: ["LFO_SYNC", direct],
    107: ["OSC_DRAW_SW", direct],
  };

  // Bank 1-4 and pattern 1-16 from a slot of 0-63.
  function fileName(slot) {
    const bank = Math.floor(slot / 16) + 1;
    const pattern = String((slot % 16) + 1).padStart(2, "0");
    return `S1_PTN${bank}-${pattern}.PRM`;
  }

  // A name not yet in use, ignoring case as Mac and Windows folders do.
  function uniqueName(base, taken) {
    const used = new Set([...taken].map((name) => name.toLowerCase()));
    if (!used.has(base.toLowerCase())) return base;
    let count = 2;
    while (used.has(`${base} (${count})`.toLowerCase())) count += 1;
    return `${base} (${count})`;
  }

  function slotLabel(slot) {
    return `${Math.floor(slot / 16) + 1}-${String((slot % 16) + 1).padStart(2, "0")}`;
  }

  /* Refuses anything that doesn't look like the format seen so far, so a change in a
     future firmware can't lead to writing a damaged file. */
  function validate(text) {
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const problems = [];
    if (lines.length !== EXPECTED_LINES) problems.push(`has ${lines.length} lines, not ${EXPECTED_LINES}`);
    const count = (pattern) => lines.filter((line) => pattern.test(line)).length;
    if (count(/^STEP_NOTE \d+\t= /) !== STEP_LINES) problems.push("doesn't have 64 note steps");
    if (count(/^STEP_MOTION \d+\t= /) !== MOTION_LINES) problems.push("doesn't have 512 motion entries");
    for (const key of ["LENG", "TEMPO", ...Object.values(SETTINGS).map(([name]) => name)]) {
      if (count(new RegExp(`^${key}\\t= -?\\d+$`)) !== 1) problems.push(`is missing ${key}`);
    }
    if (/[^\x09\x0a\x20-\x7e]/.test(text)) problems.push("contains unexpected characters");
    return problems;
  }

  function summarise(problems) {
    const shown = problems.slice(0, 2).join(" and ");
    return problems.length > 2 ? `${shown}, among ${problems.length} problems` : shown;
  }

  function noteCount(text) {
    return (text.match(/^STEP_NOTE \d+\t= NOTE1=\d/gm) || []).length;
  }

  /* Turns grid notes into one line per step. Long notes become the same note on each
     step, tied with a gate of 100, as the S-1's manual describes. */
  function buildSteps(notes, stepCount, warnings) {
    const steps = Array.from({ length: MAX_STEPS }, () => []);
    const starts = Array.from({ length: MAX_STEPS }, () => new Set());
    const subSteps = Array.from({ length: MAX_STEPS }, () => new Set());
    const rounded = new Set();
    let past = 0;
    const placed = [];
    for (const item of notes) {
      const step = Math.round(item.time / STEP_TICKS);
      if (item.time % STEP_TICKS !== 0) rounded.add(item.time);
      if (step >= stepCount) {
        past += 1;
        continue;
      }
      placed.push({ ...item, step });
      starts[step].add(item.note);
      subSteps[step].add(item.substep >= 1 && item.substep <= MAX_SUB_STEP ? item.substep : 0);
    }
    if (past) warnings.push(`${past} note(s) past step ${stepCount} were left out.`);
    if (rounded.size) warnings.push(`${rounded.size} note time(s) off the 1/16 grid were rounded, including any triplets or 1/32 notes.`);

    let dropped = 0;
    placed.sort((a, b) => a.step - b.step || a.note - b.note);
    for (const item of placed) {
      const velocity = Math.max(1, Math.min(127, Math.round(item.velocity * 127)));
      const ends = item.step * STEP_TICKS + item.length;
      const lastStep = Math.min(stepCount - 1, Math.ceil(ends / STEP_TICKS) - 1);
      for (let step = item.step; step <= lastStep; step += 1) {
        const remaining = ends - step * STEP_TICKS;
        let gate = Math.max(1, Math.min(FULL_GATE, Math.round((remaining / STEP_TICKS) * FULL_GATE)));
        // Stops a tie into a separate note on the same pitch.
        if (step === lastStep && gate === FULL_GATE && step + 1 < stepCount && starts[step + 1].has(item.note)) {
          gate = RETRIGGER_GATE;
        }
        const voices = steps[step];
        const existing = voices.find((voice) => voice.note === item.note);
        if (existing) {
          existing.gate = Math.max(existing.gate, gate);
          existing.velocity = Math.max(existing.velocity, velocity);
        } else if (voices.length < VOICES) {
          voices.push({ note: item.note, velocity, gate, probability: item.probability ?? 100 });
        } else {
          dropped += 1;
        }
      }
    }
    if (dropped) warnings.push(`The S-1 holds 4 notes per step, so ${dropped} note(s) in crowded steps were left out.`);

    if (subSteps.some((found) => found.size > 1)) {
      warnings.push("The S-1 has one sub-step per step, so steps with mixed values use the first one set.");
    }
    let mixed = 0;
    const lines = steps.map((voices, index) => {
      const parts = [];
      for (let voice = 0; voice < VOICES; voice += 1) {
        const item = voices[voice];
        const number = voice + 1;
        parts.push(item
          ? `NOTE${number}=${item.note} VELO${number}=${item.velocity} LENG${number}=${item.gate}`
          : `NOTE${number}=-1 VELO${number}=0 LENG${number}=0`);
      }
      // Probability belongs to the whole step on the S-1, in steps of 10%.
      const chances = voices.map((voice) => Math.round(voice.probability / 10));
      if (new Set(chances).size > 1) mixed += 1;
      const probability = chances.length ? Math.max(...chances) : 10;
      const subStep = [...subSteps[index]].find(Boolean) || 0;
      return `STEP_NOTE ${index + 1}\t= ${parts.join(" ")} SUBSTEP=${subStep} PROB=${probability}`;
    });
    if (mixed) warnings.push(`The S-1 has one probability per step, so ${mixed} step(s) with mixed values use the highest.`);
    return lines;
  }

  /* Turns drawn knob movements, as {time, cc, value}, into a file's motion rows. Each row
     keeps its pitch bend if the pattern's own motions are being kept. */
  function buildMotions(motions, stepCount, warnings) {
    const lanes = [...new Set(motions.map((item) => item.cc))];
    if (lanes.length > MOTION_LANES) {
      warnings.push(`The S-1 records ${MOTION_LANES} knobs per pattern, so ${lanes.length - MOTION_LANES} were left out.`);
    }
    const kept = lanes.slice(0, MOTION_LANES);
    const rows = new Map();
    let past = 0;
    for (const item of motions) {
      const lane = kept.indexOf(item.cc);
      if (lane < 0) continue;
      const position = Math.round(item.time / MOTION_TICKS);
      const step = Math.floor(position / 8);
      if (step >= stepCount) {
        past += 1;
        continue;
      }
      const id = (step + 1) * 10 + (position % 8) + 1;
      if (!rows.has(id)) rows.set(id, Array(MOTION_LANES).fill(-1));
      rows.get(id)[lane] = Math.max(0, Math.min(127, Math.round(item.value)));
    }
    if (past) warnings.push(`${past} knob movement(s) past step ${stepCount} were left out.`);
    return { lanes: kept, rows };
  }

  /* Returns the new file's text and anything that couldn't transfer exactly. Motions
     are cleared, as they belong to the pattern being replaced, unless they're kept or
     new ones are given. */
  function render(template, {
    notes, bars, bpm, values = {}, keepMotions = false, motions = null, delay = {},
  }) {
    const problems = validate(template);
    if (problems.length) throw new Error(`This pattern file ${summarise(problems)}.`);
    const warnings = [];
    const wanted = bars * 16;
    const stepCount = Math.min(MAX_STEPS, wanted);
    if (wanted > MAX_STEPS) warnings.push(`The S-1 holds 64 steps, so only the first 4 of ${bars} bars can be saved.`);
    const stepLines = buildSteps(notes, stepCount, warnings);

    const changes = new Map([["LENG", stepCount], ["TEMPO", Math.round(bpm * 100)]]);
    for (const [cc, value] of Object.entries(values)) {
      const setting = SETTINGS[cc];
      if (setting && value !== undefined && value !== null) changes.set(setting[0], setting[1](value));
    }
    if (delay.sync === 0 || delay.sync === 1) changes.set("TEMPO_SYNC", delay.sync);
    const drawn = motions ? buildMotions(motions, stepCount, warnings) : null;
    if (!keepMotions || drawn) {
      for (let slot = 1; slot <= MOTION_LANES; slot += 1) {
        changes.set(`MOTION_CC${slot}`, drawn && drawn.lanes[slot - 1] !== undefined ? drawn.lanes[slot - 1] : -1);
      }
    }

    const lines = template.split("\n").map((line) => {
      const step = /^STEP_NOTE (\d+)\t/.exec(line);
      if (step) return stepLines[Number(step[1]) - 1];
      const motion = /^STEP_MOTION (\d+)\t/.exec(line);
      if (motion && drawn) {
        const bend = keepMotions ? /PB=(-?\d+)/.exec(line)[1] : "-32768";
        const row = drawn.rows.get(Number(motion[1])) || Array(MOTION_LANES).fill(-1);
        return `STEP_MOTION ${motion[1]}\t= ${row.map((value, index) => `M${index + 1}=${value}`).join(" ")} PB=${bend}`;
      }
      if (motion) return keepMotions ? line : `STEP_MOTION ${motion[1]}\t= ${EMPTY_MOTION}`;
      const key = line.split("\t", 1)[0];
      return changes.has(key) ? `${key}\t= ${changes.get(key)}` : line;
    });
    const text = lines.join("\n");
    const after = validate(text);
    if (after.length) throw new Error(`The new pattern file ${summarise(after)}.`);
    return { text, warnings };
  }

  // Reads notes back, to check what was written.
  function readSteps(text) {
    const steps = [];
    for (const [, number, body] of text.matchAll(/^STEP_NOTE (\d+)\t= (.*)$/gm)) {
      const voices = [];
      for (let voice = 1; voice <= VOICES; voice += 1) {
        const field = (name) => Number(new RegExp(`${name}${voice}=(-?\\d+)`).exec(body)[1]);
        if (field("NOTE") >= 0) voices.push({ note: field("NOTE"), velocity: field("VELO"), gate: field("LENG") });
      }
      const subStep = /SUBSTEP=(\d+)/.exec(body);
      steps[Number(number) - 1] = {
        voices, probability: Number(/PROB=(\d+)/.exec(body)[1]), subStep: subStep ? Number(subStep[1]) : 0,
      };
    }
    return steps;
  }

  function readSetting(text, key) {
    const match = new RegExp(`^${key}\\t= (-?\\d+)$`, "m").exec(text);
    return match ? Number(match[1]) : null;
  }

  /* Reads a pattern's notes in the grid's own format. A gate of 100 followed by the
     same note on the next step is a tie, so those steps become one long note. */
  function readNotes(text) {
    const steps = readSteps(text);
    const stepCount = Math.min(MAX_STEPS, readSetting(text, "LENG") || MAX_STEPS);
    const notes = [];
    const open = new Map();
    for (let index = 0; index < stepCount; index += 1) {
      const step = steps[index];
      const time = index * STEP_TICKS;
      const probability = step.probability * 10;
      for (const voice of step.voices) {
        const running = open.get(voice.note);
        const length = Math.max(1, Math.round((voice.gate / FULL_GATE) * STEP_TICKS));
        if (running && running.end === time) {
          running.item.length += length;
          running.end = time + STEP_TICKS;
          running.tying = voice.gate === FULL_GATE;
          if (!running.tying) open.delete(voice.note);
          continue;
        }
        const item = { time, note: voice.note, velocity: voice.velocity / 127, length, probability };
        if (step.subStep) item.substep = step.subStep;
        notes.push(item);
        if (voice.gate === FULL_GATE) open.set(voice.note, { item, end: time + STEP_TICKS, tying: true });
      }
    }
    return notes;
  }

  // Whether the delay follows the tempo, which has no MIDI control and only exists in the file.
  function readDelay(text) {
    const sync = readSetting(text, "TEMPO_SYNC");
    return sync === 0 || sync === 1 ? { sync } : {};
  }

  // Sound settings as MIDI values, for sending to the S-1 and showing on the page.
  function readValues(text) {
    const values = {};
    for (const [cc, [key, convert]] of Object.entries(SETTINGS)) {
      const value = readSetting(text, key);
      if (value !== null) values[cc] = convert.toCc(value);
    }
    return values;
  }

  /* Recorded knob movements, as {time, cc, value} with 8 points per step. Values are
     already on MIDI's scale. Parameters with no MIDI control, like pitch bend, aren't
     included. */
  function readMotions(text) {
    const controllers = {};
    for (const [, slot, cc] of text.matchAll(/^MOTION_CC(\d)\t= (-?\d+)$/gm)) {
      if (Number(cc) >= 0) controllers[slot] = Number(cc);
    }
    const motions = [];
    for (const [, id, body] of text.matchAll(/^STEP_MOTION (\d+)\t= (.*)$/gm)) {
      const step = Math.floor(Number(id) / 10) - 1;
      const tick = (Number(id) % 10) - 1;
      for (const [, slot, value] of body.matchAll(/M(\d)=(-?\d+)/g)) {
        if (Number(value) >= 0 && controllers[slot] !== undefined) {
          motions.push({
            time: step * STEP_TICKS + (tick * STEP_TICKS) / 8,
            cc: controllers[slot],
            value: Math.min(127, Number(value)),
          });
        }
      }
    }
    return motions.sort((a, b) => a.time - b.time);
  }

  // The same movements, grouped by controller as the grid keeps them.
  function readLanes(text) {
    const lanes = {};
    for (const { time, cc, value } of readMotions(text)) (lanes[cc] ??= []).push({ time, value });
    return lanes;
  }

  function readBpm(text) {
    return (readSetting(text, "TEMPO") || 12000) / 100;
  }

  function readBars(text) {
    return (readSetting(text, "LENG") || 16) / 16;
  }

  // What's in a pattern that the grid can't show or edit.
  function describe(text) {
    const motions = (text.match(/^STEP_MOTION \d+\t= .*(M[1-8]=(?!-1\b)\d|PB=(?!-32768\b)-?\d)/gm) || []).length;
    const substeps = (text.match(/^STEP_NOTE \d+\t= .*SUBSTEP=[1-9]/gm) || []).length;
    return { notes: noteCount(text), motions, substeps };
  }

  return {
    MAX_STEPS,
    SETTINGS,
    describe,
    fileName,
    noteCount,
    readBars,
    readBpm,
    readDelay,
    readLanes,
    readMotions,
    readNotes,
    readSetting,
    readSteps,
    readValues,
    render,
    slotLabel,
    uniqueName,
    validate,
  };
})();

if (typeof module !== "undefined") module.exports = Prm;
