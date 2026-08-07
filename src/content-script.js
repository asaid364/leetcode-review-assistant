(() => {
  if (globalThis.__leetcodeReviewContentInstalled) {
    return;
  }
  globalThis.__leetcodeReviewContentInstalled = true;

  const PAGE_SIZE = 100;
  const MAX_PAGES = 60;
  const PAGE_DELAY_MS = 120;
  const REQUEST_TIMEOUT_MS = 20_000;
  const SOLVED_STATUSES = new Set(["SOLVED", "PAST_SOLVED"]);

  const ACCOUNT_QUERY = `
    query globalData {
      userStatus {
        isSignedIn
        username
        realName
        avatar
        userSlug
      }
    }
  `;

  const QUESTION_LIST_QUERY = `
    query problemsetQuestionListV2($filters: QuestionFilterInput, $limit: Int, $skip: Int) {
      problemsetQuestionListV2(filters: $filters, limit: $limit, skip: $skip) {
        questions {
          id
          titleSlug
          title
          translatedTitle
          questionFrontendId
          paidOnly
          difficulty
          topicTags {
            name
            slug
            nameTranslated
          }
          status
        }
        totalLength
        finishedLength
        hasMore
      }
    }
  `;

  const RECENT_ACCEPTED_QUERY = `
    query recentAcSubmissions($userSlug: String!) {
      recentACSubmissions(userSlug: $userSlug) {
        submissionId
        submitTime
        question {
          title
          translatedTitle
          titleSlug
          questionFrontendId
        }
      }
    }
  `;

  class SourceError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "SourceError";
      this.code = code;
      this.details = details;
    }
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function graphql(endpoint, operationName, query, variables = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(new URL(endpoint, location.origin), {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ operationName, query, variables }),
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        throw new SourceError("AUTH_EXPIRED", "力扣登录状态已失效");
      }
      if (!response.ok) {
        throw new SourceError("SOURCE_HTTP_ERROR", "力扣数据请求失败", {
          status: response.status,
        });
      }

      const payload = await response.json();
      if (Array.isArray(payload.errors) && payload.errors.length > 0) {
        const message = payload.errors.map((item) => item.message).filter(Boolean).join("；");
        throw new SourceError(
          "SOURCE_GRAPHQL_ERROR",
          message || "力扣数据结构暂不可用",
        );
      }
      return payload.data;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new SourceError("SOURCE_TIMEOUT", "力扣数据请求超时");
      }
      if (error instanceof SourceError) {
        throw error;
      }
      throw new SourceError("NETWORK_ERROR", "无法连接力扣中国站", {
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function readAccount() {
    const data = await graphql("/graphql/", "globalData", ACCOUNT_QUERY);
    const userStatus = data?.userStatus;
    if (!userStatus?.isSignedIn || !userStatus.userSlug) {
      return {
        isSignedIn: false,
        username: null,
        realName: null,
        avatar: null,
        userSlug: null,
      };
    }
    return {
      isSignedIn: true,
      username: userStatus.username || null,
      realName: userStatus.realName || null,
      avatar: userStatus.avatar || null,
      userSlug: userStatus.userSlug,
    };
  }

  async function readRecentAccepted(userSlug) {
    const data = await graphql(
      "/graphql/noj-go/",
      "recentAcSubmissions",
      RECENT_ACCEPTED_QUERY,
      { userSlug },
    );
    const bySlug = new Map();
    for (const submission of data?.recentACSubmissions ?? []) {
      const slug = submission?.question?.titleSlug;
      const timestamp = Number(submission?.submitTime);
      if (!slug || !Number.isFinite(timestamp)) {
        continue;
      }
      const acceptedAt = new Date(timestamp * 1000).toISOString();
      const existing = bySlug.get(slug);
      if (!existing || acceptedAt > existing) {
        bySlug.set(slug, acceptedAt);
      }
    }
    return bySlug;
  }

  async function readSolvedQuestions(userSlug) {
    const questions = [];
    const failures = [];
    const warnings = [];
    let skip = 0;
    let pageNumber = 0;
    let hasMore = true;
    let recentAccepted = new Map();

    try {
      recentAccepted = await readRecentAccepted(userSlug);
    } catch (error) {
      warnings.push({
        code: error.code || "RECENT_ACCEPTED_UNAVAILABLE",
        message: "近期通过时间暂未读取，题目同步仍会继续",
      });
    }

    while (hasMore) {
      if (pageNumber >= MAX_PAGES) {
        throw new SourceError(
          "SOURCE_PAGE_LIMIT",
          "题目分页超过安全上限，本轮同步已停止",
          { maxPages: MAX_PAGES },
        );
      }

      const data = await graphql(
        "/graphql/",
        "problemsetQuestionListV2",
        QUESTION_LIST_QUERY,
        {
          filters: {
            filterCombineType: "ALL",
            statusFilter: {
              questionStatuses: ["SOLVED"],
              operator: "IS",
            },
          },
          limit: PAGE_SIZE,
          skip,
        },
      );
      const page = data?.problemsetQuestionListV2;
      const pageQuestions = Array.isArray(page?.questions) ? page.questions : null;
      if (!pageQuestions || typeof page?.hasMore !== "boolean") {
        throw new SourceError(
          "SOURCE_SCHEMA_CHANGED",
          "力扣题目列表结构发生变化，本轮同步未写入",
        );
      }
      if (page.hasMore && pageQuestions.length === 0) {
        throw new SourceError(
          "SOURCE_PAGINATION_STALLED",
          "力扣题目分页没有继续前进",
        );
      }

      for (const question of pageQuestions) {
        const status = String(question?.status ?? "").toUpperCase();
        if (!SOLVED_STATUSES.has(status)) {
          continue;
        }
        if (!question?.id && !question?.titleSlug) {
          failures.push({ code: "INVALID_QUESTION_IDENTITY" });
          continue;
        }
        questions.push({
          ...question,
          sourceQuestionId: question.id == null ? null : String(question.id),
          acceptedAt: recentAccepted.get(question.titleSlug) ?? null,
        });
      }

      pageNumber += 1;
      skip += pageQuestions.length;
      hasMore = Boolean(page.hasMore);
      const totalLength = Number(page.totalLength);
      if (
        !hasMore &&
        Number.isFinite(totalLength) &&
        totalLength > 0 &&
        skip < totalLength
      ) {
        throw new SourceError(
          "INCOMPLETE_SNAPSHOT",
          "力扣题目分页提前结束，本轮同步未写入",
          { received: skip, expected: totalLength },
        );
      }
      if (hasMore) {
        await delay(PAGE_DELAY_MS);
      }
    }

    return { questions, failures, warnings, complete: true };
  }

  async function collectSnapshot() {
    const account = await readAccount();
    if (!account.isSignedIn) {
      throw new SourceError("AUTH_REQUIRED", "请先在力扣中国站登录");
    }
    const result = await readSolvedQuestions(account.userSlug);
    return { account, ...result };
  }

  function serializeError(error) {
    return {
      code: error?.code || "SOURCE_ERROR",
      message: error instanceof Error ? error.message : "读取力扣数据失败",
      details: error?.details || {},
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== "leetcode-content") {
      return false;
    }

    const operation =
      message.type === "READ_ACCOUNT"
        ? readAccount()
        : message.type === "COLLECT_SNAPSHOT"
          ? collectSnapshot()
          : Promise.reject(
              new SourceError("UNKNOWN_CONTENT_MESSAGE", "未知的页面读取操作"),
            );

    operation
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
    return true;
  });
})();
