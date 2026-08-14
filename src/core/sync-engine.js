import { AppError } from "./errors.js";
import { autoJoinReacceptedQuestion } from "./library.js";

const SOURCE_SITE = "leetcode.cn";
const VALID_DIFFICULTIES = new Set(["EASY", "MEDIUM", "HARD", "UNKNOWN"]);
const SOLVED_STATUSES = new Set(["SOLVED", "PAST_SOLVED"]);

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeDifficulty(value) {
  const normalized = cleanString(value)?.toUpperCase() ?? "UNKNOWN";
  return VALID_DIFFICULTIES.has(normalized) ? normalized : "UNKNOWN";
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }

  const bySlug = new Map();
  for (const tag of tags) {
    const slug = cleanString(tag?.slug);
    const name = cleanString(tag?.name);
    if (!slug && !name) {
      continue;
    }

    const key = slug ?? name.toLowerCase();
    bySlug.set(key, {
      slug,
      name,
      translatedName: cleanString(tag?.translatedName ?? tag?.nameTranslated),
    });
  }

  return [...bySlug.values()].sort((left, right) =>
    (left.slug ?? left.name ?? "").localeCompare(right.slug ?? right.name ?? ""),
  );
}

export function getCanonicalKey(question) {
  const sourceQuestionId = cleanString(String(question?.sourceQuestionId ?? question?.id ?? ""));
  if (sourceQuestionId) {
    return `${SOURCE_SITE}:${sourceQuestionId}`;
  }

  const titleSlug = cleanString(question?.titleSlug);
  if (titleSlug) {
    return `${SOURCE_SITE}:slug:${titleSlug}`;
  }

  throw new AppError(
    "INVALID_QUESTION_IDENTITY",
    "题目缺少来源 ID 和 titleSlug，无法安全写入题库",
  );
}

export function normalizeRemoteQuestion(raw, { accountSlug, syncedAt }) {
  const status = cleanString(raw?.status)?.toUpperCase();
  if (!SOLVED_STATUSES.has(status)) {
    throw new AppError("QUESTION_NOT_SOLVED", "题目状态不是已通过", {
      status,
      titleSlug: cleanString(raw?.titleSlug),
    });
  }

  const sourceQuestionId = cleanString(String(raw?.sourceQuestionId ?? raw?.id ?? ""));
  const titleSlug = cleanString(raw?.titleSlug);
  const key = getCanonicalKey({ sourceQuestionId, titleSlug });
  const acceptedAt = cleanString(raw?.acceptedAt);

  return {
    key,
    sourceSite: SOURCE_SITE,
    accountSlug,
    sourceQuestionId,
    questionFrontendId: cleanString(raw?.questionFrontendId),
    title: cleanString(raw?.title) ?? titleSlug ?? "未命名题目",
    translatedTitle: cleanString(raw?.translatedTitle),
    titleSlug,
    difficulty: normalizeDifficulty(raw?.difficulty),
    tags: normalizeTags(raw?.topicTags ?? raw?.tags),
    paidOnly: Boolean(raw?.paidOnly),
    sourceStatus: status,
    sourceAvailability: "available",
    acceptedAt,
    acceptedAtSource: acceptedAt ? "recent_accepted_submission" : null,
    planningBaselineAt: acceptedAt ?? syncedAt,
    lastSourceSeenAt: syncedAt,
  };
}

function comparableSource(question) {
  return {
    sourceQuestionId: question.sourceQuestionId,
    questionFrontendId: question.questionFrontendId,
    title: question.title,
    translatedTitle: question.translatedTitle,
    titleSlug: question.titleSlug,
    difficulty: question.difficulty,
    tags: question.tags,
    paidOnly: question.paidOnly,
    sourceStatus: question.sourceStatus,
    sourceAvailability: question.sourceAvailability,
    acceptedAt: question.acceptedAt,
    acceptedAtSource: question.acceptedAtSource,
  };
}

function sourceChanged(existing, remote) {
  return JSON.stringify(comparableSource(existing)) !== JSON.stringify(comparableSource(remote));
}

function validTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const timestamp = new Date(value).valueOf();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isReacceptedQuestion(existing, remote, recentAcceptedAvailable) {
  if (!recentAcceptedAvailable || remote.acceptedAtSource !== "recent_accepted_submission") {
    return false;
  }
  const acceptedAt = validTimestamp(remote.acceptedAt);
  const lastSourceSeenAt = validTimestamp(existing.lastSourceSeenAt);
  return acceptedAt !== null && lastSourceSeenAt !== null && acceptedAt > lastSourceSeenAt;
}

function createReviewState(mode, syncedAt, deviceId) {
  return {
    status: mode === "reviewing" ? "reviewing" : "pending",
    isFocus: false,
    mastery: null,
    dueAt: null,
    lastReviewedAt: null,
    consecutiveMissedDays: 0,
    remainingDaysOnPause: null,
    resumedAt: null,
    fsrs: null,
    updatedAt: syncedAt,
    updatedByDeviceId: deviceId,
  };
}

function findExistingBySlug(questions, remote) {
  if (!remote.titleSlug) {
    return null;
  }

  const matches = Object.values(questions).filter(
    (question) =>
      question.sourceSite === remote.sourceSite && question.titleSlug === remote.titleSlug,
  );
  return matches.length === 1 ? matches[0] : null;
}

export function mergeRemoteSnapshot(state, snapshot, { syncedAt }) {
  if (!snapshot?.account?.userSlug) {
    throw new AppError("INVALID_ACCOUNT", "同步结果缺少账号标识");
  }
  if (!snapshot.complete) {
    throw new AppError("INCOMPLETE_SNAPSHOT", "远端题目分页未完整读取");
  }
  if (
    state.dataOwnerUserSlug &&
    state.dataOwnerUserSlug !== snapshot.account.userSlug
  ) {
    throw new AppError("ACCOUNT_MISMATCH", "当前登录账号与本地题库账号不一致", {
      expectedUserSlug: state.dataOwnerUserSlug,
      detectedUserSlug: snapshot.account.userSlug,
    });
  }

  const nextQuestions = { ...state.questions };
  const seenKeys = new Set();
  const result = {
    added: 0,
    updated: 0,
    unchanged: 0,
    reaccepted: 0,
    autoJoinedReview: 0,
    failed: Array.isArray(snapshot.failures) ? snapshot.failures.length : 0,
    conflicts: 0,
    warnings: Array.isArray(snapshot.warnings) ? [...snapshot.warnings] : [],
  };

  for (const raw of snapshot.questions ?? []) {
    let remote;
    try {
      remote = normalizeRemoteQuestion(raw, {
        accountSlug: snapshot.account.userSlug,
        syncedAt,
      });
    } catch (error) {
      result.failed += 1;
      continue;
    }

    if (seenKeys.has(remote.key)) {
      continue;
    }
    seenKeys.add(remote.key);

    let existing = nextQuestions[remote.key] ?? null;
    let existingKey = remote.key;
    if (!existing) {
      const slugMatch = findExistingBySlug(nextQuestions, remote);
      if (
        slugMatch &&
        slugMatch.sourceQuestionId &&
        remote.sourceQuestionId &&
        slugMatch.sourceQuestionId !== remote.sourceQuestionId
      ) {
        result.failed += 1;
        result.conflicts += 1;
        continue;
      }
      if (slugMatch) {
        existing = slugMatch;
        existingKey = slugMatch.key;
      }
    }

    if (!existing) {
      nextQuestions[remote.key] = {
        ...remote,
        firstSyncedAt: syncedAt,
        lastSourceChangedAt: syncedAt,
        review: createReviewState(
          state.settings.newQuestionMode,
          syncedAt,
          state.device.id,
        ),
        reviewHistory: [],
        note: "",
        remoteConflict: null,
      };
      result.added += 1;
      continue;
    }

    const mergedRemote = {
      ...remote,
      acceptedAt: remote.acceptedAt ?? existing.acceptedAt ?? null,
      acceptedAtSource:
        remote.acceptedAtSource ?? existing.acceptedAtSource ?? null,
      planningBaselineAt:
        remote.acceptedAt ?? existing.planningBaselineAt ?? existing.firstSyncedAt ?? syncedAt,
    };
    const changed = sourceChanged(existing, mergedRemote) || existing.key !== remote.key;
    const reaccepted = isReacceptedQuestion(
      existing,
      remote,
      result.warnings.length === 0,
    );
    if (reaccepted) {
      result.reaccepted += 1;
    }
    const mergedQuestion = {
      ...existing,
      ...mergedRemote,
      key: remote.key,
      firstSyncedAt: existing.firstSyncedAt ?? syncedAt,
      lastSourceChangedAt: changed
        ? syncedAt
        : existing.lastSourceChangedAt ?? existing.firstSyncedAt ?? syncedAt,
      review: existing.review,
      reviewHistory: existing.reviewHistory ?? [],
      note: existing.note ?? "",
      remoteConflict: null,
    };
    const autoJoinedQuestion =
      reaccepted && state.settings.autoJoinReacceptedQuestions === true
        ? autoJoinReacceptedQuestion(mergedQuestion, {
            now: syncedAt,
            deviceId: state.device.id,
          })
        : mergedQuestion;
    if (autoJoinedQuestion !== mergedQuestion) {
      result.autoJoinedReview += 1;
    }
    if (existingKey !== remote.key) {
      delete nextQuestions[existingKey];
    }

    nextQuestions[remote.key] = autoJoinedQuestion;

    if (changed) {
      result.updated += 1;
    } else {
      result.unchanged += 1;
    }
  }

  for (const [key, existing] of Object.entries(nextQuestions)) {
    if (
      existing.accountSlug !== snapshot.account.userSlug ||
      seenKeys.has(key) ||
      existing.sourceAvailability === "missing"
    ) {
      continue;
    }

    nextQuestions[key] = {
      ...existing,
      sourceAvailability: "missing",
      remoteConflict: {
        type: "NO_LONGER_IN_SOLVED_SNAPSHOT",
        detectedAt: syncedAt,
      },
      lastSourceChangedAt: syncedAt,
    };
    result.updated += 1;
    result.conflicts += 1;
  }

  return {
    state: {
      ...state,
      dataOwnerUserSlug: snapshot.account.userSlug,
      questions: nextQuestions,
    },
    result,
  };
}
