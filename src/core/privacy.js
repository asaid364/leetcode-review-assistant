import { AppError } from "./errors.js";
import { createInitialState } from "./state.js";

export const PRIVACY_CONSENT_VERSION = 1;
export const DELETE_CONFIRMATION = "DELETE";

export const PRIVACY_DISCLOSURE = Object.freeze({
  version: PRIVACY_CONSENT_VERSION,
  dataTypes: [
    "力扣账号的最小公开标识（用户 slug、用户名）",
    "已通过题目的题号、标题、难度、标签和可获得的完成时间",
    "本地复习状态、复习反馈历史、计划设置和个人笔记",
  ],
  purposes: [
    "建立本地个人题库并生成复习计划",
    "根据复习反馈计算下次复习时间和进度统计",
    "在用户主动操作时打开对应力扣题目页面",
  ],
  excluded: [
    "不会要求或保存力扣明文密码、Session Cookie、CSRF 值或访问令牌",
    "不会保存提交代码、运行结果，也不会向开发者服务器或第三方分析服务发送数据",
  ],
});

function clone(value) {
  return structuredClone(value);
}

export function hasPrivacyConsent(state) {
  return Boolean(state?.privacy?.consentAt);
}

export function assertAuthorizedDataAccess(state) {
  if (!state?.dataOwnerUserSlug) return state;
  if (
    state.connection?.status !== "connected" ||
    state.connection?.userSlug !== state.dataOwnerUserSlug
  ) {
    throw new AppError(
      "LOCAL_DATA_LOCKED",
      "本地数据已锁定，请重新连接原力扣账号后访问",
    );
  }
  return state;
}

export function grantPrivacyConsent(state, now) {
  return {
    ...state,
    privacy: {
      ...(state.privacy ?? {}),
      consentAt: now,
    },
  };
}

export function updateOptionalStatistics(state, enabled) {
  return {
    ...state,
    settings: {
      ...state.settings,
      optionalStatisticsEnabled: Boolean(enabled),
    },
  };
}

export function createExportPayload(state, now) {
  if (!hasPrivacyConsent(state)) {
    throw new AppError("PRIVACY_CONSENT_REQUIRED", "请先阅读并同意数据使用说明");
  }
  assertAuthorizedDataAccess(state);
  const questions = Object.values(state.questions ?? {}).map((question) => ({
    key: question.key,
    sourceQuestionId: question.sourceQuestionId ?? null,
    questionFrontendId: question.questionFrontendId ?? null,
    title: question.title ?? null,
    translatedTitle: question.translatedTitle ?? null,
    titleSlug: question.titleSlug ?? null,
    difficulty: question.difficulty ?? null,
    tags: clone(question.tags ?? []),
    acceptedAt: question.acceptedAt ?? null,
    acceptedAtSource: question.acceptedAtSource ?? null,
    planningBaselineAt: question.planningBaselineAt ?? null,
    sourceAvailability: question.sourceAvailability ?? "available",
    review: clone(question.review ?? {}),
    reviewHistory: clone(question.reviewHistory ?? []),
    note: question.note ?? "",
    noteUpdatedAt: question.noteUpdatedAt ?? null,
  }));
  return {
    exportVersion: 1,
    exportedAt: now,
    site: "leetcode.cn",
    dataOwnerUserSlug: state.dataOwnerUserSlug ?? null,
    settings: clone(state.settings ?? {}),
    questions,
    plan: clone(state.plan ?? {}),
  };
}

export function markExported(state, now) {
  return {
    ...state,
    privacy: {
      ...(state.privacy ?? {}),
      lastExportAt: now,
    },
  };
}

export function deletePersonalDataState(state, now, confirmation) {
  if (confirmation !== DELETE_CONFIRMATION) {
    throw new AppError(
      "DELETE_CONFIRMATION_REQUIRED",
      `请输入 ${DELETE_CONFIRMATION} 以确认不可逆删除`,
    );
  }
  const reset = createInitialState({ now, deviceId: state.device.id });
  reset.settings = { ...reset.settings, optionalStatisticsEnabled: state.settings?.optionalStatisticsEnabled ?? true };
  reset.privacy = { ...reset.privacy, lastDeletionAt: now };
  return reset;
}

export function redactSensitiveText(value) {
  return String(value ?? "")
    .replace(/(password|passwd|cookie|csrf|token|authorization|session)[^\s,;]*/gi, "$1=[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[REDACTED]");
}
