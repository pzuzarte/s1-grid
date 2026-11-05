# S-1 Grid

**[Open S-1 Grid](https://pzuzarte.github.io/s1-grid/)**

A key-locked pattern grid and sound editor for the Roland AIRA Compact S-1 synthesizer.
It runs in your browser and talks to the S-1 over USB MIDI.

Unofficial and not affiliated with or endorsed by Roland. It doesn't change the S-1's
firmware. Your patterns and sounds stay in your browser.

Visits to the page are counted anonymously with
[GoatCounter](https://www.goatcounter.com/help/privacy), which uses no cookies and
never receives your patterns or patches.

**Requires a current version of Google Chrome or Microsoft Edge.**

## What it does

- **Write in any key:** choose a key and scale, and the grid only shows notes that fit.
  Changing the key can move your patterns with it, keeping each note's place in the scale.
- **Draw notes and chords:** drag to draw any length, or draw power chords, triads and
  7ths built from the key.
- **Pattern ideas:** generate basslines, melodies, arpeggios and chords in the key.
- **Sound control:** every control change in Roland's MIDI chart, 54 in all, grouped into
  tabs. Knobs moved on the S-1 update the page.
- **Saved sounds:** store and recall named sets of values in the browser.
- **16 patterns:** with MIDI file import and export, and octave up and down buttons.
- **Patch library:** keep patches as files in a folder on your computer, pick which ones to
  import from the S-1 or an S-1 backup, and load one to fill the grid, update the controls, and hear it on the S-1,
  including its motions.
- **Play with MPC Grid:** with [MPC Grid](https://pzuzarte.github.io/mpc-grid/) open in the
  same browser, Play, Stop and tempo on either page control both.
- **Save to the S-1:** send patterns and library patches straight to chosen slots among its
  64 patterns, one at a time or as a batch, using its USB backup and restore, with no
  recording. Library names are entirely yours, as the S-1 stores patterns by slot number.

The **Help** button in the page, or the ? key, explains everything.

## Running it yourself

The link above needs nothing installed. The page is plain HTML, CSS and JavaScript, with
nothing to build. To run your own copy, serve the folder from a local web server, as
browsers only allow MIDI on secure pages and localhost:

```bash
python3 -m http.server 8773 --bind 127.0.0.1
```

Then open http://localhost:8773 in Chrome and allow MIDI access.

## Limits

- Library files are copied from your own S-1, and aren't part of this repository. Keep them
  out of it, as factory patterns belong to Roland.
- Settings with no MIDI control, like delay feedback or a drawn wave, can't be heard during
  live playback. They're kept in the file and work once a patch is on the S-1.

- The S-1 can't report its current settings over MIDI. A value shows as ? until you set it
  here or move its knob.
- Patterns play from this page, so it must stay open.
- Save to S-1 uses the S-1's restore feature in a way Roland doesn't document, so keep a
  copy of its BACKUP folder. Saves hold 64 steps, 4 notes per step and values on 1/16 steps,
  and warn you about anything rounded or left out. Motions in the replaced pattern are
  removed, and restore rewrites all 64 patterns from their saved versions.
- Record to S-1 hasn't been confirmed on the hardware.
- The drawn wave's shape, motions, and other settings with no MIDI control can only be
  changed on the S-1.
- Switch values follow the [S-1 Utility](https://github.com/denzlobin/S1Utility) project's
  hardware testing, as Roland doesn't publish them, and haven't all been checked here.

## Tests

Tests need Node.js 21 or later:

```bash
npm test
```
