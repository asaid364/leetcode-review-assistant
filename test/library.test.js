import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../src/core/errors.js";
import {
  queryLibrary,
  updateNewQuestionMode,
  updateQuestionNote,
  updateQuestions,
} from "../src/core/library.js";
import { createInitialState, normalizeState, SCHEMA_VERSION } from "../src/core/state.js";

const NOW = "2026-08-10T08:00:00.000Z";

function question(key, overrides = {}) {
  return {
    key,
    sourceSite: "leetcode.cn",
    sourceQuestionId: key.split(":").at(-1),
    questionFrontendId: key.split(":").at(-1),
    title: `Question ${key}`,
    translatedTitle: null,
    titleSlug: `question-${key.split(":").at(-1)}`,
    difficulty: "MEDIUM",
    tags: [],
    sourceAvailability: "available",
    acceptedAt: "2026-07-01T08:00:00.000Z",
    planningBaselineAt: "2026-07-01T08:00:00.000Z",
    review: {
      status: "pending",
      isFocus: false,
      mastery: null,
      dueAt: null,
      lastReviewedAt: null,
      updatedAt: NOW,
    },
    reviewHistory: [],
    note: "",
    ...overrides,
  };
}

function state() {
  const value = createInitialState({ now: NOW, deviceId: "device-a" });
  value.questions = {
    "leetcode.cn:1": question("leetcode.cn:1", {
      translatedTitle: "两数之和",
      difficulty: "EASY",
      tags: [{ slug: "array", name: "Array", translatedName: "数组" }],
      acceptedAt: "2026-08-01T08:00:00.000Z",
      review: {
        status: "reviewing",
        isFocus: true,
        mastery: "again",
        dueAt: "2026-08-08T08:00:00.000Z",
        lastReviewedAt: "2026-08-01T08:00:00.000Z",
      },
    }),
    "leetcode.cn:2": question("leetcode.cn:2", {
      translatedTitle: "链表相加",
      difficulty: "HARD",
      tags: [{ slug: "linked-list", name: "Linked List", translatedName: "链表" }],
      acceptedAt: null,
      review: {
        status: "paused",
        isFocus: false,
        mastery: "good",
        dueAt: "2026-08-15T08:00:00.000Z",
        lastReviewedAt: "2026-08-05T08:00:00.000Z",
      },
    }),
    "leetcode.cn:20": question("leetcode.cn:20", {
      title: "Valid Parentheses",
      acceptedAt: "2026-07-20T08:00:00.000Z",
    }),
  };
  return value;
}

test("library search matches translated title, source title and displayed number", () => {
  assert.deepEqual(queryLibrary(state(), { search: "两数" }, NOW).items.map((item) => item.key), ["leetcode.cn:1"]);
  assert.deepEqual(queryLibrary(state(), { search: "Parent" }, NOW).items.map((item) => item.key), ["leetcode.cn:20"]);
  assert.deepEqual(queryLibrary(state(), { search: "2" }, NOW).items.map((item) => item.key), ["leetcode.cn:20", "leetcode.cn:2"]);
});

test("library combines participation, mastery, difficulty, tag and overdue filters", () => {
  const result = queryLibrary(state(), {
    participation: "in",
    masteries: ["again"],
    difficulties: ["easy"],
    tags: ["array"],
    overdue: "overdue",
  }, NOW);
  assert.deepEqual(result.items.map((item) => item.key), ["leetcode.cn:1"]);
});

test("library date sorting is stable and keeps missing dates last", () => {
  const result = queryLibrary(state(), {
    sortBy: "acceptedAt",
    sortDirection: "desc",
  }, NOW);
  assert.deepEqual(result.items.map((item) => item.key), [
    "leetcode.cn:1",
    "leetcode.cn:20",
    "leetcode.cn:2",
  ]);
});

test("joining, pausing and resuming a question preserves its remaining interval", () => {
  let value = state();
  value = updateQuestions(value, ["leetcode.cn:20"], { type: "join" }, { now: NOW });
  assert.equal(value.questions["leetcode.cn:20"].review.status, "reviewing");
  value.questions["leetcode.cn:20"].review.dueAt = "2026-08-15T08:00:00.000Z";
  value = updateQuestions(value, ["leetcode.cn:20"], { type: "set_status", status: "paused" }, { now: NOW });
  assert.equal(value.questions["leetcode.cn:20"].review.remainingDaysOnPause, 5);
  value = updateQuestions(value, ["leetcode.cn:20"], { type: "set_status", status: "reviewing" }, { now: "2026-08-20T08:00:00.000Z" });
  const resumedDue = new Date(value.questions["leetcode.cn:20"].review.dueAt);
  assert.deepEqual(
    [resumedDue.getFullYear(), resumedDue.getMonth() + 1, resumedDue.getDate()],
    [2026, 8, 25],
  );
});

test("bulk updates are all-or-nothing when one transition is invalid", () => {
  const value = state();
  assert.throws(
    () => updateQuestions(value, ["leetcode.cn:1", "leetcode.cn:20"], { type: "set_status", status: "paused" }, { now: NOW }),
    (error) => error instanceof AppError && error.code === "INVALID_REVIEW_TRANSITION",
  );
  assert.equal(value.questions["leetcode.cn:1"].review.status, "reviewing");
  assert.equal(value.questions["leetcode.cn:20"].review.status, "pending");
});

test("focus updates and new question mode do not alter unrelated review data", () => {
  let value = state();
  value = updateQuestions(value, ["leetcode.cn:2"], { type: "set_focus", value: true }, { now: NOW });
  value = updateNewQuestionMode(value, "reviewing");
  assert.equal(value.questions["leetcode.cn:2"].review.isFocus, true);
  assert.equal(value.questions["leetcode.cn:2"].review.mastery, "good");
  assert.equal(value.settings.newQuestionMode, "reviewing");
});

test("editing a personal note preserves review state and enforces the length limit", () => {
  const value = state();
  value.questions["leetcode.cn:2"].note = "旧笔记";
  const updated = updateQuestionNote(value, "leetcode.cn:2", "  复盘边界条件  ", { now: NOW });
  assert.equal(updated.questions["leetcode.cn:2"].note, "复盘边界条件");
  assert.equal(updated.questions["leetcode.cn:2"].review.mastery, "good");
  assert.equal(value.questions["leetcode.cn:2"].note, "旧笔记");
  assert.throws(
    () => updateQuestionNote(value, "leetcode.cn:2", "x".repeat(5001), { now: NOW }),
    (error) => error instanceof AppError && error.code === "QUESTION_NOTE_TOO_LONG",
  );
});

test("schema version 1 state migrates review and plan fields without losing data", () => {
  const migrated = normalizeState({
    schemaVersion: 1,
    questions: {
      "leetcode.cn:1": {
        key: "leetcode.cn:1",
        note: "保留笔记",
        review: { status: "reviewing", isFocus: true },
      },
    },
    settings: { newQuestionMode: "reviewing" },
  }, { now: NOW, deviceId: "device-a" });
  assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
  assert.equal(migrated.questions["leetcode.cn:1"].note, "保留笔记");
  assert.equal(migrated.questions["leetcode.cn:1"].review.status, "reviewing");
  assert.equal(migrated.questions["leetcode.cn:1"].review.dueAt, null);
  assert.deepEqual(migrated.plan.history, []);
  assert.equal(migrated.settings.dailyQuestionLimit, 5);
  assert.equal(migrated.settings.reminderEnabled, false);
  assert.equal(migrated.settings.reminderTime, "20:00");
});
