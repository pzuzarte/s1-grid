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

  return { ALL, BY_CC, SECTIONS, display };
})();

if (typeof module !== "undefined") module.exports = S1Params;
