const elements = Object.fromEntries(
  [
    "today-date", "today-total", "today-completed", "today-rate", "today-capacity",
    "today-estimate", "today-progress-bar", "today-list", "today-empty",
    "today-empty-title", "today-empty-copy", "plan-notice", "plan-pause-button",
    "feedback-result", "feedback-result-title", "feedback-result-next", "feedback-result-close",
    "progress-refresh", "progress-today", "progress-week", "progress-streak",
    "progress-improved", "due-overdue", "due-upcoming", "pressure-copy",
    "review-calendar", "forecast-list", "mastery-list", "distribution-mode", "weakness-list",
    "library-search", "filter-participation", "filter-status", "filter-mastery",
    "filter-difficulty", "filter-tag", "filter-overdue", "library-sort", "library-count",
    "library-list", "library-empty", "bulk-bar", "bulk-action", "bulk-apply",
    "selected-count", "selection-clear", "select-page", "page-prev", "page-next", "page-label",
    "settings-form", "question-limit", "minutes-limit", "new-question-mode",
    "reminder-enabled", "reminder-time", "interview-settings", "interview-date",
    "interview-scope", "interview-values", "capacity-confirmed", "audit-list",
    "optional-statistics-enabled", "export-data-button", "delete-data-button",
    "delete-data-dialog", "delete-data-close", "delete-data-confirmation", "delete-data-confirm", "delete-data-cancel",
    "question-dialog", "detail-number", "detail-title", "detail-close", "detail-meta",
    "detail-open", "detail-status", "detail-note", "note-count", "note-save",
    "detail-history", "calendar-dialog", "calendar-detail-status", "calendar-detail-title",
    "calendar-detail-close", "calendar-detail-summary", "calendar-detail-list", "toast", "toast-message", "toast-retry",
  ].map((id) => [id.replaceAll("-", "_"), document.querySelector(`#${id}`)]),
);
elements.tabs = [...document.querySelectorAll(".tab")];
elements.views = [...document.querySelectorAll(".view")];

const STATUS_LABELS = {
  pending: "待确认", reviewing: "复习中", paused: "暂停",
  graduated: "已毕业", ignored: "忽略",
};
const MASTERY_LABELS = {
  unassessed: "未评估", again: "不会", hard: "模糊", good: "掌握", easy: "熟练",
};
const DIFFICULTY_LABELS = { EASY: "简单", MEDIUM: "中等", HARD: "困难", UNKNOWN: "未知" };
const CHANGE_LABELS = {
  DAILY_PLAN_GENERATED: "生成今日计划",
  PLAN_RECALCULATED: "重新计算计划",
  QUESTION_STATUS_CHANGED: "题目状态变化",
  BULK_QUESTION_STATUS_CHANGED: "批量题目状态变化",
  REVIEW_FEEDBACK_SUBMITTED: "提交复习反馈",
  TASK_DEFERRED: "今日任务稍后处理",
  TASK_SKIPPED: "跳过今日任务",
  PLAN_SETTINGS_UPDATED: "修改计划设置",
  PLAN_PAUSED: "暂停整个计划",
  PLAN_RESUMED: "恢复整个计划",
  INTERVIEW_ENDED: "面试冲刺到期，恢复日常巩固",
};

let planData = null;
let progressData = null;
let libraryData = null;
let currentDetail = null;
let libraryPage = 1;
let searchTimer = null;
const selectedKeys = new Set();
const activeTasks = new Set();

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) {
    const error = new Error(response?.error?.message ?? "扩展操作失败");
    error.code = response?.error?.code;
    throw error;
  }
  return response.data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseLocalDate(value) {
  if (!value) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00`)
    : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function formatDate(value, fallback = "未安排") {
  const date = parseLocalDate(value);
  if (!date) return fallback;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function formatShortDate(value) {
  const date = parseLocalDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

function formatDateTime(value) {
  const date = parseLocalDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function showToast(message, isError = false, retry = null) {
  elements.toast_message.textContent = message;
  elements.toast.classList.toggle("is-error", isError);
  elements.toast_retry.hidden = typeof retry !== "function";
  elements.toast_retry.onclick = typeof retry === "function" ? retry : null;
  elements.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { elements.toast.hidden = true; }, 3500);
}

function switchView(name, { load = true } = {}) {
  for (const tab of elements.tabs) tab.classList.toggle("is-active", tab.dataset.view === name);
  for (const view of elements.views) view.hidden = view.id !== `${name}-view`;
  history.replaceState(null, "", `#${name}`);
  if (!load) return;
  if (name === "library") void loadLibrary();
  if (name === "progress") void loadProgress();
  if (name === "today" || name === "settings") void loadPlan();
}

function statusOptions(status, { includeCurrent = false } = {}) {
  const allowed = {
    pending: [["reviewing", "加入复习"], ["ignored", "设为忽略"]],
    reviewing: [["paused", "暂停"], ["graduated", "设为已毕业"], ["ignored", "移出并忽略"]],
    paused: [["reviewing", "恢复复习"], ["graduated", "设为已毕业"], ["ignored", "设为忽略"]],
    graduated: [["reviewing", "恢复复习"], ["ignored", "设为忽略"]],
    ignored: [["pending", "恢复待确认"], ["reviewing", "恢复并加入"]],
  }[status] ?? [];
  const current = includeCurrent
    ? `<option value="" selected>${escapeHtml(STATUS_LABELS[status] ?? "未知状态")}</option>`
    : '<option value="">修改状态</option>';
  return current + allowed.map(([value, label]) =>
    `<option value="${value}">${escapeHtml(label)}</option>`,
  ).join("");
}

function taskTemplate(assignment, question) {
  const title = question?.translatedTitle || question?.title || "未命名题目";
  const markers = (assignment.reason?.markers ?? [])
    .map((marker) => `<span class="marker">${escapeHtml(marker.text)}</span>`)
    .join("");
  const tags = (question?.tags ?? []).slice(0, 2)
    .map((tag) => tag.translatedName || tag.name || tag.slug)
    .filter(Boolean)
    .join(" / ");
  return `
    <article class="task-row" data-task-id="${escapeHtml(assignment.id)}" data-question-key="${escapeHtml(assignment.questionKey)}">
      <div>
        <div class="task-title-line"><span class="task-number">${escapeHtml(question?.questionFrontendId ?? question?.sourceQuestionId ?? "-")}</span><h2>${escapeHtml(title)}</h2></div>
        <div class="task-meta"><span class="reason">${escapeHtml(assignment.reason?.text ?? "今日任务")}</span>${markers}<span>${escapeHtml(DIFFICULTY_LABELS[question?.difficulty] ?? "未知")}</span>${tags ? `<span>${escapeHtml(tags)}</span>` : ""}<span>预计 ${assignment.estimatedMinutes} 分钟</span>${assignment.deferCount ? `<span>已稍后 ${assignment.deferCount} 次</span>` : ""}</div>
      </div>
      <div class="task-controls">
        <div class="feedback-controls">
          <label class="duration-field">用时<input class="duration-input" type="number" min="3" max="120" value="${assignment.estimatedMinutes}" />分钟</label>
          <button class="rating rating-again" data-rating="again" type="button">不会</button>
          <button class="rating rating-hard" data-rating="hard" type="button">模糊</button>
          <button class="rating rating-good" data-rating="good" type="button">掌握</button>
          <button class="rating rating-easy" data-rating="easy" type="button">熟练</button>
        </div>
        <div class="secondary-actions">
          <button class="task-command" data-command="detail" type="button">详情与笔记</button>
          <button class="task-command" data-command="open" type="button">前往 LeetCode</button>
          <button class="task-command" data-command="defer" type="button">稍后处理</button>
          <button class="task-command" data-command="skip" type="button">跳过</button>
          <select class="status-inline" data-command="status" aria-label="调整题目状态">${statusOptions(question?.review?.status)}</select>
        </div>
      </div>
    </article>`;
}

function nextScheduledCopy(progress) {
  const next = (progress?.forecast ?? []).find((day, index) => index > 0 && day.count > 0);
  return next ? `${formatDate(next.date)} 预计 ${next.count} 题、${next.estimatedMinutes} 分钟。` : "未来 14 天暂无已排定任务。";
}

function renderPlan() {
  if (!planData) return;
  const assignments = planData.today?.assignments ?? [];
  const pending = assignments.filter((item) => item.status === "pending");
  const completed = assignments.filter((item) => item.status === "completed");
  const skipped = assignments.filter((item) => item.status === "skipped");
  const activeTotal = pending.length + completed.length;
  const rate = activeTotal > 0 ? Math.round((completed.length / activeTotal) * 100) : 0;
  const settings = planData.settings;
  elements.today_date.textContent = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "long", day: "numeric", weekday: "long",
  }).format(new Date());
  elements.today_total.textContent = String(activeTotal);
  elements.today_completed.textContent = String(completed.length);
  elements.today_rate.textContent = `${rate}%`;
  elements.today_progress_bar.style.width = `${rate}%`;
  elements.today_capacity.textContent = settings.dailyCapacityMode === "time"
    ? `${settings.dailyMinutesLimit} 分钟` : `${settings.dailyQuestionLimit} 题`;
  elements.today_estimate.textContent = `${pending.reduce((sum, task) => sum + task.estimatedMinutes, 0)} 分钟`;
  elements.plan_pause_button.textContent = planData.paused ? "恢复计划" : "暂停计划";
  elements.plan_pause_button.classList.toggle("button-danger", !planData.paused);

  elements.plan_notice.hidden = true;
  if (planData.paused) {
    elements.plan_notice.hidden = false;
    elements.plan_notice.textContent = `复习计划已于 ${formatDateTime(planData.pausedAt)} 暂停。恢复后将按当前日期重新排期。`;
  } else if (pending.some((item) => item.overTimeCapacity)) {
    elements.plan_notice.hidden = false;
    elements.plan_notice.textContent = "最高优先级题目的预计用时超过今日时间容量，本日仅安排这一题。";
  }

  elements.today_list.innerHTML = pending
    .map((assignment) => taskTemplate(assignment, planData.questions?.[assignment.questionKey]))
    .join("");
  elements.today_empty.hidden = pending.length > 0 || planData.paused;
  if (pending.length === 0 && !planData.paused) {
    if (completed.length > 0) {
      elements.today_empty_title.textContent = `今日 ${completed.length} 道复习已完成`;
      elements.today_empty_copy.textContent = nextScheduledCopy(planData.progress);
    } else if (skipped.length > 0) {
      elements.today_empty_title.textContent = "今日任务已处理";
      elements.today_empty_copy.textContent = `已跳过 ${skipped.length} 道题；它们仍会参与后续排期。`;
    } else {
      elements.today_empty_title.textContent = "今天没有待复习题目";
      elements.today_empty_copy.textContent = nextScheduledCopy(planData.progress);
    }
  }
  renderSettings(settings);
  renderAudit(planData.recentChanges);
}

async function loadPlan() {
  try {
    planData = await send("GET_PLAN");
    progressData = planData.progress;
    renderPlan();
  } catch (error) {
    showToast(`${error.message}，计划数据未更新。`, true, () => void loadPlan());
  }
}

function renderCalendar(days) {
  elements.review_calendar.innerHTML = days.map((day) => {
    const label = day.status === "completed" ? `${day.completed}/${day.count}`
      : day.status === "overdue" ? `${day.count - day.completed} 未完成`
      : day.status === "partial" ? `${day.completed}/${day.count}`
      : day.status === "future" ? `${day.count} 题` : "-";
    return `<button class="calendar-day ${escapeHtml(day.status)}" data-date="${escapeHtml(day.date)}" type="button" title="查看 ${escapeHtml(formatDate(day.date))} 明细" aria-label="查看 ${escapeHtml(formatDate(day.date))} 复习明细"><strong>${escapeHtml(formatShortDate(day.date))}</strong><span>${escapeHtml(label)}</span></button>`;
  }).join("");
}

function calendarStatusLabel(status) {
  return {
    completed: "已完成",
    overdue: "存在未完成任务",
    partial: "部分完成",
    future: "未来计划",
    idle: "无任务",
  }[status] ?? "复习计划";
}

function assignmentStatusLabel(assignment) {
  if (assignment.status === "completed") {
    return assignment.rating ? `已完成 · ${MASTERY_LABELS[assignment.rating] ?? assignment.rating}` : "已完成";
  }
  if (assignment.status === "future") return "计划中";
  return "未完成";
}

function openCalendarDetail(date) {
  const day = progressData?.calendar.find((item) => item.date === date);
  if (!day) return;
  elements.calendar_detail_status.textContent = calendarStatusLabel(day.status);
  elements.calendar_detail_title.textContent = formatDate(day.date);
  elements.calendar_detail_summary.textContent = day.count > 0
    ? `${day.count} 道任务，已完成 ${day.completed} 道`
    : "当天没有安排复习任务";
  elements.calendar_detail_list.innerHTML = day.assignments.length
    ? day.assignments.map((assignment) => {
        const question = progressData.questions?.[assignment.questionKey];
        const title = question?.translatedTitle || question?.title || "题目信息不可用";
        const reason = assignment.reason?.text
          ? assignment.reason.text
          : assignment.completedAt
            ? `完成于 ${formatDateTime(assignment.completedAt)}`
            : "当日计划任务";
        const minutes = assignment.actualMinutes ?? assignment.estimatedMinutes;
        return `<article class="calendar-detail-row" data-question-key="${escapeHtml(assignment.questionKey)}"><div><strong>${escapeHtml(question?.questionFrontendId ?? question?.sourceQuestionId ?? "-")} · ${escapeHtml(title)}</strong><span>${escapeHtml(DIFFICULTY_LABELS[question?.difficulty] ?? "未知")} · ${escapeHtml(reason)}${minutes ? ` · ${minutes} 分钟` : ""}</span></div><span class="calendar-task-status status-${escapeHtml(assignment.status)}">${escapeHtml(assignmentStatusLabel(assignment))}</span><div class="calendar-task-actions"><button class="task-command" data-command="detail" type="button">题目详情</button><button class="task-command" data-command="open" type="button">前往 LeetCode</button></div></article>`;
      }).join("")
    : '<div class="empty-state calendar-detail-empty"><p>该日期没有任务明细。</p></div>';
  if (!elements.calendar_dialog.open) elements.calendar_dialog.showModal();
}

function renderForecast(days) {
  const peak = Math.max(1, ...days.map((day) => day.count));
  elements.forecast_list.innerHTML = days.map((day) => {
    const height = day.count > 0 ? Math.max(4, Math.round((day.count / peak) * 92)) : 3;
    return `<div class="forecast-day" title="${day.estimatedMinutes} 分钟${day.backlog ? `，积压 ${day.backlog} 题` : ""}"><div class="forecast-bar" style="height:${height}px"></div><strong>${day.count}</strong><span>${escapeHtml(formatShortDate(day.date))}</span></div>`;
  }).join("");
}

function distributionRows(items, labelForKey, { mastery = false } = {}) {
  const total = Math.max(1, ...items.map((item) => mastery ? item.count : item.total));
  return items.map((item) => {
    const value = mastery ? item.count : item.weak;
    const denominator = mastery ? total : Math.max(1, item.total);
    const width = Math.round((value / denominator) * 100);
    const detail = mastery ? `${item.count} 题` : `薄弱 ${item.weak} / ${item.total}`;
    return `<div class="distribution-row"><span title="${escapeHtml(labelForKey(item.key))}">${escapeHtml(labelForKey(item.key))}</span><div class="distribution-track"><span style="width:${width}%"></span></div><small>${detail}</small></div>`;
  }).join("");
}

function renderWeakness() {
  if (!progressData) return;
  const mode = elements.distribution_mode.value;
  const items = progressData.distributions?.[mode] ?? [];
  const label = mode === "difficulty"
    ? (key) => DIFFICULTY_LABELS[key] ?? "未知"
    : (key) => key;
  elements.weakness_list.innerHTML = items.length
    ? distributionRows(items, label)
    : `<p class="eyebrow">${progressData.optionalStatisticsEnabled ? "暂无可统计数据" : "非必要统计已关闭"}</p>`;
}

function renderProgress() {
  if (!progressData) return;
  elements.progress_today.textContent = `${progressData.today.rate}%`;
  elements.progress_week.textContent = `${progressData.week.rate}%`;
  elements.progress_streak.textContent = progressData.optionalStatisticsEnabled ? `${progressData.streak} 天` : "已关闭";
  elements.progress_improved.textContent = progressData.optionalStatisticsEnabled ? String(progressData.improvedCount) : "已关闭";
  elements.due_overdue.textContent = String(progressData.due.overdue);
  elements.due_upcoming.textContent = String(progressData.due.upcoming);
  elements.pressure_copy.textContent = progressData.due.overdue > 0
    ? `先处理逾期题，当前未来计划最高积压 ${Math.max(0, ...progressData.forecast.map((day) => day.backlog))} 题。`
    : "当前没有逾期题目，可按今日顺序继续复习。";
  renderCalendar(progressData.calendar);
  renderForecast(progressData.forecast);
  const mastery = ["unassessed", "again", "hard", "good", "easy"]
    .map((key) => ({ key, count: progressData.mastery[key] ?? 0 }));
  elements.mastery_list.innerHTML = distributionRows(mastery, (key) => MASTERY_LABELS[key], { mastery: true });
  renderWeakness();
}

async function loadProgress() {
  try {
    progressData = await send("GET_PROGRESS");
    renderProgress();
  } catch (error) {
    showToast(`${error.message}，进度数据未更新。`, true, () => void loadProgress());
  }
}

function currentLibraryOptions() {
  const [sortBy, sortDirection] = elements.library_sort.value.split(":");
  return {
    search: elements.library_search.value,
    participation: elements.filter_participation.value,
    statuses: elements.filter_status.value ? [elements.filter_status.value] : [],
    masteries: elements.filter_mastery.value ? [elements.filter_mastery.value] : [],
    difficulties: elements.filter_difficulty.value ? [elements.filter_difficulty.value] : [],
    tags: elements.filter_tag.value ? [elements.filter_tag.value] : [],
    overdue: elements.filter_overdue.value,
    sortBy, sortDirection, page: libraryPage, pageSize: 30,
  };
}

function questionTemplate(question) {
  const review = question.review ?? {};
  const title = question.translatedTitle || question.title;
  const tags = (question.tags ?? []).slice(0, 3)
    .map((tag) => tag.translatedName || tag.name || tag.slug).join(" / ") || "无标签";
  const accepted = question.acceptedAt ? formatDate(question.acceptedAt) : "历史完成时间未获取";
  const checked = selectedKeys.has(question.key) ? "checked" : "";
  return `
    <article class="question-row" data-question-key="${escapeHtml(question.key)}">
      <input class="question-check" type="checkbox" aria-label="选择 ${escapeHtml(title)}" ${checked} />
      <div class="question-title"><strong>${escapeHtml(question.questionFrontendId ?? question.sourceQuestionId ?? "-")} · ${escapeHtml(title)}</strong><small>${escapeHtml(tags)}</small></div>
      <div class="question-meta">${escapeHtml(DIFFICULTY_LABELS[question.difficulty] ?? "未知")}<small>完成：${escapeHtml(accepted)}</small></div>
      <div class="status-stack"><span class="status-badge status-${escapeHtml(review.status)}">${escapeHtml(STATUS_LABELS[review.status] ?? "未知")}</span><span>${escapeHtml(MASTERY_LABELS[review.mastery] ?? "未评估")}</span><small>${review.dueAt ? `下次 ${escapeHtml(formatDate(review.dueAt))}` : "尚未排期"}</small>${review.isFocus ? '<span class="focus-label">重点题</span>' : ""}</div>
      <div class="row-actions"><button class="task-command" data-command="detail" type="button">详情</button><button class="task-command" data-command="open" type="button">打开</button><button class="task-command" data-command="focus" type="button">${review.isFocus ? "取消重点" : "标为重点"}</button><select class="status-action" aria-label="修改复习状态">${statusOptions(review.status)}</select></div>
    </article>`;
}

function renderLibrary() {
  if (!libraryData) return;
  elements.library_count.textContent = `${libraryData.total} 道题`;
  elements.library_list.innerHTML = libraryData.items.map(questionTemplate).join("");
  elements.library_empty.hidden = libraryData.items.length > 0;
  elements.page_label.textContent = `第 ${libraryData.page} / ${libraryData.pageCount} 页`;
  elements.page_prev.disabled = libraryData.page <= 1;
  elements.page_next.disabled = libraryData.page >= libraryData.pageCount;
  const pageKeys = libraryData.items.map((item) => item.key);
  elements.select_page.checked = pageKeys.length > 0 && pageKeys.every((key) => selectedKeys.has(key));
  elements.select_page.indeterminate = pageKeys.some((key) => selectedKeys.has(key)) && !elements.select_page.checked;
  updateBulkBar();
  const selectedTag = elements.filter_tag.value;
  elements.filter_tag.innerHTML = '<option value="">全部标签</option>' +
    (libraryData.facets?.tags ?? []).map((tag) =>
      `<option value="${escapeHtml(tag.value)}">${escapeHtml(tag.label)} (${tag.count})</option>`,
    ).join("");
  elements.filter_tag.value = selectedTag;
}

async function loadLibrary() {
  try {
    libraryData = await send("GET_LIBRARY", { options: currentLibraryOptions() });
    libraryPage = libraryData.page;
    renderLibrary();
  } catch (error) {
    showToast(`${error.message}，题库数据未更新。`, true, () => void loadLibrary());
  }
}

function updateBulkBar() {
  elements.selected_count.textContent = String(selectedKeys.size);
  elements.bulk_bar.hidden = selectedKeys.size === 0;
}

async function applyQuestionAction(keys, action, successMessage) {
  try {
    await send("UPDATE_QUESTIONS", { keys, action });
    showToast(successMessage);
    await Promise.all([loadLibrary(), loadPlan()]);
    progressData = null;
  } catch (error) {
    showToast(error.message, true);
  }
}

function actionFromBulk(value) {
  if (value === "join" || value === "remove") return { type: value };
  if (value === "focus" || value === "unfocus") return { type: "set_focus", value: value === "focus" };
  return { type: "set_status", status: value };
}

function renderSettings(settings) {
  if (!settings) return;
  const capacity = document.querySelector(`input[name="capacityMode"][value="${settings.dailyCapacityMode}"]`);
  if (capacity) capacity.checked = true;
  elements.question_limit.value = settings.dailyQuestionLimit;
  elements.minutes_limit.value = settings.dailyMinutesLimit;
  elements.new_question_mode.value = settings.newQuestionMode;
  elements.reminder_enabled.checked = Boolean(settings.reminderEnabled);
  elements.reminder_time.value = settings.reminderTime ?? "20:00";
  elements.reminder_time.disabled = !settings.reminderEnabled;
  const goal = document.querySelector(`input[name="reviewGoal"][value="${settings.reviewGoal}"]`);
  if (goal) goal.checked = true;
  elements.interview_settings.hidden = settings.reviewGoal !== "interview";
  elements.interview_date.value = settings.interview?.date?.slice(0, 10) ?? "";
  elements.interview_scope.value = settings.interview?.scopeType ?? "focus";
  const scopeValues = settings.interview?.scopeType === "selected"
    ? settings.interview.questionKeys : settings.interview?.scopeValues;
  elements.interview_values.value = (scopeValues ?? []).join(", ");
  elements.capacity_confirmed.checked = Boolean(settings.interview?.capacityConfirmed);
  elements.optional_statistics_enabled.checked = settings.optionalStatisticsEnabled !== false;
}

function renderAudit(changes = []) {
  elements.audit_list.innerHTML = changes.length
    ? changes.map((change) => `<div class="audit-item"><time>${escapeHtml(formatDateTime(change.at))}</time><span>${escapeHtml(CHANGE_LABELS[change.reason] ?? change.reason)}</span></div>`).join("")
    : '<div class="audit-item"><span>暂无计划变更记录</span></div>';
}

function renderDetail(question) {
  currentDetail = question;
  const review = question.review ?? {};
  elements.detail_number.textContent = `题目 ${question.questionFrontendId ?? question.sourceQuestionId ?? "-"}`;
  elements.detail_title.textContent = question.translatedTitle || question.title || "未命名题目";
  elements.detail_meta.innerHTML = [
    ["历史完成", question.acceptedAt ? formatDate(question.acceptedAt) : "时间未获取"],
    ["当前状态", STATUS_LABELS[review.status] ?? "未知"],
    ["掌握程度", MASTERY_LABELS[review.mastery] ?? "未评估"],
    ["下次复习", formatDate(review.dueAt)],
  ].map(([label, value]) => `<div><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  elements.detail_status.innerHTML = statusOptions(review.status, { includeCurrent: true });
  elements.detail_note.value = question.note ?? "";
  elements.note_count.textContent = `${elements.detail_note.value.length} / 5000`;
  const history = question.reviewHistory ?? [];
  elements.detail_history.innerHTML = history.length
    ? history.map((record) => `<div class="history-item"><time>${escapeHtml(formatDateTime(record.reviewedAt))}</time><strong>${escapeHtml(MASTERY_LABELS[record.rating] ?? record.rating)}</strong><span>${record.durationMinutes ? `${record.durationMinutes} 分钟 · ` : ""}下次 ${escapeHtml(formatDate(record.nextDueAt))}</span></div>`).join("")
    : '<p class="eyebrow">尚无复习记录</p>';
}

async function openQuestionDetail(questionKey, knownQuestion = null) {
  try {
    const question = knownQuestion?.reviewHistory
      ? knownQuestion
      : await send("GET_QUESTION_DETAILS", { questionKey });
    renderDetail(question);
    if (!elements.question_dialog.open) elements.question_dialog.showModal();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function handleTodayAction(button, row) {
  const taskId = row.dataset.taskId;
  const questionKey = row.dataset.questionKey;
  if (activeTasks.has(taskId)) return;
  if (["detail", "open"].includes(button.dataset.command)) {
    if (button.dataset.command === "detail") {
      await openQuestionDetail(questionKey, planData.questions?.[questionKey]);
    } else {
      await send("OPEN_QUESTION", { questionKey });
    }
    return;
  }

  activeTasks.add(taskId);
  row.classList.add("is-busy");
  try {
    if (button.dataset.rating) {
      const durationMinutes = Number(row.querySelector(".duration-input").value);
      const title = planData.questions?.[questionKey]?.translatedTitle || planData.questions?.[questionKey]?.title || "本题";
      const response = await send("SUBMIT_REVIEW_FEEDBACK", {
        taskId, questionKey, rating: button.dataset.rating, durationMinutes,
      });
      elements.feedback_result_title.textContent = response.duplicate
        ? `${title} 的本次反馈已保存，未重复记录`
        : `${title} · ${MASTERY_LABELS[button.dataset.rating]}已记录`;
      elements.feedback_result_next.textContent = `下次复习：${formatDate(response.record.nextDueAt)}`;
      elements.feedback_result.hidden = false;
      await loadPlan();
    } else if (button.dataset.command === "defer") {
      await send("DEFER_TODAY_TASK", { taskId });
      showToast("已移到今日列表末尾");
      await loadPlan();
    } else if (button.dataset.command === "skip") {
      await send("SKIP_TODAY_TASK", { taskId });
      showToast("已跳过，不会计为完成");
      await loadPlan();
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    activeTasks.delete(taskId);
    row.classList.remove("is-busy");
  }
}

elements.tabs.forEach((tab) => tab.addEventListener("click", () => switchView(tab.dataset.view)));
document.querySelectorAll("[data-view-link]").forEach((button) =>
  button.addEventListener("click", () => switchView(button.dataset.viewLink)),
);

elements.today_list.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  const row = button?.closest(".task-row");
  if (button && row) await handleTodayAction(button, row);
});
elements.today_list.addEventListener("change", async (event) => {
  if (event.target.dataset.command !== "status" || !event.target.value) return;
  const row = event.target.closest(".task-row");
  await applyQuestionAction(
    [row.dataset.questionKey],
    { type: "set_status", status: event.target.value },
    "题目状态已更新",
  );
});
elements.feedback_result_close.addEventListener("click", () => { elements.feedback_result.hidden = true; });
elements.plan_pause_button.addEventListener("click", async () => {
  try {
    const wasPaused = planData?.paused;
    await send(wasPaused ? "RESUME_REVIEW_PLAN" : "PAUSE_REVIEW_PLAN");
    showToast(wasPaused ? "复习计划已恢复" : "复习计划已暂停");
    await loadPlan();
  } catch (error) { showToast(error.message, true); }
});

elements.progress_refresh.addEventListener("click", () => void loadProgress());
elements.distribution_mode.addEventListener("change", renderWeakness);
elements.review_calendar.addEventListener("click", (event) => {
  const day = event.target.closest(".calendar-day");
  if (day) openCalendarDetail(day.dataset.date);
});
elements.calendar_detail_close.addEventListener("click", () => elements.calendar_dialog.close());
elements.calendar_detail_list.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  const row = button?.closest(".calendar-detail-row");
  if (!button || !row) return;
  const questionKey = row.dataset.questionKey;
  if (button.dataset.command === "open") {
    await send("OPEN_QUESTION", { questionKey });
  } else if (button.dataset.command === "detail") {
    elements.calendar_dialog.close();
    await openQuestionDetail(questionKey);
  }
});

elements.library_list.addEventListener("change", async (event) => {
  const row = event.target.closest(".question-row");
  if (!row) return;
  const key = row.dataset.questionKey;
  if (event.target.classList.contains("question-check")) {
    event.target.checked ? selectedKeys.add(key) : selectedKeys.delete(key);
    renderLibrary();
  } else if (event.target.classList.contains("status-action") && event.target.value) {
    await applyQuestionAction([key], { type: "set_status", status: event.target.value }, "题目状态已更新");
  }
});
elements.library_list.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  const row = button?.closest(".question-row");
  if (!button || !row) return;
  const key = row.dataset.questionKey;
  if (button.dataset.command === "detail") await openQuestionDetail(key);
  if (button.dataset.command === "open") await send("OPEN_QUESTION", { questionKey: key });
  if (button.dataset.command === "focus") {
    const question = libraryData.items.find((item) => item.key === key);
    await applyQuestionAction([key], { type: "set_focus", value: !question.review.isFocus }, "重点状态已更新");
  }
});

elements.select_page.addEventListener("change", () => {
  for (const item of libraryData?.items ?? []) {
    elements.select_page.checked ? selectedKeys.add(item.key) : selectedKeys.delete(item.key);
  }
  renderLibrary();
});
elements.selection_clear.addEventListener("click", () => { selectedKeys.clear(); renderLibrary(); });
elements.bulk_apply.addEventListener("click", async () => {
  const value = elements.bulk_action.value;
  if (!value) return showToast("请选择批量操作", true);
  if (value === "interview_selected") {
    switchView("settings", { load: false });
    await loadPlan();
    const interviewGoal = document.querySelector('input[name="reviewGoal"][value="interview"]');
    interviewGoal.checked = true;
    elements.interview_settings.hidden = false;
    elements.interview_scope.value = "selected";
    elements.interview_values.value = [...selectedKeys].join(", ");
    showToast(`已选择 ${selectedKeys.size} 道冲刺题目，请设置日期并确认容量`);
    return;
  }
  if (["remove", "graduated", "ignored"].includes(value) &&
      !window.confirm(`确认对 ${selectedKeys.size} 道题执行该操作？复习历史会保留。`)) return;
  await applyQuestionAction([...selectedKeys], actionFromBulk(value), `已更新 ${selectedKeys.size} 道题`);
  selectedKeys.clear();
  elements.bulk_action.value = "";
});

const filterElements = [
  elements.filter_participation, elements.filter_status, elements.filter_mastery,
  elements.filter_difficulty, elements.filter_tag, elements.filter_overdue, elements.library_sort,
];
filterElements.forEach((control) => control.addEventListener("change", () => {
  libraryPage = 1;
  void loadLibrary();
}));
elements.library_search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { libraryPage = 1; void loadLibrary(); }, 220);
});
elements.page_prev.addEventListener("click", () => { libraryPage -= 1; void loadLibrary(); });
elements.page_next.addEventListener("click", () => { libraryPage += 1; void loadLibrary(); });

elements.detail_close.addEventListener("click", () => elements.question_dialog.close());
elements.detail_open.addEventListener("click", async () => {
  if (currentDetail) await send("OPEN_QUESTION", { questionKey: currentDetail.key });
});
elements.detail_note.addEventListener("input", () => {
  elements.note_count.textContent = `${elements.detail_note.value.length} / 5000`;
});
elements.note_save.addEventListener("click", async () => {
  if (!currentDetail) return;
  elements.note_save.disabled = true;
  try {
    currentDetail = await send("UPDATE_QUESTION_NOTE", {
      questionKey: currentDetail.key,
      note: elements.detail_note.value,
    });
    renderDetail(currentDetail);
    showToast("复习笔记已保存");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.note_save.disabled = false;
  }
});
elements.detail_status.addEventListener("change", async () => {
  if (!currentDetail || !elements.detail_status.value) return;
  const nextStatus = elements.detail_status.value;
  await applyQuestionAction(
    [currentDetail.key],
    { type: "set_status", status: nextStatus },
    "题目状态已更新",
  );
  currentDetail = await send("GET_QUESTION_DETAILS", { questionKey: currentDetail.key });
  renderDetail(currentDetail);
});

document.querySelectorAll('input[name="reviewGoal"]').forEach((radio) =>
  radio.addEventListener("change", () => { elements.interview_settings.hidden = radio.value !== "interview"; }),
);
elements.reminder_enabled.addEventListener("change", () => {
  elements.reminder_time.disabled = !elements.reminder_enabled.checked;
});
elements.settings_form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const reviewGoal = document.querySelector('input[name="reviewGoal"]:checked').value;
  const capacityMode = document.querySelector('input[name="capacityMode"]:checked').value;
  const rawValues = elements.interview_values.value
    .split(/[,，]/).map((value) => value.trim()).filter(Boolean);
  const scopeType = elements.interview_scope.value;
  const date = elements.interview_date.value
    ? new Date(`${elements.interview_date.value}T12:00:00`).toISOString() : null;
  try {
    const response = await send("UPDATE_REVIEW_SETTINGS", {
      values: {
        dailyCapacityMode: capacityMode,
        dailyQuestionLimit: Number(elements.question_limit.value),
        dailyMinutesLimit: Number(elements.minutes_limit.value),
        newQuestionMode: elements.new_question_mode.value,
        reminderEnabled: elements.reminder_enabled.checked,
        reminderTime: elements.reminder_time.value || "20:00",
        reviewGoal,
        interview: {
          date, scopeType,
          scopeValues: scopeType === "selected" ? [] : rawValues,
          questionKeys: scopeType === "selected" ? rawValues : [],
          capacityConfirmed: elements.capacity_confirmed.checked,
        },
      },
    });
    planData = { ...planData, ...response.plan, settings: response.settings };
    renderPlan();
    progressData = null;
    showToast("设置已保存，未完成任务和未来计划已重排");
  } catch (error) { showToast(error.message, true); }
});

elements.optional_statistics_enabled.addEventListener("change", async () => {
  try {
    await send("UPDATE_OPTIONAL_STATISTICS", { enabled: elements.optional_statistics_enabled.checked });
    progressData = null;
    showToast(elements.optional_statistics_enabled.checked ? "非必要统计已开启" : "非必要统计已关闭");
  } catch (error) {
    elements.optional_statistics_enabled.checked = !elements.optional_statistics_enabled.checked;
    showToast(error.message, true);
  }
});

elements.export_data_button.addEventListener("click", async () => {
  elements.export_data_button.disabled = true;
  try {
    const payload = await send("EXPORT_PERSONAL_DATA");
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `leetcode-review-export-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showToast("个人数据已导出");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.export_data_button.disabled = false;
  }
});

elements.delete_data_button.addEventListener("click", () => {
  elements.delete_data_confirmation.value = "";
  elements.delete_data_confirm.disabled = true;
  elements.delete_data_dialog.showModal();
});
elements.delete_data_confirmation.addEventListener("input", () => {
  elements.delete_data_confirm.disabled = elements.delete_data_confirmation.value !== "DELETE";
});
elements.delete_data_close.addEventListener("click", () => elements.delete_data_dialog.close());
elements.delete_data_cancel.addEventListener("click", () => elements.delete_data_dialog.close());
elements.delete_data_confirm.addEventListener("click", async () => {
  elements.delete_data_confirm.disabled = true;
  try {
    await send("DELETE_PERSONAL_DATA", { confirmation: elements.delete_data_confirmation.value });
    elements.delete_data_dialog.close();
    planData = null;
    progressData = null;
    libraryData = null;
    showToast("个人数据已删除");
    switchView("today");
    await loadPlan();
  } catch (error) {
    showToast(error.message, true);
    elements.delete_data_confirm.disabled = false;
  }
});

const today = new Date();
const minInterview = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);
const maxInterview = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 90);
elements.interview_date.min = minInterview.toISOString().slice(0, 10);
elements.interview_date.max = maxInterview.toISOString().slice(0, 10);

const initialView = ["today", "progress", "library", "settings"].includes(location.hash.slice(1))
  ? location.hash.slice(1) : "today";
switchView(initialView);
