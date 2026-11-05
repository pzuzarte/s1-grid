"use strict";
/* Every control change the S-1 accepts, from Roland's MIDI implementation chart
   (Owner's Manual v1.02). Roland doesn't publish how switches map to values. The
   option values here follow the S-1 Utility project's hardware testing, which uses
   the option's position in the list, and 0 or 127 for on/off. */
const S1Params = (() => {
  const level = (cc, name, help) => ({ cc, name, help, type: "range" });
  const options = (cc, name, list, help) => ({ cc, name, help, type: "select", options: list });
  const toggle = (cc, name, help) => ({ cc, name, help, type: "toggle" });
  const bipolar = (cc, name, span, unit, help) => ({ cc, name, help, type: "bipolar", span, unit });

  const SECTIONS = [
    {
      id: "osc",
      name: "OSC",
      params: [
        options(14, "Range", ["64'", "32'", "16'", "8'", "4'", "2'"], "The oscillator's octave. At 8', notes play at the pitch shown in the grid."),
        level(20, "Saw", "Level of the sawtooth wave."),
        level(19, "Square", "Level of the square wave, or the drawn wave."),
        level(21, "Sub", "Level of the sub-oscillator."),
        options(22, "Sub type", ["-2 oct asym", "-2 oct", "-1 oct"], "The sub-oscillator's waveform."),
        level(23, "Noise", "Level of the noise."),
        options(78, "Noise type", ["Pink", "White"], "The noise colour."),
        level(15, "Pulse width", "Pulse width, or PWM depth when a source is chosen."),
        options(16, "PWM source", ["Envelope", "Manual", "LFO"], "What moves the pulse width."),
        level(13, "LFO to pitch", "How much the LFO moves the pitch."),
        bipolar(76, "Fine tune", 63, "", "Fine pitch, centred at 0."),
        level(18, "Bend range", "Pitch bend range for the oscillator."),
      ],
    },
    {
      id: "filter",
      name: "FILTER",
      params: [
        level(74, "Cutoff", "Where the filter starts cutting high frequencies."),
        level(71, "Resonance", "Emphasis at the cutoff point."),
        level(24, "Envelope", "How much the envelope moves the cutoff."),
        level(25, "LFO", "How much the LFO moves the cutoff."),
        level(26, "Key follow", "How much the cutoff follows the note played."),
        level(27, "Bend range", "Pitch bend range for the filter."),
      ],
    },
    {
      id: "env",
      name: "ENV",
      params: [
        level(73, "Attack", "Time to reach the peak."),
        level(75, "Decay", "Time to fall to the sustain level."),
        level(30, "Sustain", "Level held while a note is on."),
        level(72, "Release", "Time to fade after a note ends."),
        options(28, "Amp mode", ["Gate", "Envelope"], "What shapes the volume."),
        options(29, "Trigger", ["LFO", "Gate", "Gate + trig"], "What starts the envelope."),
      ],
    },
    {
      id: "lfo",
      name: "LFO",
      params: [
        level(3, "Rate", "LFO speed."),
        options(12, "Wave", ["Saw", "Inverted saw", "Triangle", "Square", "Random", "Noise"], "LFO shape."),
        options(79, "Mode", ["Normal", "Fast"], "Normal or extra fast rates."),
        options(106, "Sync", ["Off", "On"], "Sync the LFO to tempo."),
        options(105, "Key trigger", ["Off", "On"], "Restart the LFO on each note."),
        level(17, "Mod depth", "How much the mod wheel adds."),
      ],
    },
    {
      id: "voice",
      name: "VOICE",
      params: [
        options(80, "Polyphony", ["Mono", "Unison", "Poly", "Chord"], "Use Poly to hear chords from the grid."),
        toggle(81, "Chord voice 2", "Used in Chord mode."),
        bipolar(85, "Voice 2 shift", 12, " st", "Semitones from the note played."),
        toggle(82, "Chord voice 3", "Used in Chord mode."),
        bipolar(86, "Voice 3 shift", 12, " st", "Semitones from the note played."),
        toggle(83, "Chord voice 4", "Used in Chord mode."),
        bipolar(87, "Voice 4 shift", 12, " st", "Semitones from the note played."),
        options(31, "Glide mode", ["Off", "On", "Auto"], "Auto only glides between overlapping notes."),
        level(5, "Glide time", "How long the pitch takes to glide."),
        toggle(65, "Glide switch", "Portamento on or off."),
        bipolar(77, "Transpose", 12, " st", "Shifts the S-1's pitch without changing the grid."),
      ],
    },
    {
      id: "fx",
      name: "FX",
      params: [
        level(92, "Delay level", "Volume of the delay."),
        level(90, "Delay time", "Delay time."),
        level(91, "Reverb level", "Volume of the reverb."),
        level(89, "Reverb time", "Reverb length."),
        options(93, "Chorus", ["Off", "Type 1", "Type 2", "Type 3", "Type 4"], "Chorus type."),
      ],
    },
    {
      id: "wave",
      name: "WAVE",
      params: [
        options(107, "Draw", ["Off", "Step", "Slope"], "Use a wave drawn on the S-1 in place of the square."),
        level(102, "Draw multiply", "Repeats the drawn wave."),
        level(103, "Chop overtone", "Emphasises harmonics."),
        level(104, "Chop comb", "Cuts the wave into pieces."),
      ],
    },
    {
      id: "play",
      name: "PLAY",
      params: [
        level(1, "Mod wheel", "Adds LFO modulation."),
        level(11, "Expression", "Overall expression."),
        bipolar(10, "Pan", 63, "", "Left and right, centred at 0."),
        { cc: 64, name: "Hold", help: "Holds notes like a sustain pedal. Isn't stored in saved sounds.", type: "toggle", noSave: true },
      ],
    },
  ];

  const ALL = SECTIONS.flatMap((section) => section.params);
  const BY_CC = new Map(ALL.map((param) => [param.cc, param]));

  // Text for a value, in the units the control uses.
  function display(param, value) {
    if (value === undefined || value === null) return "?";
    if (param.type === "toggle") return value >= 64 ? "On" : "Off";
    if (param.type === "select") return param.options[Math.min(value, param.options.length - 1)];
    if (param.type === "bipolar") {
      const offset = value - 64;
      return `${offset > 0 ? "+" : ""}${offset}${param.unit}`;
    }
    return String(value);
  }

  /* Starting sounds for each kind of pattern idea. Every control has a value, so nothing
     depends on what the S-1 happened to be set to. Switches use their position in the
     option lists above. */
  const NEUTRAL = {
    14: 3, // Range: 8', so notes play at the pitch shown.
    20: 127, 19: 0, 21: 0, 22: 2, 23: 0, 78: 1, 15: 64, 16: 1, 13: 0, 76: 64, 18: 32,
    74: 70, 71: 20, 24: 40, 25: 0, 26: 64, 27: 0,
    73: 0, 75: 50, 30: 70, 72: 25, 28: 1, 29: 2,
    3: 50, 12: 2, 79: 0, 106: 0, 105: 0, 17: 30,
    80: 0, 81: 0, 85: 64, 82: 0, 86: 64, 83: 0, 87: 64, 31: 0, 5: 20, 65: 0, 77: 64,
    92: 0, 90: 40, 91: 0, 89: 40, 93: 0,
    107: 0, 102: 0, 103: 0, 104: 0,
    1: 0, 11: 127, 10: 64, 64: 0,
  };

  const ARPEGGIO = {
    20: 95, 19: 95, 15: 40,
    74: 58, 71: 45, 24: 68,
    75: 28, 30: 12, 72: 22,
    92: 45, 90: 40, 91: 20, 89: 35,
  };

  const STARTING_SOUNDS = {
    // Round and punchy: an octave down, with a sub and a short filter envelope.
    bassline: {
      14: 2, 20: 105, 19: 35, 21: 100,
      74: 42, 71: 28, 24: 62, 26: 40,
      75: 38, 30: 40, 72: 12,
    },
    // Singing and in front, with some space around it.
    melody: {
      20: 127, 19: 30, 21: 20,
      74: 70, 71: 30, 24: 40,
      73: 2, 75: 50, 30: 70, 72: 30,
      92: 40, 90: 53, 91: 30, 89: 50,
    },
    // Short and plucky, so fast notes stay separate.
    arpUp: ARPEGGIO,
    arpUpDown: ARPEGGIO,
    // Soft and wide, with all the notes sounding together.
    chords: {
      80: 2, 20: 127,
      74: 62, 71: 15, 24: 24,
      73: 16, 75: 60, 30: 90, 72: 50,
      92: 15, 90: 60, 91: 50, 89: 70, 93: 2,
    },
  };

  const startingSound = (kind) => ({ ...NEUTRAL, ...STARTING_SOUNDS[kind] });

  /* The S-1 has no sine wave, so this comes as close as it can. A square wave only has odd
     harmonics, the nearest being far above the note, so a low-pass filter just above the
     note leaves mostly its fundamental. Full key follow keeps that true up the keyboard. */
  const sineSound = () => ({
    ...NEUTRAL,
    19: 127, 20: 0, 21: 0, 23: 0, 15: 0, 16: 1,
    74: 48, 71: 0, 24: 0, 25: 0, 26: 127,
    73: 1, 75: 64, 30: 127, 72: 10,
    17: 0,
  });

  // The S-1's delay time in ms with sync off, from S-1 Utility's readings of its display.
  const DELAY_RAW = [0, 11, 26, 55, 106, 179, 245, 255];
  const DELAY_MS = [1, 14, 44, 103, 273, 517, 737, 740];

  function delayMs(cc) {
    const raw = (Math.max(0, Math.min(127, cc)) * 255) / 127;
    const upper = Math.max(1, DELAY_RAW.findIndex((value) => raw <= value));
    const share = (raw - DELAY_RAW[upper - 1]) / (DELAY_RAW[upper] - DELAY_RAW[upper - 1]);
    return Math.round(DELAY_MS[upper - 1] + share * (DELAY_MS[upper] - DELAY_MS[upper - 1]));
  }

  // Left out of Vary: tuning and bend ranges put a sound out of tune, and pan, mod wheel
  // and expression are for performing with rather than part of the sound.
  const NOT_VARIED = new Set([1, 10, 11, 18, 27, 76, 77, 85, 86, 87]);

  // Nudges every known level by up to the given share of its range, and returns the changes.
  function vary(values, amount, random = Math.random) {
    const changes = {};
    let unknown = 0;
    for (const param of ALL) {
      if (!["range", "bipolar"].includes(param.type) || NOT_VARIED.has(param.cc)) continue;
      const value = values[param.cc];
      if (value === undefined) {
        unknown += 1;
        continue;
      }
      changes[param.cc] = Math.max(0, Math.min(127, Math.round(value + (random() * 2 - 1) * amount * 127)));
    }
    return { changes, unknown };
  }

  return { ALL, BY_CC, SECTIONS, STARTING_SOUNDS, delayMs, display, sineSound, startingSound, vary };
})();

if (typeof module !== "undefined") module.exports = S1Params;
