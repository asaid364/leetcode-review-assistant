import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../src/core/errors.js";
import {
  deferTodayTask,
  ensureTodayPlan,
  forecastPlan,
  getReviewProgress,
  localDateKey,
  nextReminderAt,
  pauseReviewPlan,
  recalculateTodayPlan,
  resumeReviewPlan,
  scheduleFsrs,
  shouldSendReviewReminder,
  skipTodayTask,
  submitReviewFeedback,
  updatePlanSettings,
} from "../src/core/scheduler.js";
import { createInitialState } from "../src/core/state.js";

const NOW = "2026-08-10T08:00:00.000Z";

function question(key, overrides = {}) {
  const reviewOverrides = overrides.review ?? {};
  const source = { ...overrides };
  delete source.review;
  return {
    key,
    sourceSite: "leetcode.cn",
    sourceQuestionId: key,
    questionFrontendId: key,
    title: key,
    titleSlug: key.toLowerCase(),
    difficulty: "MEDIUM",
    tags: [],
    sourceAvailability: "available",
    acceptedAt: "2026-01-01T08:00:00.000Z",
    planningBaselineAt: "2026-01-01T08:00:00.000Z",
    review: {
      status: "reviewing",
      isFocus: false,
      mastery: null,
      dueAt: null,
      lastReviewedAt: null,
      consecutiveMissedDays: 0,
      fsrs: null,
      updatedAt: NOW,
      ...reviewOverrides,
    },
    reviewHistory: [],
    note: "",
    ...source,
  };
}

function reviewed(key, dueAt, mastery, extra = {}) {
  return question(key, {
    ...extra,
    review: {
      dueAt,
      mastery,
      lastReviewedAt: "2026-07-01T08:00:00.000Z",
      fsrs: {
        stability: 2.4,
        difficulty: 5,
        reps: 1,
        lapses: 0,
        lastReviewAt: "2026-07-01T08:00:00.000Z",
      },
      ...(extra.review ?? {}),
    },
    reviewHistory: [{ rating: mastery }],
  });
}

function state(questions = []) {
  const value = createInitialState({ now: NOW, deviceId: "device-a" });
  value.questions = Object.fromEntries(questions.map((item) => [item.key, item]));
  return value;
}

test("frozen priority example selects B, A and C before focused first reviews", () => {
  const value = state([
    reviewed("A", "2026-08-08T08:00:00.000Z", "again"),
    reviewed("B", "2026-08-05T08:00:00.000Z", "good", { review: { isFocus: true } }),
    reviewed("C", NOW, "hard"),
    question("D", { review: { isFocus: true } }),
    question("E"),
  ]);
  value.settings.dailyQuestionLimit = 3;
  const planned = ensureTodayPlan(value, { now: NOW });
  assert.deepEqual(planned.plan.today.assignments.map((item) => item.questionKey), ["B", "A", "C"]);
  assert.deepEqual(planned.plan.today.assignments.map((item) => item.priority), [110, 100, 50]);
});

test("only reviewing and currently available questions enter the plan", () => {
  const paused = question("paused", { review: { status: "paused" } });
  const missing = question("missing", { sourceAvailability: "missing" });
  const active = question("active");
  const planned = ensureTodayPlan(state([paused, missing, active]), { now: NOW });
  assert.deepEqual(planned.plan.today.assignments.map((item) => item.questionKey), ["active"]);
});

test("every task has an explainable reason and at most two markers", () => {
  const value = state([
    question("old", { paidOnly: true, difficulty: "HARD", review: { isFocus: true } }),
  ]);
  const task = ensureTodayPlan(value, { now: NOW }).plan.today.assignments[0];
  assert.equal(task.reason.code, "OLD_BACKLOG");
  assert.equal(task.reason.text, "历史旧题待巩固");
  assert.equal(task.reason.markers.length, 2);
});

test("FSRS feedback intervals are deterministic and ordered", () => {
  const intervals = ["again", "hard", "good", "easy"].map(
    (rating) => scheduleFsrs(null, rating, NOW).intervalDays,
  );
  assert.ok(intervals[0] <= intervals[1]);
  assert.ok(intervals[1] < intervals[2]);
  assert.ok(intervals[2] < intervals[3]);
  assert.deepEqual(
    ["again", "hard", "good", "easy"].map((rating) => scheduleFsrs(null, rating, NOW).intervalDays),
    intervals,
  );
  assert.ok(intervals.every((days) => days >= 1 && days <= 365));
});

test("submitting feedback completes one task, updates due date and is idempotent", () => {
  const planned = ensureTodayPlan(state([question("A"), question("B")]), { now: NOW });
  const task = planned.plan.today.assignments[0];
  const first = submitReviewFeedback(planned, {
    taskId: task.id,
    questionKey: task.questionKey,
    rating: "good",
    durationMinutes: 18,
    now: NOW,
  });
  assert.equal(first.duplicate, false);
  assert.equal(first.state.questions.A.review.mastery, "good");
  assert.equal(first.state.questions.A.reviewHistory.length, 1);
  assert.equal(first.state.plan.today.assignments.find((item) => item.id === task.id).status, "completed");
  const duplicate = submitReviewFeedback(first.state, {
    taskId: task.id,
    questionKey: task.questionKey,
    rating: "good",
    durationMinutes: 18,
    now: NOW,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.state.questions.A.reviewHistory.length, 1);
});

test("skipping does not count as completion and fills the freed capacity", () => {
  const value = state([question("A"), question("B"), question("C")]);
  value.settings.dailyQuestionLimit = 2;
  const planned = ensureTodayPlan(value, { now: NOW });
  const task = planned.plan.today.assignments[0];
  const skipped = skipTodayTask(planned, { taskId: task.id, now: NOW });
  assert.equal(skipped.plan.today.assignments.find((item) => item.id === task.id).status, "skipped");
  assert.equal(skipped.plan.today.assignments.filter((item) => item.status === "completed").length, 0);
  assert.equal(skipped.plan.today.assignments.filter((item) => item.status === "pending").length, 2);
  assert.ok(skipped.plan.today.assignments.some((item) => item.questionKey === "C"));
});

test("deferring moves a task to the end and preserves that order after feedback", () => {
  const value = state([question("A"), question("B"), question("C")]);
  value.settings.dailyQuestionLimit = 2;
  const planned = ensureTodayPlan(value, { now: NOW });
  const first = planned.plan.today.assignments[0];
  const second = planned.plan.today.assignments[1];
  const deferred = deferTodayTask(planned, { taskId: first.id, now: NOW });
  assert.deepEqual(
    deferred.plan.today.assignments.filter((item) => item.status === "pending").map((item) => item.questionKey),
    [second.questionKey, first.questionKey],
  );
  const completed = submitReviewFeedback(deferred, {
    taskId: second.id,
    questionKey: second.questionKey,
    rating: "good",
    durationMinutes: 10,
    now: NOW,
  }).state;
  assert.deepEqual(
    completed.plan.today.assignments.filter((item) => item.status === "pending").map((item) => item.questionKey),
    [first.questionKey],
  );
  assert.equal(completed.plan.today.assignments.find((item) => item.questionKey === first.questionKey).deferCount, 1);
});

test("time capacity skips oversized candidates and falls back to one task when all exceed it", () => {
  const value = state([
    question("hard", { difficulty: "HARD", planningBaselineAt: "2025-01-01T08:00:00.000Z" }),
    question("easy", { difficulty: "EASY", planningBaselineAt: "2025-02-01T08:00:00.000Z" }),
  ]);
  value.settings.dailyCapacityMode = "time";
  value.settings.dailyMinutesLimit = 20;
  let planned = ensureTodayPlan(value, { now: NOW });
  assert.deepEqual(planned.plan.today.assignments.map((item) => item.questionKey), ["easy"]);

  value.questions.easy.difficulty = "HARD";
  planned = recalculateTodayPlan({ ...value, plan: { ...value.plan, today: null } }, { now: NOW });
  assert.equal(planned.plan.today.assignments.length, 1);
  assert.equal(planned.plan.today.assignments[0].overTimeCapacity, true);
});

test("crossing a date archives unfinished work and increases missed days once", () => {
  const planned = ensureTodayPlan(state([reviewed("A", NOW, "good")]), { now: NOW });
  const nextDay = "2026-08-11T08:00:00.000Z";
  const rolled = ensureTodayPlan(planned, { now: nextDay });
  assert.equal(rolled.questions.A.review.consecutiveMissedDays, 1);
  assert.equal(rolled.plan.history.length, 1);
  const repeated = ensureTodayPlan(rolled, { now: nextDay });
  assert.equal(repeated.questions.A.review.consecutiveMissedDays, 1);
});

test("pausing and resuming the whole plan shifts future due dates but keeps overdue items due", () => {
  const value = state([
    reviewed("future", "2026-08-15T08:00:00.000Z", "good"),
    reviewed("overdue", "2026-08-09T08:00:00.000Z", "hard"),
  ]);
  const paused = pauseReviewPlan(value, { now: NOW });
  assert.equal(paused.plan.pausedAt, NOW);
  assert.equal(ensureTodayPlan(paused, { now: "2026-08-12T08:00:00.000Z" }).plan.today, null);
  const resumed = resumeReviewPlan(paused, { now: "2026-08-12T08:00:00.000Z" });
  assert.equal(localDateKey(resumed.questions.future.review.dueAt), "2026-08-17");
  assert.equal(localDateKey(resumed.questions.overdue.review.dueAt), "2026-08-12");
  assert.equal(resumed.plan.pausedAt, null);
});

test("same-day plan resume preserves completed capacity", () => {
  const value = state([question("A"), question("B"), question("C")]);
  value.settings.dailyQuestionLimit = 2;
  const planned = ensureTodayPlan(value, { now: NOW });
  const task = planned.plan.today.assignments[0];
  const completed = submitReviewFeedback(planned, {
    taskId: task.id,
    questionKey: task.questionKey,
    rating: "good",
    durationMinutes: 10,
    now: NOW,
  }).state;
  const paused = pauseReviewPlan(completed, { now: NOW });
  const changedWhilePaused = updatePlanSettings(
    paused,
    { dailyQuestionLimit: 2 },
    { now: NOW },
  );
  assert.equal(forecastPlan(changedWhilePaused, { now: NOW, days: 1 })[0].count, 0);
  const resumed = resumeReviewPlan(changedWhilePaused, { now: NOW });
  assert.equal(resumed.plan.today.assignments.filter((item) => item.status === "completed").length, 1);
  assert.equal(resumed.plan.today.assignments.filter((item) => item.status === "pending").length, 1);
});

test("interview goal can pull scoped future tasks into the early window", () => {
  const value = state([
    reviewed("focus", "2026-08-15T08:00:00.000Z", "good", { review: { isFocus: true } }),
    reviewed("normal", "2026-08-15T08:00:00.000Z", "good"),
  ]);
  const updated = updatePlanSettings(value, {
    reviewGoal: "interview",
    interview: {
      date: "2026-08-20T08:00:00.000Z",
      scopeType: "focus",
      capacityConfirmed: true,
    },
  }, { now: NOW });
  assert.deepEqual(updated.plan.today.assignments.map((item) => item.questionKey), ["focus"]);
  assert.equal(updated.plan.today.assignments[0].reason.code, "INTERVIEW_EARLY");
});

test("invalid capacity and interview settings are rejected", () => {
  assert.throws(
    () => updatePlanSettings(state(), { dailyQuestionLimit: 51 }, { now: NOW }),
    (error) => error instanceof AppError && error.code === "INVALID_QUESTION_LIMIT",
  );
  assert.throws(
    () => updatePlanSettings(state(), {
      reviewGoal: "interview",
      interview: { date: "2026-08-12T08:00:00.000Z", scopeType: "focus", capacityConfirmed: true },
    }, { now: NOW }),
    (error) => error instanceof AppError && error.code === "INVALID_INTERVIEW_DATE",
  );
  assert.throws(
    () => updatePlanSettings(state(), {
      reviewGoal: "interview",
      interview: { date: "2026-08-20T08:00:00.000Z", scopeType: "selected", questionKeys: [], capacityConfirmed: true },
    }, { now: NOW }),
    (error) => error instanceof AppError && error.code === "EMPTY_INTERVIEW_SCOPE",
  );
});

test("an expired interview goal returns to daily review with an audit reason", () => {
  const value = state([question("A")]);
  value.settings.reviewGoal = "interview";
  value.settings.interview = {
    date: "2026-08-09T08:00:00.000Z",
    scopeType: "focus",
    scopeValues: [],
    questionKeys: [],
    capacityConfirmed: true,
  };
  const planned = ensureTodayPlan(value, { now: NOW });
  assert.equal(planned.settings.reviewGoal, "daily");
  assert.ok(planned.plan.changes.some((change) => change.reason === "INTERVIEW_ENDED"));
});

test("forecast respects the daily count capacity and records backlog", () => {
  const value = state([question("A"), question("B"), question("C"), question("D")]);
  value.settings.dailyQuestionLimit = 2;
  const forecast = forecastPlan(value, { now: NOW, days: 2 });
  assert.deepEqual(forecast.map((day) => day.count), [2, 2]);
  assert.equal(forecast[0].backlog, 2);
  assert.equal(forecast[0].assignments.length, forecast[0].count);
  assert.ok(forecast[0].assignments.every((assignment) => assignment.status === "future"));
});

test("review progress summarizes completion, streak, due pressure and mastery improvement", () => {
  const improved = reviewed("A", "2026-08-09T08:00:00.000Z", "good", {
    difficulty: "HARD",
    tags: [{ slug: "dp", translatedName: "动态规划" }],
  });
  improved.reviewHistory = [
    { rating: "again", reviewedAt: "2026-08-01T08:00:00.000Z" },
    { rating: "good", reviewedAt: "2026-08-05T08:00:00.000Z" },
  ];
  const upcoming = reviewed("B", "2026-08-12T08:00:00.000Z", "hard", {
    difficulty: "MEDIUM",
    tags: [{ slug: "dp", translatedName: "动态规划" }],
  });
  const value = state([improved, upcoming]);
  value.plan.today = {
    date: localDateKey(NOW),
    assignments: [{ id: "today:A", questionKey: "A", status: "completed" }],
  };
  value.plan.history = [{
    date: "2026-08-09",
    assignments: [{ id: "yesterday:B", questionKey: "B", status: "completed" }],
  }];
  const progress = getReviewProgress(value, NOW);
  assert.equal(progress.today.rate, 100);
  assert.equal(progress.week.rate, 100);
  assert.equal(progress.streak, 2);
  assert.equal(progress.improvedCount, 1);
  assert.deepEqual(progress.due, { overdue: 1, upcoming: 1 });
  assert.equal(progress.mastery.good, 1);
  assert.equal(progress.mastery.hard, 1);
  assert.equal(progress.distributions.tags[0].key, "动态规划");
  assert.ok(progress.calendar.some((day) => day.status === "completed"));
  const todayDetail = progress.calendar.find((day) => day.date === localDateKey(NOW));
  assert.equal(todayDetail.count, todayDetail.assignments.length);
  assert.deepEqual(todayDetail.assignments.map((assignment) => assignment.questionKey), ["A"]);
  const futureDetail = progress.calendar.find((day) => day.status === "future");
  assert.equal(futureDetail.count, futureDetail.assignments.length);
});

test("reminder settings validate time and calculate the next local occurrence", () => {
  const value = updatePlanSettings(state(), {
    reminderEnabled: true,
    reminderTime: "20:30",
  }, { now: NOW });
  assert.equal(value.settings.reminderEnabled, true);
  assert.equal(value.settings.reminderTime, "20:30");
  assert.ok(new Date(nextReminderAt(NOW, "20:30")) > new Date(NOW));
  assert.throws(
    () => updatePlanSettings(state(), { reminderTime: "25:00" }, { now: NOW }),
    (error) => error instanceof AppError && error.code === "INVALID_REMINDER_TIME",
  );
});

test("review reminders stop when the day is complete or the plan is paused", () => {
  const value = state([question("A")]);
  value.settings.reminderEnabled = true;
  const planned = ensureTodayPlan(value, { now: NOW });
  assert.equal(shouldSendReviewReminder(planned, NOW), true);
  const task = planned.plan.today.assignments[0];
  const completed = submitReviewFeedback(planned, {
    taskId: task.id,
    questionKey: task.questionKey,
    rating: "good",
    durationMinutes: 10,
    now: NOW,
  }).state;
  assert.equal(shouldSendReviewReminder(completed, NOW), false);
  assert.equal(shouldSendReviewReminder(pauseReviewPlan(planned, { now: NOW }), NOW), false);
});
