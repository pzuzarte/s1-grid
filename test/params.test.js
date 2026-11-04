"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const S1Params = require("../params.js");

// Every control change in Roland's chart for the S-1, v1.02.
const CHART = [
  1, 3, 5, 10, 11,
  12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  64, 65, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 85, 86, 87,
  89, 90, 91, 92, 93, 102, 103, 104, 105, 106, 107,
];

test("every control change in Roland's chart has a control", () => {
  const ours = S1Params.ALL.map((p) => p.cc).sort((a, b) => a - b);
  assert.deepEqual(ours, [...CHART].sort((a, b) => a - b));
});

test("no control change is listed twice", () => {
  assert.equal(S1Params.BY_CC.size, S1Params.ALL.length);
});

test("values are shown in the control's own units", () => {
  const { BY_CC, display } = S1Params;
  assert.equal(display(BY_CC.get(74), 100), "100");
  assert.equal(display(BY_CC.get(74), undefined), "?");
  assert.equal(display(BY_CC.get(14), 3), "8'");
  assert.equal(display(BY_CC.get(14), 99), "2'");
  assert.equal(display(BY_CC.get(81), 127), "On");
  assert.equal(display(BY_CC.get(81), 0), "Off");
  assert.equal(display(BY_CC.get(85), 76), "+12 st");
  assert.equal(display(BY_CC.get(85), 52), "-12 st");
  assert.equal(display(BY_CC.get(10), 64), "0");
});
