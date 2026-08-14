export const SCHEMA_VERSION = 5;
export const DEFAULT_AUTO_SYNC_INTERVAL_MINUTES = 360;

export const DEFAULT_REVIEW_SETTINGS = Object.freeze({
  newQuestionMode: "pending",
  autoJoinReacceptedQuestions: false,
  dailyCapacityMode: "count",
  dailyQuestionLimit: 5,
  dailyMinutesLimit: 30,
  reviewGoal: "daily",
  reminderEnabled: false,
  reminderTime: "20:00",
  optionalStatisticsEnabled: true,
  interview: {
    date: null,
    scopeType: "focus",
    scopeValues: [],
    questionKeys: [],
    capacityConfirmed: false,
  },
});

function createPlanState() {
  return {
    pausedAt: null,
    today: null,
    history: [],
    changes: [],
  };
}

function normalizeReview(review, now) {
  const source = review && typeof review === "object" ? review : {};
  return {
    status: source.status ?? "pending",
    isFocus: Boolean(source.isFocus),
    mastery: source.mastery ?? null,
    dueAt: source.dueAt ?? null,
    lastReviewedAt: source.lastReviewedAt ?? null,
    consecutiveMissedDays: Number.isInteger(source.consecutiveMissedDays)
      ? Math.max(0, source.consecutiveMissedDays)
      : 0,
    remainingDaysOnPause: Number.isFinite(source.remainingDaysOnPause)
      ? Math.max(0, source.remainingDaysOnPause)
      : null,
    resumedAt: source.resumedAt ?? null,
    fsrs: source.fsrs && typeof source.fsrs === "object" ? source.fsrs : null,
    updatedAt: source.updatedAt ?? now,
    updatedByDeviceId: source.updatedByDeviceId ?? null,
  };
}

function normalizeQuestions(questions, now) {
  if (!questions || typeof questions !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(questions).map(([key, question]) => [
      key,
      {
        ...question,
        review: normalizeReview(question?.review, now),
        reviewHistory: Array.isArray(question?.reviewHistory)
          ? question.reviewHistory
          : [],
        note: typeof question?.note === "string" ? question.note : "",
      },
    ]),
  );
}

export function createInitialState({ now, deviceId }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    device: {
      id: deviceId,
      createdAt: now,
    },
    dataOwnerUserSlug: null,
    connection: {
      status: "disconnected",
      site: "leetcode.cn",
      userSlug: null,
      username: null,
      realName: null,
      avatar: null,
      connectedAt: null,
      lastCheckedAt: null,
      lastError: null,
    },
    questions: {},
    settings: {
      ...DEFAULT_REVIEW_SETTINGS,
      interview: { ...DEFAULT_REVIEW_SETTINGS.interview },
      autoSyncEnabled: false,
      autoSyncIntervalMinutes: DEFAULT_AUTO_SYNC_INTERVAL_MINUTES,
    },
    sync: {
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastResult: null,
      nextAutoSyncAt: null,
      history: [],
    },
    plan: createPlanState(),
    privacy: {
      consentAt: null,
      lastExportAt: null,
      lastDeletionAt: null,
    },
  };
}

export function normalizeState(stored, { now, deviceId }) {
  const initial = createInitialState({ now, deviceId });
  if (!stored || typeof stored !== "object") {
    return initial;
  }

  const settings = {
    ...initial.settings,
    ...stored.settings,
    autoJoinReacceptedQuestions:
      stored.settings?.autoJoinReacceptedQuestions === true,
    interview: {
      ...initial.settings.interview,
      ...(stored.settings?.interview ?? {}),
      scopeValues: Array.isArray(stored.settings?.interview?.scopeValues)
        ? stored.settings.interview.scopeValues
        : [],
      questionKeys: Array.isArray(stored.settings?.interview?.questionKeys)
        ? stored.settings.interview.questionKeys
        : [],
    },
  };
  const plan = stored.plan && typeof stored.plan === "object" ? stored.plan : {};

  return {
    ...initial,
    ...stored,
    schemaVersion: SCHEMA_VERSION,
    device: { ...initial.device, ...stored.device },
    connection: { ...initial.connection, ...stored.connection },
    questions: normalizeQuestions(stored.questions, now),
    settings,
    sync: {
      ...initial.sync,
      ...stored.sync,
      history: Array.isArray(stored.sync?.history)
        ? stored.sync.history.slice(0, 50)
        : [],
    },
    plan: {
      ...initial.plan,
      ...plan,
      history: Array.isArray(plan.history) ? plan.history.slice(0, 90) : [],
      changes: Array.isArray(plan.changes) ? plan.changes.slice(0, 100) : [],
    },
    privacy: {
      ...initial.privacy,
      ...(stored.privacy ?? {}),
    },
  };
}
