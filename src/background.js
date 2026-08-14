import { AppError, asAppError, serializeError } from "./core/errors.js";
import {
  connectAccountState,
  getNextAutoSyncAt,
  unlinkAccountState,
  updateAutoSyncState,
} from "./core/account.js";
import { recordSyncFailure, synchronize } from "./core/sync-service.js";
import {
  getLibraryFacets,
  queryLibrary,
  updateAutoJoinReacceptedQuestions,
  updateNewQuestionMode,
  updateQuestionNote,
  updateQuestions,
} from "./core/library.js";
import {
  deferTodayTask,
  ensureTodayPlan,
  getPlanSummary,
  getReviewProgress,
  nextReminderAt,
  pauseReviewPlan,
  recalculateTodayPlan,
  resumeReviewPlan,
  shouldSendReviewReminder,
  skipTodayTask,
  submitReviewFeedback,
  updatePlanSettings,
} from "./core/scheduler.js";
import { chromeStateRepository as repository } from "./storage/chrome-storage.js";
import {
  PRIVACY_DISCLOSURE,
  assertAuthorizedDataAccess,
  createExportPayload,
  deletePersonalDataState,
  grantPrivacyConsent,
  hasPrivacyConsent,
  markExported,
  updateOptionalStatistics,
} from "./core/privacy.js";

const AUTO_SYNC_ALARM = "leetcode-review-auto-sync";
const REVIEW_REMINDER_ALARM = "leetcode-review-daily-reminder";
const REVIEW_REMINDER_NOTIFICATION = "leetcode-review-today";
let syncInFlight = null;
let operationQueue = Promise.resolve();

function runExclusive(operation) {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.catch(() => undefined);
  return result;
}

async function saveMutation(transform) {
  return runExclusive(async () => {
    const current = await repository.load();
    const next = await transform(current);
    await repository.save(next);
    return next;
  });
}

async function getLeetCodeTab() {
  const tabs = await chrome.tabs.query({ url: ["https://leetcode.cn/*"] });
  if (tabs.length === 0) {
    throw new AppError(
      "NO_LEETCODE_TAB",
      "请先打开一个力扣中国站标签页",
    );
  }

  return [...tabs].sort((left, right) => {
    if (left.active !== right.active) {
      return left.active ? -1 : 1;
    }
    return (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0);
  })[0];
}

async function sendToLeetCodeTab(type) {
  const tab = await getLeetCodeTab();
  if (!tab.id) {
    throw new AppError("INVALID_TAB", "无法访问当前力扣标签页");
  }

  const message = { target: "leetcode-content", type };
  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["src/content-script.js"],
      });
      response = await chrome.tabs.sendMessage(tab.id, message);
    } catch (injectionError) {
      throw new AppError(
        "CONTENT_SCRIPT_UNAVAILABLE",
        "无法连接力扣页面，请刷新该页面后重试",
        {},
        injectionError,
      );
    }
  }

  if (!response?.ok) {
    throw new AppError(
      response?.error?.code ?? "SOURCE_ERROR",
      response?.error?.message ?? "读取力扣数据失败",
      response?.error?.details ?? {},
    );
  }
  return response.data;
}

function publicState(state) {
  const questionValues = Object.values(state.questions);
  const canAccessData = !state.dataOwnerUserSlug || (
    state.connection.status === "connected" &&
    state.connection.userSlug === state.dataOwnerUserSlug
  );
  return {
    connection: state.connection,
    dataOwnerUserSlug: canAccessData ? state.dataOwnerUserSlug : null,
    questionCount: canAccessData ? questionValues.length : 0,
    availableQuestionCount: canAccessData ? questionValues.filter(
      (question) => question.sourceAvailability === "available",
    ).length : 0,
    conflictCount: canAccessData
      ? questionValues.filter((question) => question.remoteConflict).length
      : 0,
    hasRetainedData: Boolean(state.dataOwnerUserSlug && questionValues.length),
    canAccessData,
    settings: state.settings,
    sync: state.sync,
    privacy: {
      consentAt: state.privacy?.consentAt ?? null,
      lastExportAt: state.privacy?.lastExportAt ?? null,
      lastDeletionAt: state.privacy?.lastDeletionAt ?? null,
    },
  };
}

async function getPublicState() {
  return publicState(await repository.load());
}

async function checkAccount() {
  const account = await sendToLeetCodeTab("READ_ACCOUNT");
  return account;
}

async function connectAccount() {
  const current = await repository.load();
  if (!hasPrivacyConsent(current)) {
    throw new AppError("PRIVACY_CONSENT_REQUIRED", "连接账号前请先阅读并同意数据使用说明");
  }
  const account = await checkAccount();
  const now = new Date().toISOString();
  const nextState = await saveMutation(async (state) =>
    configureAutoSyncAlarm(connectAccountState(state, account, now)),
  );
  return getPublicState();
}

async function syncNow(trigger = "manual") {
  if (syncInFlight) {
    return syncInFlight;
  }

  syncInFlight = runExclusive(() =>
    synchronize({
      repository,
      fetchSnapshot: () => sendToLeetCodeTab("COLLECT_SNAPSHOT"),
      trigger,
      now: new Date().toISOString(),
    }),
  )
    .then(({ event, state }) => ({ event, state: publicState(state) }))
    .finally(() => {
      syncInFlight = null;
    });
  return syncInFlight;
}

function libraryItem(question) {
  return {
    key: question.key,
    sourceQuestionId: question.sourceQuestionId,
    questionFrontendId: question.questionFrontendId,
    title: question.title,
    translatedTitle: question.translatedTitle,
    titleSlug: question.titleSlug,
    difficulty: question.difficulty,
    tags: question.tags,
    paidOnly: question.paidOnly,
    sourceAvailability: question.sourceAvailability,
    acceptedAt: question.acceptedAt,
    acceptedAtSource: question.acceptedAtSource,
    planningBaselineAt: question.planningBaselineAt,
    review: question.review,
  };
}

function questionDetail(question) {
  return {
    ...libraryItem(question),
    note: question.note ?? "",
    noteUpdatedAt: question.noteUpdatedAt ?? null,
    reviewHistory: (question.reviewHistory ?? []).slice().reverse(),
  };
}

async function getLibrary(options) {
  const state = await repository.load();
  assertAuthorizedDataAccess(state);
  const result = queryLibrary(state, options, new Date().toISOString());
  return {
    ...result,
    items: result.items.map(libraryItem),
    facets: getLibraryFacets(state),
  };
}

async function updateLibraryQuestions(keys, action) {
  const now = new Date().toISOString();
  const next = await saveMutation((state) => {
    assertAuthorizedDataAccess(state);
    const updated = updateQuestions(state, keys, action, { now });
    return recalculateTodayPlan(updated, {
      now,
      reason: keys.length > 1 ? "BULK_QUESTION_STATUS_CHANGED" : "QUESTION_STATUS_CHANGED",
    });
  });
  return {
    updatedCount: new Set(keys).size,
    plan: getPlanSummary(next, now),
  };
}

async function updateReviewSettings(values) {
  const now = new Date().toISOString();
  const next = await saveMutation((state) => {
    assertAuthorizedDataAccess(state);
    let updated = state;
    if (values.newQuestionMode !== undefined) {
      updated = updateNewQuestionMode(updated, values.newQuestionMode);
    }
    if (values.autoJoinReacceptedQuestions !== undefined) {
      updated = updateAutoJoinReacceptedQuestions(
        updated,
        values.autoJoinReacceptedQuestions,
      );
    }
    return updatePlanSettings(updated, values, { now });
  });
  return { settings: next.settings, plan: getPlanSummary(next, now) };
}

async function getPlan() {
  const now = new Date().toISOString();
  const state = await saveMutation((current) => {
    assertAuthorizedDataAccess(current);
    return ensureTodayPlan(current, { now });
  });
  const summary = getPlanSummary(state, now);
  const questions = Object.fromEntries(
    (summary.today?.assignments ?? []).flatMap((assignment) => {
      const question = state.questions[assignment.questionKey];
      return question ? [[assignment.questionKey, questionDetail(question)]] : [];
    }),
  );
  return {
    ...summary,
    questions,
    settings: state.settings,
    progress: getReviewProgress(state, now),
  };
}

async function getQuestionDetails(questionKey) {
  const state = await repository.load();
  assertAuthorizedDataAccess(state);
  const question = state.questions?.[questionKey];
  if (!question) throw new AppError("QUESTION_NOT_FOUND", "题目不存在或已被删除");
  return questionDetail(question);
}

async function saveQuestionNote(questionKey, note) {
  const now = new Date().toISOString();
  const state = await saveMutation((current) =>
    updateQuestionNote(assertAuthorizedDataAccess(current), questionKey, note, { now }),
  );
  return questionDetail(state.questions[questionKey]);
}

async function getProgress() {
  const now = new Date().toISOString();
  const state = await saveMutation((current) => {
    assertAuthorizedDataAccess(current);
    return ensureTodayPlan(current, { now });
  });
  const progress = getReviewProgress(state, now);
  const questionKeys = new Set(
    progress.calendar.flatMap((day) =>
      day.assignments.map((assignment) => assignment.questionKey),
    ),
  );
  const questions = Object.fromEntries(
    [...questionKeys].flatMap((key) => {
      const question = state.questions[key];
      return question ? [[key, libraryItem(question)]] : [];
    }),
  );
  return {
    ...progress,
    questions,
    paused: Boolean(state.plan?.pausedAt),
    settings: {
      reminderEnabled: state.settings.reminderEnabled,
      reminderTime: state.settings.reminderTime,
    },
  };
}

async function submitFeedback(message) {
  const now = new Date().toISOString();
  let outcome;
  const state = await saveMutation((current) => {
    assertAuthorizedDataAccess(current);
    const ensured = ensureTodayPlan(current, { now });
    outcome = submitReviewFeedback(ensured, {
      taskId: message.taskId,
      questionKey: message.questionKey,
      rating: message.rating,
      durationMinutes: message.durationMinutes,
      now,
    });
    return outcome.state;
  });
  await clearReviewNotification();
  return {
    record: outcome.record,
    duplicate: outcome.duplicate,
    plan: getPlanSummary(state, now),
  };
}

async function skipTask(taskId) {
  const now = new Date().toISOString();
  const state = await saveMutation((current) =>
    skipTodayTask(ensureTodayPlan(assertAuthorizedDataAccess(current), { now }), { taskId, now }),
  );
  await clearReviewNotification();
  return getPlanSummary(state, now);
}

async function deferTask(taskId) {
  const now = new Date().toISOString();
  const state = await saveMutation((current) =>
    deferTodayTask(ensureTodayPlan(assertAuthorizedDataAccess(current), { now }), { taskId, now }),
  );
  return getPlanSummary(state, now);
}

async function setPlanPaused(paused) {
  const now = new Date().toISOString();
  const state = await saveMutation((current) =>
    paused
      ? pauseReviewPlan(assertAuthorizedDataAccess(current), { now })
      : resumeReviewPlan(assertAuthorizedDataAccess(current), { now }),
  );
  await clearReviewNotification();
  return getPlanSummary(state, now);
}

async function unlinkAccount(mode) {
  await saveMutation(async (state) =>
    configureAutoSyncAlarm(
      unlinkAccountState(state, mode, new Date().toISOString()),
    ),
  );
  return getPublicState();
}

async function updateAutoSync({ enabled, intervalMinutes }) {
  await saveMutation(async (state) =>
    configureAutoSyncAlarm(
      updateAutoSyncState(state, { enabled, intervalMinutes }),
    ),
  );
  return getPublicState();
}

async function getPrivacyInfo() {
  const state = await repository.load();
  return {
    disclosure: PRIVACY_DISCLOSURE,
    consentAt: state.privacy?.consentAt ?? null,
    optionalStatisticsEnabled: state.settings?.optionalStatisticsEnabled !== false,
  };
}

async function consentToPrivacy() {
  const now = new Date().toISOString();
  await saveMutation((state) => grantPrivacyConsent(state, now));
  return getPrivacyInfo();
}

async function exportPersonalData() {
  const now = new Date().toISOString();
  let payload;
  await saveMutation((state) => {
    payload = createExportPayload(state, now);
    return markExported(state, now);
  });
  return payload;
}

async function deletePersonalData(confirmation) {
  const now = new Date().toISOString();
  const next = await saveMutation((state) =>
    deletePersonalDataState(state, now, confirmation),
  );
  await chrome.alarms.clear(AUTO_SYNC_ALARM);
  await chrome.alarms.clear(REVIEW_REMINDER_ALARM);
  await clearReviewNotification();
  return publicState(next);
}

async function updateOptionalStatisticsSetting(enabled) {
  const next = await saveMutation((state) => updateOptionalStatistics(state, enabled));
  return { enabled: next.settings.optionalStatisticsEnabled !== false };
}

async function clearReviewNotification() {
  await chrome.notifications.clear(REVIEW_REMINDER_NOTIFICATION);
}

async function configureReminderAlarm(state) {
  await chrome.alarms.clear(REVIEW_REMINDER_ALARM);
  if (!state.settings.reminderEnabled) {
    await clearReviewNotification();
    return state;
  }
  const when = new Date(
    nextReminderAt(new Date().toISOString(), state.settings.reminderTime),
  ).valueOf();
  await chrome.alarms.create(REVIEW_REMINDER_ALARM, { when });
  return state;
}

async function configureAutoSyncAlarm(state) {
  await chrome.alarms.clear(AUTO_SYNC_ALARM);

  if (!state.settings.autoSyncEnabled || state.connection.status !== "connected") {
    return state.sync.nextAutoSyncAt
      ? { ...state, sync: { ...state.sync, nextAutoSyncAt: null } }
      : state;
  }

  const intervalMinutes = state.settings.autoSyncIntervalMinutes;
  const nextAutoSyncAt = getNextAutoSyncAt(new Date().toISOString(), intervalMinutes);
  await chrome.alarms.create(AUTO_SYNC_ALARM, {
    delayInMinutes: intervalMinutes,
    periodInMinutes: intervalMinutes,
  });
  return {
    ...state,
    sync: { ...state.sync, nextAutoSyncAt },
  };
}

async function reconcileAutoSyncAlarm() {
  return saveMutation((state) => configureAutoSyncAlarm(state));
}

async function reconcileReminderAlarm() {
  return saveMutation((state) => configureReminderAlarm(state));
}

async function reconcileExtensionAlarms() {
  await reconcileAutoSyncAlarm();
  await reconcileReminderAlarm();
}

async function handleAutoSync() {
  const state = await repository.load();
  if (!state.settings.autoSyncEnabled || state.connection.status !== "connected") {
    return;
  }

  try {
    await getLeetCodeTab();
    await syncNow("auto");
  } catch (error) {
    const appError = asAppError(error);
    if (appError.code === "NO_LEETCODE_TAB") {
      await runExclusive(() =>
        recordSyncFailure(repository, appError, {
          trigger: "auto",
          now: new Date().toISOString(),
          status: "deferred",
        }),
      );
    }
  } finally {
    await reconcileAutoSyncAlarm();
  }
}

async function handleReviewReminder() {
  try {
    const now = new Date().toISOString();
    const state = await saveMutation((current) => ensureTodayPlan(current, { now }));
    const summary = getPlanSummary(state, now);
    if (!shouldSendReviewReminder(state, now)) {
      await clearReviewNotification();
      return;
    }
    const pending = summary.today.assignments.filter((item) => item.status === "pending");
    const first = state.questions[pending[0].questionKey];
    const estimate = pending.reduce((sum, item) => sum + item.estimatedMinutes, 0);
    const firstTitle = first?.translatedTitle || first?.title || "今日首题";
    await chrome.notifications.create(REVIEW_REMINDER_NOTIFICATION, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("img/icon-128.png"),
      title: `今日还有 ${pending.length} 道题待复习`,
      message: `预计 ${estimate} 分钟，优先复习：${firstTitle}`,
      priority: 1,
    });
  } finally {
    await reconcileReminderAlarm();
  }
}

async function handleMessage(message) {
  switch (message?.type) {
    case "GET_STATE":
      return getPublicState();
    case "GET_PRIVACY_INFO":
      return getPrivacyInfo();
    case "GRANT_PRIVACY_CONSENT":
      return consentToPrivacy();
    case "EXPORT_PERSONAL_DATA":
      return exportPersonalData();
    case "DELETE_PERSONAL_DATA":
      return deletePersonalData(message.confirmation);
    case "UPDATE_OPTIONAL_STATISTICS":
      return updateOptionalStatisticsSetting(message.enabled);
    case "CHECK_ACCOUNT":
      return checkAccount();
    case "CONNECT_ACCOUNT":
      return connectAccount();
    case "SYNC_NOW":
      return syncNow("manual");
    case "UNLINK_ACCOUNT":
      return unlinkAccount(message.mode);
    case "UPDATE_AUTO_SYNC":
      return updateAutoSync({
        enabled: message.enabled,
        intervalMinutes: Number(message.intervalMinutes),
      });
    case "GET_LIBRARY":
      return getLibrary(message.options ?? {});
    case "UPDATE_QUESTIONS":
      return updateLibraryQuestions(message.keys ?? [], message.action ?? {});
    case "UPDATE_REVIEW_SETTINGS":
      return updateReviewSettings(message.values ?? {}).then(async (result) => {
        await reconcileReminderAlarm();
        return result;
      });
    case "GET_PLAN":
      return getPlan();
    case "SUBMIT_REVIEW_FEEDBACK":
      return submitFeedback(message);
    case "DEFER_TODAY_TASK":
      return deferTask(message.taskId);
    case "SKIP_TODAY_TASK":
      return skipTask(message.taskId);
    case "GET_QUESTION_DETAILS":
      return getQuestionDetails(message.questionKey);
    case "UPDATE_QUESTION_NOTE":
      return saveQuestionNote(message.questionKey, message.note);
    case "GET_PROGRESS":
      return getProgress();
    case "PAUSE_REVIEW_PLAN":
      return setPlanPaused(true);
    case "RESUME_REVIEW_PLAN":
      return setPlanPaused(false);
    case "OPEN_APP":
      await chrome.tabs.create({
        url: `${chrome.runtime.getURL("src/app/index.html")}#${message.view === "progress" ? "progress" : "today"}`,
      });
      return { opened: true };
    case "OPEN_QUESTION": {
      const state = await repository.load();
      const question = state.questions?.[message.questionKey];
      if (!question?.titleSlug) {
        throw new AppError("QUESTION_LINK_UNAVAILABLE", "当前题目没有可用链接");
      }
      await chrome.tabs.create({
        url: `https://leetcode.cn/problems/${encodeURIComponent(question.titleSlug)}/`,
      });
      return { opened: true };
    }
    case "OPEN_LEETCODE":
      await chrome.tabs.create({ url: "https://leetcode.cn/problemset/" });
      return { opened: true };
    default:
      throw new AppError("UNKNOWN_MESSAGE", "未知的扩展操作");
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_SYNC_ALARM) {
    void handleAutoSync();
  } else if (alarm.name === REVIEW_REMINDER_ALARM) {
    void handleReviewReminder();
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId !== REVIEW_REMINDER_NOTIFICATION) return;
  void clearReviewNotification();
  void chrome.tabs.create({ url: `${chrome.runtime.getURL("src/app/index.html")}#today` });
});

chrome.runtime.onInstalled.addListener(() => {
  void reconcileExtensionAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  void reconcileExtensionAlarms();
});
