import { AppError } from "./errors.js";

export const SCHEDULER_VERSION = "fsrs-4.5-compatible-v1";
export const FSRS_PARAMETERS = Object.freeze({
  requestRetention: 0.9,
  maximumIntervalDays: 365,
  minimumIntervalDays: 1,
  weights: Object.freeze([
    0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94,
    2.18, 0.05, 0.34, 1.26, 0.29, 2.61,
  ]),
});

const DAY_MS = 86_400_000;
const VALID_RATINGS = new Set(["again", "hard", "good", "easy"]);
const RATING_VALUE = { again: 1, hard: 2, good: 3, easy: 4 };
const DEFAULT_MINUTES = { EASY: 15, MEDIUM: 25, HARD: 40, UNKNOWN: 25 };
const VALID_GOALS = new Set(["daily", "weak", "interview"]);

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function localDayStart(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new AppError("INVALID_DATE", "日期格式无效", { value });
  }
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function localDateKey(value) {
  const date = localDayStart(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(value, days) {
  const date = localDayStart(value);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function dayDifference(from, to) {
  return Math.round((localDayStart(to) - localDayStart(from)) / DAY_MS);
}

function isSameOrBefore(left, right) {
  return localDayStart(left) <= localDayStart(right);
}

function appendChange(plan, change) {
  return {
    ...plan,
    changes: [change, ...(plan.changes ?? [])].slice(0, 100),
  };
}

function masteryScore(mastery) {
  return { again: 80, hard: 50, good: 20, easy: 0 }[mastery] ?? 35;
}

function difficultyRank(difficulty) {
  return { HARD: 0, MEDIUM: 1, EASY: 2, UNKNOWN: 3 }[difficulty] ?? 3;
}

function effectiveGoal(settings, now) {
  if (settings.reviewGoal !== "interview") {
    return settings.reviewGoal ?? "daily";
  }
  const interviewDate = settings.interview?.date;
  return interviewDate && dayDifference(now, interviewDate) >= 0
    ? "interview"
    : "daily";
}

function isInterviewScope(question, interview) {
  switch (interview?.scopeType) {
    case "focus":
      return Boolean(question.review?.isFocus);
    case "tag": {
      const values = new Set(interview.scopeValues ?? []);
      return (question.tags ?? []).some((tag) =>
        [tag.slug, tag.name, tag.translatedName].some((value) => values.has(value)),
      );
    }
    case "difficulty":
      return (interview.scopeValues ?? []).includes(question.difficulty);
    case "selected":
      return (interview.questionKeys ?? []).includes(question.key);
    default:
      return false;
  }
}

function candidateType(question, settings, now) {
  const review = question.review ?? {};
  const hasReview = Boolean(review.fsrs) || (question.reviewHistory ?? []).length > 0;
  if (!hasReview) {
    return "first";
  }
  if (review.dueAt && isSameOrBefore(review.dueAt, now)) {
    return "due";
  }
  if (
    effectiveGoal(settings, now) === "interview" &&
    review.dueAt &&
    isInterviewScope(question, settings.interview)
  ) {
    const remaining = dayDifference(now, settings.interview.date);
    const earlyWindow = Math.min(7, Math.max(0, remaining));
    const untilDue = dayDifference(now, review.dueAt);
    if (untilDue > 0 && untilDue <= earlyWindow) {
      return "interview_early";
    }
  }
  return null;
}

function eligibleQuestions(state, now, excludedKeys = new Set()) {
  if (state.plan?.pausedAt) {
    return [];
  }
  return Object.values(state.questions ?? {}).filter((question) => {
    if (excludedKeys.has(question.key)) return false;
    if (question.review?.status !== "reviewing") return false;
    if (
      question.sourceAvailability !== "available" &&
      !question.review?.allowUnavailable
    ) {
      return false;
    }
    return Boolean(candidateType(question, state.settings, now));
  });
}

function overdueDays(question, now) {
  if (!question.review?.dueAt) return 0;
  return Math.max(0, dayDifference(question.review.dueAt, now));
}

export function calculatePriority(question, settings, now) {
  const review = question.review ?? {};
  let score =
    Math.min(overdueDays(question, now), 30) * 10 +
    masteryScore(review.mastery) +
    (review.isFocus ? 40 : 0) +
    Math.min(review.consecutiveMissedDays ?? 0, 5) * 10;
  const goal = effectiveGoal(settings, now);
  if (goal === "weak") {
    score += review.mastery === "again" ? 60 : review.mastery === "hard" ? 30 : 0;
  }
  if (goal === "interview" && isInterviewScope(question, settings.interview)) {
    score += 80;
  }
  return score;
}

function compareDue(left, right, settings, now) {
  return (
    calculatePriority(right, settings, now) - calculatePriority(left, settings, now) ||
    new Date(left.review.dueAt).valueOf() - new Date(right.review.dueAt).valueOf() ||
    new Date(left.review.lastReviewedAt ?? 0).valueOf() -
      new Date(right.review.lastReviewedAt ?? 0).valueOf() ||
    left.key.localeCompare(right.key)
  );
}

function compareFirst(left, right) {
  return (
    Number(Boolean(right.review?.isFocus)) - Number(Boolean(left.review?.isFocus)) ||
    new Date(left.planningBaselineAt ?? left.firstSyncedAt ?? 0).valueOf() -
      new Date(right.planningBaselineAt ?? right.firstSyncedAt ?? 0).valueOf() ||
    difficultyRank(left.difficulty) - difficultyRank(right.difficulty) ||
    left.key.localeCompare(right.key)
  );
}

function orderedCandidates(state, now, excludedKeys) {
  const due = [];
  const first = [];
  for (const question of eligibleQuestions(state, now, excludedKeys)) {
    const type = candidateType(question, state.settings, now);
    if (type === "first") first.push(question);
    else due.push(question);
  }
  due.sort((left, right) => compareDue(left, right, state.settings, now));
  first.sort(compareFirst);

  if (effectiveGoal(state.settings, now) === "weak" && due.length > 0) {
    const capacity = state.settings.dailyCapacityMode === "count"
      ? state.settings.dailyQuestionLimit
      : 20;
    return [...due, ...first.slice(0, Math.max(1, Math.floor(capacity * 0.2)))];
  }
  return [...due, ...first];
}

function validDurationsForDifficulty(state, difficulty) {
  return Object.values(state.questions ?? {})
    .filter((question) => question.difficulty === difficulty)
    .flatMap((question) => question.reviewHistory ?? [])
    .filter((record) => record.valid !== false)
    .map((record) => Number(record.durationMinutes))
    .filter((minutes) => minutes >= 3 && minutes <= 120)
    .slice(-10)
    .sort((left, right) => left - right);
}

export function estimateMinutes(state, question) {
  const durations = validDurationsForDifficulty(state, question.difficulty);
  if (durations.length < 3) {
    return DEFAULT_MINUTES[question.difficulty] ?? DEFAULT_MINUTES.UNKNOWN;
  }
  const middle = Math.floor(durations.length / 2);
  return durations.length % 2
    ? durations[middle]
    : Math.round((durations[middle - 1] + durations[middle]) / 2);
}

export function recommendationFor(question, settings, now) {
  const review = question.review ?? {};
  const overdue = overdueDays(question, now);
  const firstReview = !review.fsrs && (question.reviewHistory ?? []).length === 0;
  const baselineAge = question.planningBaselineAt
    ? dayDifference(question.planningBaselineAt, now)
    : 0;
  let code;
  let text;
  if (review.mastery === "again") [code, text] = ["LAST_AGAIN", "上次没有掌握"];
  else if (review.mastery === "hard") [code, text] = ["LAST_HARD", "上次掌握较模糊"];
  else if (overdue > 0) [code, text] = ["OVERDUE", `已逾期 ${overdue} 天`];
  else if (firstReview && baselineAge >= 30) [code, text] = ["OLD_BACKLOG", "历史旧题待巩固"];
  else if (firstReview) [code, text] = ["FIRST_REVIEW", "首次复习"];
  else if (review.resumedAt && review.resumedAt > (review.lastReviewedAt ?? "")) {
    [code, text] = ["RESUMED", "恢复复习"];
  } else if (candidateType(question, settings, now) === "interview_early") {
    [code, text] = ["INTERVIEW_EARLY", "面试计划提前复习"];
  } else [code, text] = ["DUE_TODAY", "今天到期"];

  const markers = [];
  if (review.isFocus) markers.push({ code: "FOCUS", text: "重点题" });
  if (question.difficulty === "HARD") {
    markers.push({ code: "HARD_DIFFICULTY", text: "困难题" });
  }
  if (!question.acceptedAt) {
    markers.push({ code: "TIME_UNKNOWN", text: "历史完成时间未获取" });
  }
  if (question.paidOnly) markers.push({ code: "PAID_LIMITED", text: "访问可能受限" });
  return { code, text, markers: markers.slice(0, 2) };
}

function createAssignment(state, question, now, index) {
  const reason = recommendationFor(question, state.settings, now);
  return {
    id: `${localDateKey(now)}:${question.key}`,
    questionKey: question.key,
    status: "pending",
    assignedAt: now,
    order: index,
    priority: calculatePriority(question, state.settings, now),
    reason,
    estimatedMinutes: estimateMinutes(state, question),
    overTimeCapacity: false,
  };
}

function selectAssignments(state, candidates, now, capacityUsed, completedCount = 0) {
  if (state.settings.dailyCapacityMode === "time") {
    const limit = state.settings.dailyMinutesLimit;
    let used = capacityUsed;
    const selected = [];
    for (const question of candidates) {
      if (selected.length >= Math.max(0, 20 - completedCount)) break;
      const estimate = estimateMinutes(state, question);
      if (used + estimate <= limit) {
        selected.push(question);
        used += estimate;
      }
    }
    if (selected.length === 0 && candidates.length > 0 && capacityUsed === 0) {
      selected.push(candidates[0]);
    }
    return selected;
  }
  return candidates.slice(0, Math.max(0, state.settings.dailyQuestionLimit - capacityUsed));
}

function archiveToday(state, now, reason) {
  const today = state.plan?.today;
  if (!today || today.date === localDateKey(now)) {
    return state;
  }
  const missedKeys = new Set(
    today.assignments
      .filter((assignment) => ["pending", "skipped"].includes(assignment.status))
      .map((assignment) => assignment.questionKey),
  );
  const questions = { ...state.questions };
  for (const key of missedKeys) {
    const question = questions[key];
    if (!question) continue;
    questions[key] = {
      ...question,
      review: {
        ...question.review,
        consecutiveMissedDays: (question.review?.consecutiveMissedDays ?? 0) + 1,
      },
    };
  }
  return {
    ...state,
    questions,
    plan: {
      ...state.plan,
      today: null,
      history: [
        { ...today, closedAt: now, closeReason: reason },
        ...(state.plan.history ?? []),
      ].slice(0, 90),
    },
  };
}

function completedCapacity(assignments, mode) {
  const completed = assignments.filter((assignment) => assignment.status === "completed");
  return mode === "time"
    ? completed.reduce(
        (sum, assignment) =>
          sum + (assignment.actualMinutes ?? assignment.estimatedMinutes ?? 0),
        0,
      )
    : completed.length;
}

export function recalculateTodayPlan(state, { now, reason = "PLAN_RECALCULATED" }) {
  let next = archiveToday(state, now, "DATE_CHANGED");
  if (
    next.settings.reviewGoal === "interview" &&
    next.settings.interview?.date &&
    dayDifference(now, next.settings.interview.date) < 0
  ) {
    next = {
      ...next,
      settings: { ...next.settings, reviewGoal: "daily" },
      plan: appendChange(next.plan, {
        id: `${now}:INTERVIEW_ENDED`,
        at: now,
        reason: "INTERVIEW_ENDED",
        details: { interviewDate: next.settings.interview.date },
      }),
    };
  }
  const date = localDateKey(now);
  if (next.plan?.pausedAt) {
    return {
      ...next,
      plan: appendChange(
        { ...next.plan },
        { id: `${now}:${reason}`, at: now, reason, details: { paused: true } },
      ),
    };
  }

  const previous = next.plan?.today?.date === date ? next.plan.today : null;
  const retained = (previous?.assignments ?? []).filter((assignment) =>
    ["completed", "skipped"].includes(assignment.status),
  );
  const excludedKeys = new Set(retained.map((assignment) => assignment.questionKey));
  const capacityUsed = completedCapacity(retained, next.settings.dailyCapacityMode);
  const completedCount = retained.filter((assignment) => assignment.status === "completed").length;
  const ordered = orderedCandidates(next, now, excludedKeys);
  const candidatesByKey = new Map(ordered.map((question) => [question.key, question]));
  const previousPending = (previous?.assignments ?? [])
    .filter((assignment) => assignment.status === "pending")
    .map((assignment) => candidatesByKey.get(assignment.questionKey))
    .filter(Boolean);
  const previousPendingKeys = new Set(previousPending.map((question) => question.key));
  const candidates = [
    ...previousPending,
    ...ordered.filter((question) => !previousPendingKeys.has(question.key)),
  ];
  const selected = selectAssignments(next, candidates, now, capacityUsed, completedCount);
  const previousAssignments = new Map(
    (previous?.assignments ?? []).map((assignment) => [assignment.questionKey, assignment]),
  );
  const pending = selected.map((question, index) => {
    const created = createAssignment(next, question, now, retained.length + index);
    const prior = previousAssignments.get(question.key);
    return prior?.status === "pending"
      ? {
          ...created,
          id: prior.id,
          assignedAt: prior.assignedAt,
          deferredAt: prior.deferredAt ?? null,
          deferCount: prior.deferCount ?? 0,
        }
      : created;
  });
  if (
    next.settings.dailyCapacityMode === "time" &&
    capacityUsed === 0 &&
    pending.length === 1 &&
    pending[0].estimatedMinutes > next.settings.dailyMinutesLimit
  ) {
    pending[0].overTimeCapacity = true;
  }
  const assignments = [...retained, ...pending];
  const today = {
    id: date,
    date,
    generatedAt: previous?.generatedAt ?? now,
    revisedAt: now,
    revisionReason: reason,
    capacityMode: next.settings.dailyCapacityMode,
    capacityValue:
      next.settings.dailyCapacityMode === "time"
        ? next.settings.dailyMinutesLimit
        : next.settings.dailyQuestionLimit,
    assignments,
  };
  return {
    ...next,
    plan: appendChange(
      { ...next.plan, today },
      {
        id: `${now}:${reason}`,
        at: now,
        reason,
        details: { taskCount: pending.length, retainedCount: retained.length },
      },
    ),
  };
}

export function ensureTodayPlan(state, { now }) {
  const currentDate = localDateKey(now);
  if (state.plan?.pausedAt) return archiveToday(state, now, "DATE_CHANGED");
  if (state.plan?.today?.date === currentDate) return state;
  return recalculateTodayPlan(state, { now, reason: "DAILY_PLAN_GENERATED" });
}

function retrievability(fsrs, now) {
  if (!fsrs?.stability || !fsrs.lastReviewAt) return 0;
  const elapsed = Math.max(0, dayDifference(fsrs.lastReviewAt, now));
  return Math.pow(1 + (19 / 81) * (elapsed / fsrs.stability), -0.5);
}

function initialDifficulty(rating) {
  const w = FSRS_PARAMETERS.weights;
  return clamp(w[4] - Math.exp(w[5] * (rating - 1)) + 1, 1, 10);
}

function nextDifficulty(difficulty, rating) {
  const w = FSRS_PARAMETERS.weights;
  const adjusted = difficulty - w[6] * (rating - 3);
  const reverted = w[7] * initialDifficulty(4) + (1 - w[7]) * adjusted;
  return clamp(reverted, 1, 10);
}

function nextStability(fsrs, rating, now) {
  const w = FSRS_PARAMETERS.weights;
  const r = retrievability(fsrs, now);
  if (rating === 1) {
    return Math.max(
      0.1,
      w[11] *
        Math.pow(fsrs.difficulty, -w[12]) *
        (Math.pow(fsrs.stability + 1, w[13]) - 1) *
        Math.exp((1 - r) * w[14]),
    );
  }
  const hardPenalty = rating === 2 ? w[15] : 1;
  const easyBonus = rating === 4 ? w[16] : 1;
  return Math.max(
    0.1,
    fsrs.stability *
      (1 +
        Math.exp(w[8]) *
          (11 - fsrs.difficulty) *
          Math.pow(fsrs.stability, -w[9]) *
          (Math.exp((1 - r) * w[10]) - 1) *
          hardPenalty *
          easyBonus),
  );
}

function intervalForStability(stability) {
  const raw =
    (stability / (19 / 81)) *
    (Math.pow(FSRS_PARAMETERS.requestRetention, 1 / -0.5) - 1);
  return clamp(
    Math.round(raw),
    FSRS_PARAMETERS.minimumIntervalDays,
    FSRS_PARAMETERS.maximumIntervalDays,
  );
}

export function scheduleFsrs(previous, ratingName, now) {
  if (!VALID_RATINGS.has(ratingName)) {
    throw new AppError("INVALID_REVIEW_RATING", "复习反馈不受支持");
  }
  const rating = RATING_VALUE[ratingName];
  const w = FSRS_PARAMETERS.weights;
  const stability = previous
    ? nextStability(previous, rating, now)
    : w[rating - 1];
  const difficulty = previous
    ? nextDifficulty(previous.difficulty, rating)
    : initialDifficulty(rating);
  const intervalDays = intervalForStability(stability);
  return {
    fsrs: {
      stability,
      difficulty,
      reps: (previous?.reps ?? 0) + 1,
      lapses: (previous?.lapses ?? 0) + (rating === 1 ? 1 : 0),
      state: "review",
      elapsedDays: previous?.lastReviewAt
        ? Math.max(0, dayDifference(previous.lastReviewAt, now))
        : 0,
      scheduledDays: intervalDays,
      lastReviewAt: now,
      schedulerVersion: SCHEDULER_VERSION,
    },
    intervalDays,
    dueAt: addDays(now, intervalDays),
  };
}

export function submitReviewFeedback(
  state,
  { taskId, questionKey, rating, durationMinutes, now },
) {
  const existingRecord = Object.values(state.questions ?? {}).flatMap(
    (question) => question.reviewHistory ?? [],
  ).find((record) => record.taskId === taskId);
  if (existingRecord) {
    return { state, record: existingRecord, duplicate: true };
  }
  const today = state.plan?.today;
  const assignment = today?.assignments.find(
    (item) => item.id === taskId && item.questionKey === questionKey,
  );
  if (!assignment || assignment.status !== "pending") {
    throw new AppError("TASK_NOT_ACTIVE", "今日任务不存在或已经处理");
  }
  const question = state.questions?.[questionKey];
  if (!question) throw new AppError("QUESTION_NOT_FOUND", "题目不存在或已被删除");
  const scheduled = scheduleFsrs(question.review?.fsrs, rating, now);
  const numericDuration = Number(durationMinutes);
  const validDuration = numericDuration >= 3 && numericDuration <= 120;
  const record = {
    id: `${taskId}:${now}`,
    taskId,
    rating,
    reviewedAt: now,
    durationMinutes: validDuration ? numericDuration : null,
    valid: true,
    schedulerVersion: SCHEDULER_VERSION,
    previousDueAt: question.review?.dueAt ?? null,
    nextDueAt: scheduled.dueAt,
    intervalDays: scheduled.intervalDays,
  };
  const questions = {
    ...state.questions,
    [questionKey]: {
      ...question,
      review: {
        ...question.review,
        status: "reviewing",
        mastery: rating,
        fsrs: scheduled.fsrs,
        dueAt: scheduled.dueAt,
        lastReviewedAt: now,
        consecutiveMissedDays: 0,
        resumedAt: null,
        updatedAt: now,
        updatedByDeviceId: state.device.id,
      },
      reviewHistory: [...(question.reviewHistory ?? []), record],
    },
  };
  const assignments = today.assignments.map((item) =>
    item.id === taskId
      ? {
          ...item,
          status: "completed",
          completedAt: now,
          rating,
          actualMinutes: validDuration ? numericDuration : null,
          nextDueAt: scheduled.dueAt,
        }
      : item,
  );
  const completedState = {
    ...state,
    questions,
    plan: {
      ...state.plan,
      today: { ...today, assignments },
    },
  };
  return {
    state: recalculateTodayPlan(completedState, {
      now,
      reason: "REVIEW_FEEDBACK_SUBMITTED",
    }),
    record,
    duplicate: false,
  };
}

export function skipTodayTask(state, { taskId, now }) {
  const today = state.plan?.today;
  const assignment = today?.assignments.find((item) => item.id === taskId);
  if (!assignment || assignment.status !== "pending") {
    throw new AppError("TASK_NOT_ACTIVE", "今日任务不存在或已经处理");
  }
  const assignments = today.assignments.map((item) =>
    item.id === taskId ? { ...item, status: "skipped", skippedAt: now } : item,
  );
  return recalculateTodayPlan(
    { ...state, plan: { ...state.plan, today: { ...today, assignments } } },
    { now, reason: "TASK_SKIPPED" },
  );
}

export function deferTodayTask(state, { taskId, now }) {
  const today = state.plan?.today;
  const assignment = today?.assignments.find((item) => item.id === taskId);
  if (!assignment || assignment.status !== "pending") {
    throw new AppError("TASK_NOT_ACTIVE", "今日任务不存在或已经处理");
  }
  const assignments = today.assignments
    .filter((item) => item.id !== taskId)
    .concat({
      ...assignment,
      deferredAt: now,
      deferCount: (assignment.deferCount ?? 0) + 1,
    })
    .map((item, order) => ({ ...item, order }));
  return {
    ...state,
    plan: appendChange(
      { ...state.plan, today: { ...today, revisedAt: now, revisionReason: "TASK_DEFERRED", assignments } },
      {
        id: `${now}:TASK_DEFERRED:${taskId}`,
        at: now,
        reason: "TASK_DEFERRED",
        details: { taskId, questionKey: assignment.questionKey },
      },
    ),
  };
}

export function pauseReviewPlan(state, { now }) {
  if (state.plan?.pausedAt) return state;
  const today = state.plan?.today
    ? {
        ...state.plan.today,
        revisedAt: now,
        revisionReason: "PLAN_PAUSED",
        assignments: state.plan.today.assignments.map((assignment) =>
          assignment.status === "pending"
            ? { ...assignment, status: "suspended", suspendedAt: now }
            : assignment,
        ),
      }
    : null;
  return {
    ...state,
    plan: appendChange(
      { ...state.plan, pausedAt: now, today },
      { id: `${now}:PLAN_PAUSED`, at: now, reason: "PLAN_PAUSED", details: {} },
    ),
  };
}

export function resumeReviewPlan(state, { now }) {
  if (!state.plan?.pausedAt) return ensureTodayPlan(state, { now });
  const pausedAt = state.plan.pausedAt;
  const pausedDays = Math.max(0, dayDifference(pausedAt, now));
  const questions = Object.fromEntries(
    Object.entries(state.questions ?? {}).map(([key, question]) => {
      if (question.review?.status !== "reviewing" || !question.review?.dueAt) {
        return [key, question];
      }
      const wasDue = isSameOrBefore(question.review.dueAt, pausedAt);
      return [
        key,
        {
          ...question,
          review: {
            ...question.review,
            dueAt: wasDue
              ? addDays(now, 0)
              : addDays(question.review.dueAt, pausedDays),
            resumedAt: now,
            updatedAt: now,
            updatedByDeviceId: state.device.id,
          },
        },
      ];
    }),
  );
  const sameDay = state.plan.today?.date === localDateKey(now);
  const today = sameDay
    ? {
        ...state.plan.today,
        assignments: state.plan.today.assignments.map((assignment) =>
          assignment.status === "suspended"
            ? { ...assignment, status: "pending", resumedAt: now }
            : assignment,
        ),
      }
    : state.plan.today;
  const resumed = {
    ...state,
    questions,
    plan: appendChange(
      { ...state.plan, pausedAt: null, today },
      {
        id: `${now}:PLAN_RESUMED`,
        at: now,
        reason: "PLAN_RESUMED",
        details: { pausedDays },
      },
    ),
  };
  return recalculateTodayPlan(resumed, { now, reason: "PLAN_RESUMED" });
}

export function updatePlanSettings(state, values, { now }) {
  const next = { ...state.settings };
  if (values.dailyCapacityMode !== undefined) {
    if (!new Set(["count", "time"]).has(values.dailyCapacityMode)) {
      throw new AppError("INVALID_CAPACITY_MODE", "每日容量模式不受支持");
    }
    next.dailyCapacityMode = values.dailyCapacityMode;
  }
  if (values.dailyQuestionLimit !== undefined) {
    const limit = Number(values.dailyQuestionLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new AppError("INVALID_QUESTION_LIMIT", "每日题数必须为 1 至 50");
    }
    next.dailyQuestionLimit = limit;
  }
  if (values.dailyMinutesLimit !== undefined) {
    const limit = Number(values.dailyMinutesLimit);
    if (!Number.isInteger(limit) || limit < 10 || limit > 240 || limit % 5 !== 0) {
      throw new AppError("INVALID_TIME_LIMIT", "每日时间必须为 10 至 240 分钟，步长为 5 分钟");
    }
    next.dailyMinutesLimit = limit;
  }
  if (values.reviewGoal !== undefined) {
    if (!VALID_GOALS.has(values.reviewGoal)) {
      throw new AppError("INVALID_REVIEW_GOAL", "复习目标不受支持");
    }
    next.reviewGoal = values.reviewGoal;
  }
  if (values.reminderEnabled !== undefined) {
    next.reminderEnabled = Boolean(values.reminderEnabled);
  }
  if (values.reminderTime !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(values.reminderTime)) {
      throw new AppError("INVALID_REMINDER_TIME", "提醒时间格式无效");
    }
    next.reminderTime = values.reminderTime;
  }
  if (values.interview !== undefined) {
    next.interview = { ...next.interview, ...values.interview };
  }
  if (next.reviewGoal === "interview") {
    const days = next.interview?.date ? dayDifference(now, next.interview.date) : -1;
    if (days < 7 || days > 90) {
      throw new AppError("INVALID_INTERVIEW_DATE", "面试日期必须在当前日期后 7 至 90 天");
    }
    if (!next.interview.capacityConfirmed) {
      throw new AppError("INTERVIEW_CAPACITY_UNCONFIRMED", "请确认面试冲刺使用当前每日容量");
    }
    if (!new Set(["focus", "tag", "difficulty", "selected"]).has(next.interview.scopeType)) {
      throw new AppError("INVALID_INTERVIEW_SCOPE", "面试冲刺范围不受支持");
    }
    if (
      ["tag", "difficulty"].includes(next.interview.scopeType) &&
      !(next.interview.scopeValues?.length > 0)
    ) {
      throw new AppError("EMPTY_INTERVIEW_SCOPE", "请至少选择一个冲刺范围值");
    }
    if (
      next.interview.scopeType === "selected" &&
      !(next.interview.questionKeys?.length > 0)
    ) {
      throw new AppError("EMPTY_INTERVIEW_SCOPE", "请至少选择一道冲刺题目");
    }
    if (
      next.interview.scopeType === "selected" &&
      next.interview.questionKeys.some((key) => !state.questions?.[key])
    ) {
      throw new AppError("QUESTION_NOT_FOUND", "冲刺题单包含不存在的题目");
    }
  }
  return recalculateTodayPlan(
    { ...state, settings: next },
    { now, reason: "PLAN_SETTINGS_UPDATED" },
  );
}

export function forecastPlan(state, { now, days = 14 }) {
  const result = [];
  const maxDays = clamp(Number(days) || 14, 1, 31);
  if (state.plan?.pausedAt) {
    return Array.from({ length: maxDays }, (_, offset) => ({
      date: localDateKey(addDays(now, offset)),
      count: 0,
      estimatedMinutes: 0,
      backlog: 0,
      assignments: [],
    }));
  }
  const remaining = Object.values(state.questions ?? {}).filter(
    (question) =>
      question.review?.status === "reviewing" &&
      (question.sourceAvailability === "available" || question.review?.allowUnavailable),
  );
  const assigned = new Set();
  for (let offset = 0; offset < maxDays; offset += 1) {
    const date = addDays(now, offset);
    const candidates = remaining
      .filter((question) => !assigned.has(question.key))
      .filter((question) => {
        const hasHistory = Boolean(question.review?.fsrs) || question.reviewHistory?.length;
        return !hasHistory || (question.review?.dueAt && isSameOrBefore(question.review.dueAt, date));
      })
      .sort((left, right) => compareDue(left, right, state.settings, date));
    const selected = selectAssignments(state, candidates, date, 0);
    for (const question of selected) assigned.add(question.key);
    result.push({
      date: localDateKey(date),
      count: selected.length,
      estimatedMinutes: selected.reduce(
        (sum, question) => sum + estimateMinutes(state, question),
        0,
      ),
      backlog: Math.max(0, candidates.length - selected.length),
      assignments: selected.map((question) => ({
        questionKey: question.key,
        status: "future",
        estimatedMinutes: estimateMinutes(state, question),
        priority: calculatePriority(question, state.settings, date),
        reason: recommendationFor(question, state.settings, date),
      })),
    });
  }
  return result;
}

export function getPlanSummary(state, now) {
  const today = state.plan?.today;
  const assignments = today?.date === localDateKey(now) ? today.assignments : [];
  return {
    paused: Boolean(state.plan?.pausedAt),
    pausedAt: state.plan?.pausedAt ?? null,
    today,
    completedCount: assignments.filter((item) => item.status === "completed").length,
    pendingCount: assignments.filter((item) => item.status === "pending").length,
    skippedCount: assignments.filter((item) => item.status === "skipped").length,
    forecast: forecastPlan(state, { now }),
    recentChanges: (state.plan?.changes ?? []).slice(0, 20),
  };
}

export function shouldSendReviewReminder(state, now) {
  const summary = getPlanSummary(state, now);
  return Boolean(
    state.settings?.reminderEnabled && !summary.paused && summary.pendingCount > 0,
  );
}

function completionSnapshot(plan) {
  const assignments = plan?.assignments ?? [];
  const completed = assignments.filter((item) => item.status === "completed").length;
  const pending = assignments.filter((item) => item.status === "pending").length;
  const skipped = assignments.filter((item) => item.status === "skipped").length;
  const total = completed + pending;
  return {
    completed,
    pending,
    skipped,
    total,
    rate: total > 0 ? Math.round((completed / total) * 100) : 0,
  };
}

function completedPlanDay(plan) {
  const snapshot = completionSnapshot(plan);
  return snapshot.completed > 0 && snapshot.pending === 0;
}

function masteryDistribution(questions) {
  const result = { unassessed: 0, again: 0, hard: 0, good: 0, easy: 0 };
  for (const question of questions) {
    const mastery = question.review?.mastery;
    result[mastery && result[mastery] !== undefined ? mastery : "unassessed"] += 1;
  }
  return result;
}

function groupMastery(questions, keyForQuestion) {
  const groups = new Map();
  for (const question of questions) {
    for (const key of keyForQuestion(question)) {
      const current = groups.get(key) ?? { key, total: 0, mastered: 0, weak: 0, unassessed: 0 };
      current.total += 1;
      if (["good", "easy"].includes(question.review?.mastery)) current.mastered += 1;
      else if (["again", "hard"].includes(question.review?.mastery)) current.weak += 1;
      else current.unassessed += 1;
      groups.set(key, current);
    }
  }
  return [...groups.values()].sort((left, right) =>
    right.weak - left.weak || right.total - left.total || left.key.localeCompare(right.key),
  );
}

export function getReviewProgress(state, now) {
  const date = localDateKey(now);
  const current = state.plan?.today?.date === date ? state.plan.today : null;
  const historyByDate = new Map(
    (state.plan?.history ?? []).map((plan) => [plan.date, plan]),
  );
  if (current) historyByDate.set(date, current);

  const today = completionSnapshot(current);
  const weekPlans = Array.from({ length: 7 }, (_, offset) =>
    historyByDate.get(localDateKey(addDays(now, offset - 6))),
  ).filter(Boolean);
  const week = weekPlans.reduce(
    (result, plan) => {
      const snapshot = completionSnapshot(plan);
      result.completed += snapshot.completed;
      result.total += snapshot.total;
      return result;
    },
    { completed: 0, total: 0 },
  );
  week.rate = week.total > 0 ? Math.round((week.completed / week.total) * 100) : 0;

  const questions = Object.values(state.questions ?? {});
  const active = questions.filter((question) =>
    question.review?.status === "reviewing" &&
    (question.sourceAvailability === "available" || question.review?.allowUnavailable),
  );
  const upcomingLimit = localDayStart(addDays(now, 7));
  const due = active.reduce(
    (result, question) => {
      if (!question.review?.dueAt) return result;
      const dueDate = localDayStart(question.review.dueAt);
      if (dueDate < localDayStart(now)) result.overdue += 1;
      else if (dueDate <= upcomingLimit) result.upcoming += 1;
      return result;
    },
    { overdue: 0, upcoming: 0 },
  );

  const forecast = forecastPlan(state, { now, days: 14 });
  const forecastByDate = new Map(forecast.map((day) => [day.date, day]));
  const calendar = Array.from({ length: 21 }, (_, index) => {
    const offset = index - 6;
    const day = localDateKey(addDays(now, offset));
    const plan = historyByDate.get(day);
    if (offset <= 0 && plan) {
      const snapshot = completionSnapshot(plan);
      let status = "idle";
      if (completedPlanDay(plan)) status = "completed";
      else if (snapshot.total > 0) status = offset < 0 ? "overdue" : "partial";
      return {
        date: day,
        status,
        count: snapshot.total,
        completed: snapshot.completed,
        assignments: (plan.assignments ?? [])
          .filter((assignment) => ["completed", "pending"].includes(assignment.status))
          .map((assignment) => ({
            questionKey: assignment.questionKey,
            status: assignment.status,
            completedAt: assignment.completedAt ?? null,
            rating: assignment.rating ?? null,
            estimatedMinutes: assignment.estimatedMinutes ?? null,
            actualMinutes: assignment.actualMinutes ?? null,
            nextDueAt: assignment.nextDueAt ?? null,
            reason: assignment.reason ?? null,
          })),
      };
    }
    const future = forecastByDate.get(day);
    return {
      date: day,
      status: future?.count > 0 ? "future" : "idle",
      count: future?.count ?? 0,
      completed: 0,
      assignments: future?.assignments ?? [],
    };
  });

  let streak = 0;
  let streakOffset = completedPlanDay(current) ? 0 : -1;
  while (streakOffset >= -90) {
    const plan = historyByDate.get(localDateKey(addDays(now, streakOffset)));
    if (!completedPlanDay(plan)) break;
    streak += 1;
    streakOffset -= 1;
  }

  const improvementWindow = localDayStart(addDays(now, -30));
  const improvedCount = questions.filter((question) => {
    const records = (question.reviewHistory ?? [])
      .filter((record) => record.reviewedAt && localDayStart(record.reviewedAt) >= improvementWindow)
      .sort((left, right) => new Date(left.reviewedAt) - new Date(right.reviewedAt));
    let sawWeak = false;
    for (const record of records) {
      if (["again", "hard"].includes(record.rating)) sawWeak = true;
      if (sawWeak && ["good", "easy"].includes(record.rating)) return true;
    }
    return false;
  }).length;

  const difficulty = groupMastery(questions, (question) => [question.difficulty ?? "UNKNOWN"]);
  const tags = groupMastery(questions, (question) =>
    (question.tags ?? []).map((tag) => tag.translatedName || tag.name || tag.slug).filter(Boolean),
  ).slice(0, 10);

  const optionalStatisticsEnabled = state.settings?.optionalStatisticsEnabled !== false;
  return {
    today,
    week,
    mastery: masteryDistribution(questions),
    due,
    forecast,
    calendar,
    streak: optionalStatisticsEnabled ? streak : null,
    improvedCount: optionalStatisticsEnabled ? improvedCount : null,
    distributions: optionalStatisticsEnabled ? { difficulty, tags } : { difficulty: [], tags: [] },
    optionalStatisticsEnabled,
  };
}

export function nextReminderAt(now, reminderTime) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(reminderTime)) {
    throw new AppError("INVALID_REMINDER_TIME", "提醒时间格式无效");
  }
  const [hours, minutes] = reminderTime.split(":").map(Number);
  const current = new Date(now);
  if (Number.isNaN(current.valueOf())) {
    throw new AppError("INVALID_DATE", "日期格式无效", { value: now });
  }
  const reminder = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate(),
    hours,
    minutes,
    0,
    0,
  );
  if (reminder <= current) reminder.setDate(reminder.getDate() + 1);
  return reminder.toISOString();
}
