import { AppError } from "./errors.js";

export const REVIEW_STATUSES = new Set([
  "pending",
  "reviewing",
  "paused",
  "graduated",
  "ignored",
]);
export const MASTERY_LEVELS = new Set(["again", "hard", "good", "easy"]);

const ALLOWED_TRANSITIONS = {
  pending: new Set(["reviewing", "ignored"]),
  reviewing: new Set(["paused", "graduated", "ignored"]),
  paused: new Set(["reviewing", "graduated", "ignored"]),
  graduated: new Set(["reviewing", "ignored"]),
  ignored: new Set(["pending", "reviewing"]),
};

function cleanArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function dayStart(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return null;
  }
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(value, days) {
  const date = dayStart(value);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function daysUntil(from, to) {
  const fromDay = dayStart(from);
  const toDay = dayStart(to);
  if (!fromDay || !toDay) {
    return 0;
  }
  return Math.max(0, Math.ceil((toDay - fromDay) / 86_400_000));
}

export function isOverdue(question, now) {
  const due = dayStart(question?.review?.dueAt);
  const today = dayStart(now);
  return Boolean(due && today && due < today);
}

function normalizedText(value) {
  return String(value ?? "").trim().toLocaleLowerCase("zh-CN");
}

function matchesSearch(question, search) {
  const term = normalizedText(search);
  if (!term) {
    return true;
  }
  return [
    question.questionFrontendId,
    question.sourceQuestionId,
    question.title,
    question.translatedTitle,
  ].some((value) => normalizedText(value).includes(term));
}

function matchesTags(question, tags) {
  if (tags.length === 0) {
    return true;
  }
  const questionTags = new Set(
    (question.tags ?? []).flatMap((tag) =>
      [tag.slug, tag.name, tag.translatedName].map(normalizedText).filter(Boolean),
    ),
  );
  return tags.some((tag) => questionTags.has(normalizedText(tag)));
}

function compareNullableDates(left, right, direction) {
  const leftValue = left ? new Date(left).valueOf() : null;
  const rightValue = right ? new Date(right).valueOf() : null;
  if (leftValue === rightValue) return 0;
  if (leftValue === null || Number.isNaN(leftValue)) return 1;
  if (rightValue === null || Number.isNaN(rightValue)) return -1;
  return (leftValue - rightValue) * direction;
}

export function queryLibrary(state, options = {}, now = new Date().toISOString()) {
  const statuses = cleanArray(options.statuses);
  const masteries = cleanArray(options.masteries);
  const difficulties = cleanArray(options.difficulties).map((value) =>
    String(value).toUpperCase(),
  );
  const tags = cleanArray(options.tags);
  const participation = options.participation ?? "all";
  const overdue = options.overdue ?? "all";
  const sortBy = ["acceptedAt", "lastReviewedAt", "dueAt"].includes(options.sortBy)
    ? options.sortBy
    : "acceptedAt";
  const direction = options.sortDirection === "asc" ? 1 : -1;
  const pageSize = Math.min(100, Math.max(1, Number(options.pageSize) || 30));
  const requestedPage = Math.max(1, Number(options.page) || 1);

  const filtered = Object.values(state.questions ?? {}).filter((question) => {
    const review = question.review ?? {};
    const mastery = review.mastery ?? "unassessed";
    if (!matchesSearch(question, options.search)) return false;
    if (statuses.length > 0 && !statuses.includes(review.status)) return false;
    if (masteries.length > 0 && !masteries.includes(mastery)) return false;
    if (difficulties.length > 0 && !difficulties.includes(question.difficulty)) return false;
    if (!matchesTags(question, tags)) return false;
    if (participation === "in" && review.status !== "reviewing") return false;
    if (participation === "out" && review.status === "reviewing") return false;
    if (overdue === "overdue" && !isOverdue(question, now)) return false;
    if (overdue === "not_overdue" && isOverdue(question, now)) return false;
    return true;
  });

  filtered.sort((left, right) => {
    const leftDate =
      sortBy === "acceptedAt" ? left.acceptedAt : left.review?.[sortBy];
    const rightDate =
      sortBy === "acceptedAt" ? right.acceptedAt : right.review?.[sortBy];
    return (
      compareNullableDates(leftDate, rightDate, direction) ||
      String(left.key).localeCompare(String(right.key))
    );
  });

  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, pageCount);
  const start = (page - 1) * pageSize;
  return {
    items: filtered.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    pageCount,
  };
}

export function getLibraryFacets(state) {
  const tags = new Map();
  for (const question of Object.values(state.questions ?? {})) {
    for (const tag of question.tags ?? []) {
      const key = tag.slug ?? tag.translatedName ?? tag.name;
      if (!key) continue;
      const current = tags.get(key) ?? {
        value: key,
        label: tag.translatedName ?? tag.name ?? tag.slug,
        count: 0,
      };
      current.count += 1;
      tags.set(key, current);
    }
  }
  return {
    tags: [...tags.values()].sort(
      (left, right) => right.count - left.count || left.label.localeCompare(right.label),
    ),
  };
}

function transitionReview(review, status, now) {
  const current = review.status ?? "pending";
  if (status === current) {
    return review;
  }
  if (!REVIEW_STATUSES.has(status) || !ALLOWED_TRANSITIONS[current]?.has(status)) {
    throw new AppError(
      "INVALID_REVIEW_TRANSITION",
      `不能从 ${current} 切换到 ${status}`,
      { from: current, to: status },
    );
  }

  const next = { ...review, status, updatedAt: now };
  if (status === "paused") {
    next.remainingDaysOnPause = daysUntil(now, review.dueAt);
  } else if (status === "reviewing") {
    if (current === "paused") {
      next.dueAt = addLocalDays(now, review.remainingDaysOnPause ?? 0);
      next.resumedAt = now;
    } else if (current === "graduated" || (current === "ignored" && review.fsrs)) {
      next.dueAt = addLocalDays(now, 0);
      next.resumedAt = now;
    } else if (!review.fsrs) {
      next.dueAt = null;
    }
    next.remainingDaysOnPause = null;
  } else {
    next.remainingDaysOnPause = null;
  }
  return next;
}

function applyActionToQuestion(question, action, now, deviceId) {
  const review = question.review ?? { status: "pending" };
  let nextReview;
  if (action.type === "set_status") {
    nextReview = transitionReview(review, action.status, now);
  } else if (action.type === "join") {
    nextReview = transitionReview(review, "reviewing", now);
  } else if (action.type === "remove") {
    nextReview = transitionReview(review, "ignored", now);
  } else if (action.type === "set_focus") {
    nextReview = { ...review, isFocus: Boolean(action.value), updatedAt: now };
  } else {
    throw new AppError("UNKNOWN_LIBRARY_ACTION", "未知的题库操作");
  }

  return {
    ...question,
    review: { ...nextReview, updatedByDeviceId: deviceId },
  };
}

export function updateQuestions(state, keys, action, { now }) {
  const uniqueKeys = [...new Set(cleanArray(keys))];
  if (uniqueKeys.length === 0) {
    throw new AppError("NO_QUESTIONS_SELECTED", "请至少选择一道题目");
  }
  for (const key of uniqueKeys) {
    if (!state.questions?.[key]) {
      throw new AppError("QUESTION_NOT_FOUND", "题目不存在或已被删除", { key });
    }
  }

  const nextQuestions = { ...state.questions };
  for (const key of uniqueKeys) {
    nextQuestions[key] = applyActionToQuestion(
      nextQuestions[key],
      action,
      now,
      state.device.id,
    );
  }

  return {
    ...state,
    questions: nextQuestions,
  };
}

export function updateNewQuestionMode(state, mode) {
  if (!new Set(["pending", "reviewing"]).has(mode)) {
    throw new AppError("INVALID_NEW_QUESTION_MODE", "新题处理方式不受支持");
  }
  return {
    ...state,
    settings: { ...state.settings, newQuestionMode: mode },
  };
}

export function updateQuestionNote(state, key, note, { now }) {
  const question = state.questions?.[key];
  if (!question) {
    throw new AppError("QUESTION_NOT_FOUND", "题目不存在或已被删除");
  }
  if (typeof note !== "string") {
    throw new AppError("INVALID_QUESTION_NOTE", "复习笔记格式无效");
  }
  const normalized = note.trim();
  if (normalized.length > 5000) {
    throw new AppError("QUESTION_NOTE_TOO_LONG", "复习笔记不能超过 5000 个字符");
  }
  return {
    ...state,
    questions: {
      ...state.questions,
      [key]: {
        ...question,
        note: normalized,
        noteUpdatedAt: now,
      },
    },
  };
}
