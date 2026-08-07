import assert from "node:assert/strict";
import test from "node:test";

import { queryLibrary } from "../src/core/library.js";
import { ensureTodayPlan } from "../src/core/scheduler.js";
import { createInitialState, normalizeState } from "../src/core/state.js";

const NOW = "2026-08-04T08:00:00.000Z";

function question(index, overrides = {}) {
  const key = "leetcode.cn:" + index;
  return {
    key,
    sourceQuestionId: String(index),
    questionFrontendId: String(index),
    title: "Question " + index,
    translatedTitle: "题目 " + index,
    titleSlug: "question-" + index,
    difficulty: index % 3 === 0 ? "HARD" : index % 2 === 0 ? "MEDIUM" : "EASY",
    tags: [],
    sourceAvailability: "available",
    review: {
      status: "reviewing",
      mastery: null,
      dueAt: null,
      isFocus: false,
      updatedAt: NOW,
    },
    reviewHistory: [],
    note: "",
    ...overrides,
  };
}

test("empty data produces an actionable empty plan instead of an error", () => {
  const state = ensureTodayPlan(createInitialState({ now: NOW, deviceId: "device-a" }), { now: NOW });
  assert.equal(state.plan.today.assignments.length, 0);
  assert.equal(queryLibrary(state).total, 0);
});

test("large local libraries remain paginated and daily capacity stays bounded", () => {
  const state = createInitialState({ now: NOW, deviceId: "device-a" });
  state.settings.dailyQuestionLimit = 7;
  for (let index = 1; index <= 5000; index += 1) {
    state.questions["leetcode.cn:" + index] = question(index);
  }

  const page = queryLibrary(state, { page: 50, pageSize: 100, sortBy: "acceptedAt" }, NOW);
  assert.equal(page.total, 5000);
  assert.equal(page.items.length, 100);
  const planned = ensureTodayPlan(state, { now: NOW });
  assert.equal(planned.plan.today.assignments.length, 7);
});

test("missing optional metadata does not block library management", () => {
  const state = createInitialState({ now: NOW, deviceId: "device-a" });
  state.questions["leetcode.cn:1"] = question(1, {
    translatedTitle: null,
    difficulty: "UNKNOWN",
    tags: null,
    acceptedAt: null,
  });
  const result = queryLibrary(state, { search: "Question 1" }, NOW);
  assert.equal(result.total, 1);
  assert.equal(result.items[0].acceptedAt, null);
});

test("normalization caps histories while preserving current questions and notes", () => {
  const stored = createInitialState({ now: NOW, deviceId: "device-a" });
  stored.plan.history = Array.from({ length: 120 }, (_, index) => ({ date: "day-" + index }));
  stored.plan.changes = Array.from({ length: 140 }, (_, index) => ({ id: index }));
  stored.sync.history = Array.from({ length: 80 }, (_, index) => ({ id: index }));
  stored.questions["leetcode.cn:1"] = question(1, { note: "keep" });

  const normalized = normalizeState(stored, { now: NOW, deviceId: "device-a" });
  assert.equal(normalized.plan.history.length, 90);
  assert.equal(normalized.plan.changes.length, 100);
  assert.equal(normalized.sync.history.length, 50);
  assert.equal(normalized.questions["leetcode.cn:1"].note, "keep");
});
