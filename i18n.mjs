/**
 * UI-string localization (0.15.0).
 *
 * User-visible strings shipped by this plugin follow the host's Language
 * preference — the durable settings namespace "locale" (field "preference",
 * values "zh" | "en") owned by @deepseek-ai/dsh-client-locale, the same value
 * the GUI's Settings → General → Language row writes. This module covers the
 * HOST-side surfaces: dispatch-confirmation cards, the report-back kickoff
 * suffix and the /tasks command metadata. The browser-side header button
 * (client.js) reads the live client locale runtime instead, so it switches
 * language without a restart; host-side strings are resolved per call, so a
 * language switch applies from the next card/kickoff onward (the /tasks
 * description is captured at mount and follows the next plugin remount).
 *
 * Fallback rule: the host side cannot see the browser-language delegation
 * (an absent preference means "follow the browser" on the client), so an
 * absent or unknown preference keeps the historical Chinese strings ("zh").
 *
 * Model-facing surfaces deliberately stay as they are: tool descriptions are
 * the English model contract, the SKILL manual is Chinese, and spawn titles
 * follow the documented MMDD｜类型｜主题 naming convention.
 */

/** Locales this plugin ships UI strings for (mirrors the host's LOCALE_IDS). */
export const UI_LOCALES = ['zh', 'en'];

const STRINGS = {
  zh: Object.freeze({
    confirmApproveLabel: '按计划派发（推荐）',
    confirmDeclineLabel: '暂不派发',
    confirmHeader: '派发确认',
    confirmQuestionDefault: '批准该拆分方案并开始派发？',
    confirmApproveDescription: '总控将按上述方案批量派发任务',
    confirmDeclineDescription: '取消本次派发；在聊天里说明调整意见',
    selectQuestionDefault: (count) => `共 ${count} 个任务，勾选要派发的（未勾选的不派发；可在自定义输入行写调整意见）`,
    selectEmptyFeedback: '未选择任何任务',
    reportBackSuffix: (callerSessionId) => `汇报约定：完成（或确认无法完成）后，用 task_send 把结果摘要发回会话 ${callerSessionId}（内容：结论、产出路径、遗留问题）。若发送失败，把摘要完整写进你的最终回复。`,
    tasksCommandDescription: '查看协调任务与工作流编组（直接查询，不进模型）',
    tasksCommandHint: '[team <名称> | <sessionId>]',
  }),
  en: Object.freeze({
    confirmApproveLabel: 'Dispatch as planned (Recommended)',
    confirmDeclineLabel: 'Not now',
    confirmHeader: 'Dispatch confirmation',
    confirmQuestionDefault: 'Approve this decomposition and start dispatching?',
    confirmApproveDescription: 'The supervisor will batch-dispatch the tasks above',
    confirmDeclineDescription: 'Cancel this dispatch; describe adjustments in chat',
    selectQuestionDefault: (count) => `${count} proposed task(s) — check the ones to dispatch (unchecked are skipped; use the custom input row for adjustments)`,
    selectEmptyFeedback: 'No task selected',
    reportBackSuffix: (callerSessionId) => `Reporting convention: when done (or confirmed blocked), send a result summary back to session ${callerSessionId} via task_send (contents: conclusion, artifact paths, open issues). If sending fails, write the full summary into your final reply.`,
    tasksCommandDescription: 'View coordination tasks and team groupings (direct query, no model turn)',
    tasksCommandHint: '[team <name> | <sessionId>]',
  }),
};

/**
 * Normalize a stored locale preference to a shipped UI locale.
 * Anything other than the exact "en" (absent, unknown, wrong type) keeps the
 * historical Chinese default — never guess a language the plugin cannot ship.
 * @param {unknown} preference - settings `locale.preference` value
 * @returns {'zh'|'en'}
 */
export function resolveUiLocale(preference) {
  return preference === 'en' ? 'en' : 'zh';
}

/**
 * The UI-string dictionary for one locale.
 * @param {'zh'|'en'|undefined} locale - resolved UI locale
 * @returns the frozen string dictionary (zh for anything unrecognized)
 */
export function uiStrings(locale) {
  return STRINGS[locale === 'en' ? 'en' : 'zh'];
}
