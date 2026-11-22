/**
 * dsh-find-history — client half.
 *
 * Adds one icon to the sidebar's Workspaces header row, next to the shipped
 * session search and view controls. Pressing it turns the sidebar itself into
 * a search surface: the field and the results replace the session list in
 * place, so the answer stays inside the sidebar instead of floating above it.
 * The Host half next to this file does the searching.
 *
 * The header row and the list area belong to the shipped Workspace browser and
 * expose no public slot, so both are portals: the icon is the row's last child
 * (the row is already a flex container, so the button inherits its spacing,
 * hover surface and clipping), and the search surface is a block appended to
 * the browser container and laid out under that row. While the surface is open
 * one attribute on the container hides the shipped list and the shipped header
 * controls, so the two never fight for the same space. A MutationObserver
 * re-attaches both portals when the sidebar remounts, and everything
 * disappears with the plugin, leaving the sidebar as shipped.
 */
window.__ModuleLoader__.load({
	id: "dsh-find-history",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { useCallback, useEffect, useMemo, useRef, useState } = React;
		const { createPortal } = require("react-dom");
		const h = React.createElement;

		const NS = "find-history";
		const STYLE_ID = "dsh-find-history-style";
		const TRIGGER_ATTRIBUTE = "data-dsh-find-history";
		/** Set on the shipped browser container while the search surface is open. */
		const INLINE_ATTRIBUTE = "data-dsh-find-history-open";
		/** Exact route registered by the Host half. */
		const ROUTE = "/dsh-find-history/search";
		/** Keystroke settling before a request, so a typed word is one search. */
		const DEBOUNCE_MS = 260;
		/** Sessions requested per answer; the Host merges keywords before slicing. */
		const RESULT_LIMIT = 24;
		/** A first-ever search builds the Host index; say so when it takes a while. */
		const SLOW_SEARCH_MS = 2500;
		/** How often a ready answer is refreshed while the index still lags behind. */
		const PENDING_POLL_MS = 1_500;
		/** Answers reused while the user edits keywords; the Host caches for 20s too. */
		const ANSWER_TTL_MS = 20000;
		const ANSWER_CACHE_MAX = 40;
		/** Below this the surface shows the hint instead of results. */
		const MIN_QUERY_LENGTH = 1;
		/** Same cap as the Host, so a long paste is visibly capped instead of silently cut. */
		const MAX_QUERY_CHARS = 300;
		/** Remembered keywords: ↑ pages through them one at a time. */
		const HISTORY_MAX = 10;
		const HISTORY_KEY = "dsh-find-history:queries.v1";
		/** Selectors into the shipped sidebar: hashed CSS-module names, matched by suffix. */
		const HEADER_SELECTOR = '[class*="sectionHeader"]';
		const SEARCH_SLOT_SELECTOR = '[class*="searchSlot"]';
		const HEADER_ACTIONS_SELECTOR = '[class*="headerActions"]';
		const TRIGGER_SLOT_CLASS = "shs-slot";
		/** Our own expanding search row: the shipped header has no slot for it. */
		const FIELD_SLOT_CLASS = "shs-search";
		/** Set on the shipped header row while the search row is expanded. */
		const HEADER_OPEN_ATTRIBUTE = "data-dsh-find-history-expanded";
		const LABEL_SELECTOR = '[class*="sectionLabel"]';

		const CSS = `
.shs-trigger{box-sizing:border-box;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;flex:none;justify-content:center;align-items:center;width:28px;height:28px;padding:0;display:inline-flex}
.shs-trigger:hover,.shs-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.shs-trigger:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
::highlight(dsh-shs-hit){background-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 46%, transparent);border-radius:2px}
.shs-trigger svg{flex:none;width:16px;height:16px}
.shs-slot{display:flex;flex:none;align-items:center;max-width:28px;margin-left:auto;overflow:hidden;transition:max-width 180ms var(--ds-ease-in-out),opacity 120ms var(--ds-ease-in-out)}
[class*="sectionHeader"]:not(:has([class*="searchSlotExpanded"])) > [class*="searchSlot"]{margin-left:0}
[class*="sectionHeader"]:has([class*="searchSlotExpanded"]) .shs-slot{max-width:0;opacity:0;pointer-events:none}
[class*="_rail"] .shs-trigger,[class*="_rail"] .shs-search,[class*="_rail"] .shs-inline{display:none}
[data-dsh-find-history-open] [data-sidebar-list-area],[data-dsh-find-history-open] [class*="listArea"]{display:none!important}
[data-dsh-find-history-open]{height:100cqh;max-height:100cqh}
[class*="sectionHeader"]:has(> .shs-slot){transition:margin-right 180ms var(--ds-ease-in-out),padding-inline 180ms var(--ds-ease-in-out),gap 180ms var(--ds-ease-in-out)}
[class*="sectionHeader"]:has(> .shs-slot):has(> .shs-search)[data-dsh-find-history-expanded]{margin-right:0;padding-inline:calc(var(--dsh-sidebar-paint-inset,3px) + 1px);gap:0;overflow:hidden}
[class*="sectionHeader"]:has(> .shs-slot)[data-dsh-find-history-expanded] > .shs-slot{max-width:0;opacity:0;pointer-events:none}
[class*="sectionHeader"]:has(> .shs-slot)[data-dsh-find-history-expanded] > [class*="searchSlot"]{max-width:0;min-width:0;padding-left:0;overflow:hidden;pointer-events:none}
[class*="sectionHeader"]:has(> .shs-slot)[data-dsh-find-history-expanded] > [class*="headerActions"]{max-width:0;min-width:0;opacity:0;transform:translateX(4px);visibility:hidden;pointer-events:none;overflow:hidden;transition-delay:0s,0s,0s,180ms}
[class*="sectionHeader"]:has(> .shs-slot)[data-dsh-find-history-expanded] [class*="sectionLabel"]{max-width:0;margin-right:-4px;opacity:0;transform:translateX(-4px);visibility:hidden;transition-delay:0s,0s,0s,0s,180ms}
.shs-search{box-sizing:border-box;flex:1 1 0;min-width:0;max-width:0;margin-left:-4px;display:flex;align-items:center;overflow:hidden;transition:max-width 180ms var(--ds-ease-in-out),margin-left 180ms var(--ds-ease-in-out)}
[class*="sectionHeader"]:has(> .shs-slot)[data-dsh-find-history-expanded] > .shs-search{max-width:100%;margin-left:0}
.shs-inline{box-sizing:border-box;position:relative;flex:1 1 0%;min-height:0;display:flex;flex-direction:column;gap:6px;padding:6px 0 4px 4px;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
@media (pointer:coarse){.shs-input{font-size:16px}}
@media (prefers-reduced-motion:reduce){.shs-search,.shs-slot,[class*="sectionHeader"]:has(> .shs-slot){transition:none}}

.shs-field{box-sizing:border-box;flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:2px;height:32px;padding:0 4px 0 0;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-caption);overflow:hidden}
.shs-field>svg{flex:none;width:14px;height:14px;margin:0 6px 0 8px}
.shs-input{flex:1;min-width:0;margin:0 0 0 -2px;padding:0;border:none;outline:none;background:0 0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;font-family:inherit}
.shs-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.shs-clear{display:inline-flex;flex:none;justify-content:center;align-items:center;width:24px;height:24px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer}
.shs-clear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.shs-clear svg{width:12px;height:12px}
.shs-fields{flex:none;display:flex;align-items:center;flex-wrap:wrap;gap:6px;row-gap:4px;padding:0 2px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.shs-check{display:inline-flex;align-items:center;gap:4px;cursor:pointer;user-select:none;white-space:nowrap}
.shs-check input{width:12px;height:12px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}
.shs-status{flex:none;padding:0 2px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.shs-status[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.shs-list{flex:1 1 auto;min-height:0;margin:0;padding:0 0 4px;list-style:none;display:flex;flex-direction:column;gap:1px;overflow-y:auto;overscroll-behavior:contain}
.shs-row{box-sizing:border-box;width:100%;display:flex;flex-direction:column;align-items:stretch;gap:1px;margin:0;padding:6px;border:none;border-radius:var(--dsw-radius-sm);background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer}
.shs-row[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover)}
.shs-row:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.shs-row-head{display:flex;align-items:center;gap:6px;min-width:0}
.shs-row-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-weight:500}
.shs-row-snippet{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.shs-badge{flex:none;max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 5px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px}
.shs-hit{margin:0;padding:0;background:0 0;color:var(--dsw-alias-state-business-primary);font-weight:500}
.shs-row-meta{display:flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.shs-empty{flex:none;padding:18px 8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-align:center}
.shs-empty-note{margin-top:6px;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.shs-bar{flex:none;display:flex;align-items:center;gap:6px;min-width:0;padding:0 2px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.shs-select{box-sizing:border-box;min-width:0;flex:0 1 auto;max-width:120px;height:22px;padding:0 4px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}
.shs-chip{flex:none;box-sizing:border-box;height:22px;min-width:20px;padding:0 4px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer}
.shs-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.shs-chip[data-on="true"]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary)}
.shs-spacer{flex:1 1 auto}
.shs-note{flex:none;color:var(--dsw-alias-label-tertiary)}
.shs-whole{display:inline-block;padding-bottom:1px;border-bottom:1.5px solid currentColor;font-size:11px;line-height:12px;letter-spacing:.2px}
.shs-field .shs-chip{height:20px;min-width:18px;padding:0 3px;border:none;background:0 0;font-size:10px;line-height:18px}
.shs-field .shs-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.shs-tool{display:inline-flex;flex:none;justify-content:center;align-items:center;width:20px;height:20px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.shs-tool:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.shs-tool[data-on="true"]{color:var(--dsw-alias-state-business-primary)}
.shs-tool svg{width:14px;height:14px}
.shs-tip{position:fixed;z-index:1200;box-sizing:border-box;width:328px;padding:9px 11px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);font-size:12px;line-height:19px;word-break:break-word;pointer-events:none;white-space:pre-wrap}
.shs-tip-body{white-space:pre-wrap;line-height:19px}
.shs-picker{position:absolute;top:30px;right:6px;z-index:6;display:flex;flex-direction:column;gap:2px;min-width:156px;max-height:240px;padding:5px;overflow:auto;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);box-shadow:var(--dsw-elevation-panel,0 8px 24px rgba(0,0,0,.18))}
.shs-pick-item{display:flex;align-items:center;gap:7px;width:100%;height:27px;padding:0 8px;border:none;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.shs-pick-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.shs-pick-item[data-on="true"]{color:var(--dsw-alias-state-business-primary)}
.shs-pick-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.shs-pick-box{display:inline-flex;flex:none;justify-content:center;align-items:center;width:13px;height:13px;border-radius:3px;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-state-business-primary)}
.shs-pick-item[data-on="true"] .shs-pick-box{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent)}
.shs-pick-box svg{width:11px;height:11px}
.shs-group{display:flex;flex-direction:column;gap:1px;padding:2px 0 4px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.shs-group-head{display:flex;align-items:center;gap:6px;min-width:0;padding:2px 6px 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.shs-group-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500}
.shs-more{flex:none;margin:4px 0 0;height:26px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.shs-more:hover{background:var(--dsw-alias-interactive-bg-hover)}
.shs-results{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:2px;overflow:hidden}
.shs-more:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
`;

		/** Shim the stylesheet once per plugin lifetime. */
		function ensureStyle() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		// --------------------------------------------------------------- locale

		const zh = {
			trigger: "查找历史",
			dialogTitle: "查找历史",
			placeholder: "搜索对话内容",
			hint: "搜索你在任意工作区输入过的内容，找回那个会话继续聊。",
			searching: "搜索中…",
			indexing: "正在更新全文索引，关键词常见时会慢一些…",
			building: "还有 {count} 个会话在后台建索引",
			count: "找到 {count} 组",
			countSessions: "找到 {count} 个会话",
			truncated: "共 {count} 个，显示前 {shown} 个",
			noResults: "没有找到包含这些关键词的会话",
			approximate: "没有精确结果，以下是近似匹配",
			approximateHint: "没有精确结果时按查询片段的覆盖率放宽匹配",
			truncatedQuery: "关键词超过 300 字符，已截断",
			truncatedMessages: "部分超长消息只索引了头尾",
			error: "搜索失败，请重试",
			untitled: "未命名会话",
			searchLabel: "搜索：",
			fieldInput: "输入",
			fieldOutput: "输出",
			kindOutput: "输出",
			sortTime: "按时间排序",
			sortRelevance: "按相关性排序",
			workspaceLabel: "工作区",
			workspaceAll: "全部工作区",
			groupToggle: "按会话分组",
			caseSensitive: "区分大小写",
			wholeWord: "整词匹配",
			regex: "正则表达式",
			partial: "已显示 {shown} / 共 {count} 组",
			partialSessions: "已显示 {shown} / 共 {count} 个会话",
			loadMore: "加载更多",
			invalidRegex: "正则表达式无效",
			groupCount: "{count} 条命中",
			groupCountPartial: "{count} 条命中，显示前 {shown} 条",
			clear: "清除关键词",
			historyHint: "按 ↑ 回看最近搜过的关键词（最多 10 条）",
			justNow: "刚刚",
			minutesAgo: "{minutes} 分钟前",
			hoursAgo: "{hours} 小时前",
			daysAgo: "{days} 天前",
		};

		const en = {
			trigger: "Search session history",
			dialogTitle: "Session history search",
			placeholder: "Search conversations",
			hint: "Search what you typed in any Workspace and pick the conversation up again.",
			searching: "Searching…",
			indexing: "Updating the full-text index; common keywords take longer…",
			building: "{count} conversations are still being indexed",
			count: "{count} groups found",
			countSessions: "{count} conversations found",
			truncated: "{count} found, showing the first {shown}",
			noResults: "No conversation contains these keywords",
			approximate: "No exact match; showing approximate matches",
			approximateHint: "When nothing matches exactly, results are relaxed by how much of the query they carry",
			truncatedQuery: "The query was cut to 300 characters",
			truncatedMessages: "Some very long messages are indexed by their ends only",
			error: "Search failed, please retry",
			untitled: "Untitled conversation",
			searchLabel: "Search:",
			fieldInput: "input",
			fieldOutput: "answers",
			kindOutput: "Answer",
			sortTime: "Sort by time",
			sortRelevance: "Sort by relevance",
			workspaceLabel: "Workspace",
			workspaceAll: "All Workspaces",
			groupToggle: "Group by conversation",
			caseSensitive: "Match case",
			wholeWord: "Match whole word",
			regex: "Regular expression",
			partial: "Showing {shown} of {count} groups",
			partialSessions: "Showing {shown} of {count} conversations",
			loadMore: "Load more",
			invalidRegex: "Invalid regular expression",
			groupCount: "{count} hits",
			groupCountPartial: "{count} hits, showing the first {shown}",
			historyHint: "Press ↑ to reuse a recent keyword (up to 10)",
			clear: "Clear keywords",
			justNow: "just now",
			minutesAgo: "{minutes} min ago",
			hoursAgo: "{hours} h ago",
			daysAgo: "{days} d ago",
		};

		/**
		 * Fill `{name}` placeholders; the locale service may already have done it,
		 * in which case there is nothing left to replace.
		 * @param {string} text - locale template.
		 * @param {object | undefined} params - interpolation values.
		 */
		function interpolate(text, params) {
			if (params === undefined) return text;
			return text.replace(/\{(\w+)\}/gu, (match, key) =>
				params[key] === undefined ? match : String(params[key]),
			);
		}

		/**
		 * @param {(key: string, params?: object) => string} [translate] - slot locale translator.
		 */
		function createTranslator(translate) {
			const base = typeof translate === "function" ? translate : (key) => key;
			return (key, params) => interpolate(base(key, params), params);
		}

		// ----------------------------------------------------------------- icons

		// 放大镜里加一副钟针：既点明「搜历史」，又和标题行自带的放大镜区分开。
		const ICON = h(
			"svg",
			{
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				strokeWidth: 1.35,
				strokeLinecap: "round",
				strokeLinejoin: "round",
			},
			h("circle", { cx: 6.9, cy: 6.9, r: 4.35, stroke: "currentColor" }),
			h("path", { d: "M10.2 10.2 13.9 13.9", stroke: "currentColor", strokeWidth: 1.5 }),
			h("path", { d: "M6.9 4.55v2.35l1.8 1.1", stroke: "currentColor", strokeWidth: 1.25 }),
		);

		const ICON_CLEAR = h(
			"svg",
			{
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				strokeWidth: 1.4,
				strokeLinecap: "round",
			},
			h("path", { d: "M4 4l8 8M12 4l-8 8", stroke: "currentColor" }),
		);

		const CHECK = h(
			"svg",
			{
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
			},
			h("path", { d: "M3.2 8.6 6.3 11.6 12.8 4.6", stroke: "currentColor" }),
		);

		const ICON_WORKSPACE = h(
			"svg",
			{
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				strokeWidth: 1.35,
				strokeLinecap: "round",
				strokeLinejoin: "round",
			},
			h("path", {
				d: "M2.2 5.2c0-.72.56-1.3 1.25-1.3h2.3l1.2 1.4h5.6c.7 0 1.25.58 1.25 1.3v5.1c0 .72-.56 1.3-1.25 1.3H3.45c-.7 0-1.25-.58-1.25-1.3Z",
				stroke: "currentColor",
			}),
		);

		const ICON_GROUP = h(
			"svg",
			{
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				strokeWidth: 1.35,
				strokeLinecap: "round",
			},
			h("path", { d: "M2.8 3.9h10.4", stroke: "currentColor" }),
			h("path", { d: "M4.9 8h6.2M4.9 12.1h6.2", stroke: "currentColor" }),
		);

		const ICON_SORT_TIME = h(
			"svg",
			{
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				strokeWidth: 1.35,
				strokeLinecap: "round",
				strokeLinejoin: "round",
			},
			h("path", { d: "M2.6 4.4h6.2M2.6 8h4.6M2.6 11.6h3", stroke: "currentColor" }),
			h("path", { d: "M12 4.4v7.2M10.3 9.9 12 11.6l1.7-1.7", stroke: "currentColor" }),
		);

		const ICON_SORT_REL = h(
			"svg",
			{
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				strokeWidth: 1.5,
				strokeLinecap: "round",
			},
			h("path", { d: "M3.5 12.5V8.5M8 12.5V4M12.5 12.5V6.5", stroke: "currentColor" }),
		);

		// -------------------------------------------------------------- sidebar

		/**
		 * Find the sidebar's Workspaces header row. The shipped component renders
		 * hashed CSS-module classes, so the row is identified by the label suffix
		 * rather than by a data attribute it does not have.
		 * @returns {HTMLElement | null} the row, or null while the sidebar is absent.
		 */
		function findWorkspaceHeader() {
			if (typeof document === "undefined") return null;
			const candidates = document.querySelectorAll(HEADER_SELECTOR);
			let fallback = null;
			for (const candidate of candidates) {
				if (!(candidate instanceof HTMLElement)) continue;
				if (fallback === null) fallback = candidate;
				if (candidate.querySelector(LABEL_SELECTOR) !== null) return candidate;
			}
			return fallback;
		}

		/**
		 * Keep a flex slot of our own in the header, right before the shipped
		 * search icon: the row renders that icon inside a pedestrian wrapper, so
		 * the trigger cannot be placed first through the icon cluster.
		 * @param header - tracked header row, or null while absent.
		 * @returns {HTMLElement | null} slot to portal the trigger into.
		 */
		function useTriggerSlot(header) {
			const [slot, setSlot] = useState(null);
			useEffect(() => {
				if (header === null) {
					setSlot(null);
					return undefined;
				}
				let element = header.querySelector(`:scope > .${TRIGGER_SLOT_CLASS}`);
				if (element === null) {
					element = document.createElement("span");
					element.className = TRIGGER_SLOT_CLASS;
					const search = header.querySelector(`:scope > ${SEARCH_SLOT_SELECTOR}`);
					header.insertBefore(element, search ?? null);
				}
				setSlot(element);
				return () => {
					element?.remove();
					setSlot(null);
				};
			}, [header]);
			return slot;
		}

		/**
		 * Keep the expanding search row as the header's last child, so it can grow
		 * across the row the same way the shipped inline search does. The element
		 * stays mounted while collapsed (max-width 0) so opening and closing are
		 * CSS transitions instead of a mount/unmount pop.
		 * @param header - tracked header row, or null while absent.
		 * @returns {HTMLElement | null} slot to portal the search field into.
		 */
		function useFieldSlot(header) {
			const [slot, setSlot] = useState(null);
			useEffect(() => {
				if (header === null) {
					setSlot(null);
					return undefined;
				}
				let element = header.querySelector(`:scope > .${FIELD_SLOT_CLASS}`);
				if (element === null) {
					element = document.createElement("div");
					element.className = FIELD_SLOT_CLASS;
					element.setAttribute("role", "search");
					header.appendChild(element);
				}
				setSlot(element);
				return () => {
					element?.remove();
					setSlot(null);
				};
			}, [header]);
			return slot;
		}

		/**
		 * Track the sidebar header row across sidebar remounts. Watching every
		 * mutation would run a document query on each streamed token, so the
		 * observer only reacts once the tracked row has detached.
		 */
		function useWorkspaceHeader() {
			const [header, setHeader] = useState(() => findWorkspaceHeader());
			const headerRef = useRef(header);
			headerRef.current = header;
			useEffect(() => {
				if (typeof document === "undefined") return undefined;
				let scheduled = false;
				const resolve = () => {
					const next = findWorkspaceHeader();
					setHeader((previous) => (previous === next ? previous : next));
				};
				const observer = new MutationObserver(() => {
					const current = headerRef.current;
					if (current !== null && current.isConnected) return;
					if (scheduled) return;
					scheduled = true;
					requestAnimationFrame(() => {
						scheduled = false;
						resolve();
					});
				});
				observer.observe(document.body, { childList: true, subtree: true });
				resolve();
				return () => observer.disconnect();
			}, []);
			return header;
		}

		// -------------------------------------------------------------- surface

		/** Dismiss the search surface on an outside pointer press or Escape. */
		function useDismiss(open, close, triggerRef, surfaceRef, fieldRef) {
			useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					const target = event.target;
					if (!(target instanceof Node)) return;
					if (triggerRef.current?.contains(target) === true) return;
					if (surfaceRef.current?.contains(target) === true) return;
					// The field lives in the shipped header row, outside the surface.
					if (fieldRef?.current?.contains(target) === true) return;
					close();
				};
				const onKeyDown = (event) => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					close();
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown, true);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown, true);
				};
			}, [open, close, triggerRef, surfaceRef, fieldRef]);
		}

		// ------------------------------------------------------------- formatting

		function escapeRegExp(text) {
			return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
		}

		/**
		 * Wrap the matched text inside an excerpt. The Host sends the exact
		 * substring that matched (`focus`), which is also correct for regex and
		 * relaxed hits where the query text is not present verbatim.
		 * @param {string} text - plain-text excerpt.
		 * @param {string} focus - matched substring, as it appears in the message.
		 */
		function highlight(text, focus) {
			if (typeof text !== "string" || text === "") return text;
			if (typeof focus !== "string" || focus === "") return text;
			const parts = text.split(new RegExp(`(${escapeRegExp(focus)})`, "giu"));
			return parts.map((part, index) =>
				index % 2 === 1
					? h("mark", { key: index, className: "shs-hit" }, part)
					: part,
			);
		}

		/**
		 * Slide the excerpt window onto the match so a one-line row shows it
		 * instead of the message opening.
		 * @param text - plain-text excerpt, either side already elided.
		 * @param focus - matched substring, as it appears in the message.
		 */
		function focusExcerpt(text, focus) {
			if (typeof text !== "string" || text === "") return "";
			if (typeof focus !== "string" || focus === "") return text;
			const flat = text.replaceAll("**", "").replaceAll("`", "");
			const index = flat.toLowerCase().indexOf(focus.toLowerCase());
			// A one-line row shows roughly its first two dozen characters, so the
			// keyword has to land near the start or the clamp hides it.
			if (index <= 8) return flat;
			return `…${flat.slice(Math.max(0, index - 6))}`;
		}

		/**
		 * First prose run of a message body: a Session without a title may open
		 * with a JSON payload, which reads as noise in the title position.
		 * @param text - plain-text message excerpt.
		 * @returns {string} the first run with enough letters, or "".
		 */
		function proseChunk(text) {
			if (typeof text !== "string" || text === "") return "";
			const stripped = text.replace(/[{}[\]"]/gu, " ");
			for (const part of stripped.split(/[,:;|\uFF0C\uFF1A\uFF1B]/u)) {
				const clean = part.replace(/\s+/gu, " ").trim();
				if (clean.replace(/[^\p{L}\p{N}]/gu, "").length >= 6) return clean;
			}
			return "";
		}

		/** First sentence of an excerpt, used when a Session has no title. */
		function firstLine(text, limit) {
			if (typeof text !== "string") return "";
			const flat = text.replace(/\s+/gu, " ").trim();
			return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
		}

		/** Compact age of the matching message. */
		function formatAge(time, t) {
			const value = typeof time === "number" ? time : Date.parse(String(time));
			if (!Number.isFinite(value)) return "";
			const age = Date.now() - value;
			if (age < 0) return "";
			const minute = 60_000;
			const hour = 60 * minute;
			const day = 24 * hour;
			if (age < minute) return t("justNow");
			if (age < hour) return t("minutesAgo", { minutes: Math.floor(age / minute) });
			if (age < day) return t("hoursAgo", { hours: Math.floor(age / hour) });
			if (age < 30 * day) return t("daysAgo", { days: Math.floor(age / day) });
			return new Date(value).toLocaleDateString();
		}

		/**
		 * Keywords this browser remembers from earlier searches, newest first.
		 * Storage that is blocked or full yields an empty list instead of an error.
		 * @returns {string[]} remembered keywords, at most {@link HISTORY_MAX}.
		 */
		function readHistory() {
			if (typeof window === "undefined") return [];
			try {
				const raw = window.localStorage.getItem(HISTORY_KEY);
				if (raw === null) return [];
				const parsed = JSON.parse(raw);
				if (!Array.isArray(parsed)) return [];
				const kept = [];
				for (const item of parsed) {
					if (typeof item !== "string") continue;
					const text = item.trim();
					if (text === "" || kept.includes(text)) continue;
					kept.push(text);
					if (kept.length >= HISTORY_MAX) break;
				}
				return kept;
			} catch {
				return [];
			}
		}

		/**
		 * Persist the remembered keywords; a failed write keeps them for this page.
		 * @param {string[]} list - keywords, newest first.
		 */
		function writeHistory(list) {
			if (typeof window === "undefined") return;
			try {
				window.localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
			} catch {}
		}

		// ------------------------------------------------------------- component

		/**
		 * Build the slot component against the Client context.
		 * @param ctx - Client context of this plugin.
		 */
		function createComponent(ctx) {
			/** Resolve a Client service late: it may mount after this plugin. */
			const service = (key) => {
				try {
					return ctx.get(key);
				} catch {
					return undefined;
				}
			};

			return function SessionHistorySearch(props) {
				const t = useMemo(() => createTranslator(props.t), [props.t]);
				const header = useWorkspaceHeader();
				const triggerSlot = useTriggerSlot(header);
				/** Our expanding row in the shipped header; the field portals into it. */
				const fieldSlot = useFieldSlot(header);
				/** The shipped browser container that also holds the session list. */
				const surfaceHost = header === null ? null : header.parentElement;
				const [open, setOpen] = useState(false);
				const [query, setQuery] = useState("");
				const [status, setStatus] = useState("idle");
				const [tip, setTip] = useState(null);
				const [slow, setSlow] = useState(false);
				const [fields, setFields] = useState({ inputs: true, outputs: false });
				const [shape, setShape] = useState({ workspaces: [], group: false, sort: "time" });
				const [pickerOpen, setPickerOpen] = useState(false);
				const [matchers, setMatchers] = useState({
					caseSensitive: false,
					whole: false,
					regex: false,
				});
				const [result, setResult] = useState({
					query: "",
					mode: "exact",
					truncated: false,
					items: [],
					matched: 0,
					total: 0,
					pending: 0,
					workspaces: [],
				});
				const [more, setMore] = useState(false);
				const [error, setError] = useState(null);
				const [cursor, setCursor] = useState(0);
				const triggerRef = useRef(null);
				const surfaceRef = useRef(null);
				const listRef = useRef(null);
				const inputRef = useRef(null);
				const pickerRef = useRef(null);
				const abortRef = useRef(null);
				const answersRef = useRef(new Map());
				/** The header slot that owns the field; outside presses there keep the surface. */
				const fieldHostRef = useRef(null);
				fieldHostRef.current = fieldSlot;
				/** Keywords searched before; ↑ walks them from newest to oldest. */
				const historyRef = useRef(undefined);
				if (historyRef.current === undefined) historyRef.current = readHistory();
				/** Index into historyRef while ↑/↓ browse it; -1 while typing. */
				const historyIndexRef = useRef(-1);
				/** What was being typed when history browsing started. */
				const draftRef = useRef("");
				/** The live keyword, for callbacks that must not resubscribe per keystroke. */
				const queryRef = useRef(query);
				queryRef.current = query;

				/** Toggle one text pool; the last checked pool stays checked. */
				const toggleField = useCallback((key) => {
					setFields((current) => {
						const next = { ...current, [key]: !current[key] };
						if (!next.inputs && !next.outputs) return current;
						return next;
					});
					setCursor(0);
				}, []);

				/** Toggle one matcher switch: case, whole word, regular expression. */
				const toggleMatcher = useCallback((key) => {
					setMatchers((current) => ({ ...current, [key]: !current[key] }));
					setCursor(0);
				}, []);

				/**
				 * Add one committed keyword to the front of the history, deduplicated
				 * and capped. Only close/Enter call this, so the list holds queries
				 * the user actually ran, not intermediate keystrokes.
				 * @param {string} needle - the keyword to remember.
				 */
				const rememberQuery = useCallback((needle) => {
					// Browsing history must not reorder it under the ↑/↓ cursor.
					if (historyIndexRef.current >= 0) return;
					const text = needle.trim();
					if (text === "") return;
					const current = historyRef.current;
					const next = [text, ...current.filter((item) => item !== text)].slice(0, HISTORY_MAX);
					if (next.length === current.length && next.every((item, index) => item === current[index])) return;
					historyRef.current = next;
					writeHistory(next);
				}, []);

				const close = useCallback(() => {
					abortRef.current?.abort();
					historyIndexRef.current = -1;
					rememberQuery(queryRef.current);
					inputRef.current?.blur();
					setPickerOpen(false);
					setTip(null);
					setOpen(false);
				}, [rememberQuery]);

				/**
				 * Turn the current controls into the Host query string.
				 * @param {string} needle - normalized keywords.
				 * @param {{ inputs: boolean, outputs: boolean }} pools - text pools.
				 * @param {{ caseSensitive: boolean, whole: boolean, regex: boolean }} own - matcher switches.
				 * @param {number} stage - rows to skip; greater than zero appends a page.
				 * @returns {string} query string for {@link ROUTE}.
				 */
				const buildQuery = (needle, pools, own, stage) => {
					const params = new URLSearchParams();
					params.set("q", needle);
					params.set("limit", String(RESULT_LIMIT));
					params.set("offset", String(stage));
					const poolsParam = `${pools.inputs ? "input," : ""}${pools.outputs ? "output" : ""}`;
					params.set("fields", poolsParam.replace(/,$/u, ""));
					if (own.caseSensitive) params.set("case", "1");
					if (own.whole) params.set("whole", "1");
					if (own.regex) params.set("regex", "1");
					if (shape.group) params.set("group", "1");
					if (shape.workspaces.length > 0) params.set("ws", shape.workspaces.join(","));
					params.set("sort", shape.sort);
					return params.toString();
				};

				/**
				 * Run one search; a non-zero `stage` appends the next page instead of
				 * replacing the rows already shown.
				 * @param {string} needle - normalized keywords.
				 * @param {{ inputs: boolean, outputs: boolean }} pools - text pools.
				 * @param {object} own - matcher switches.
				 * @param {number} stage - rows to skip.
				 */
				const runSearch = async (needle, pools, own, stage, quiet = false) => {
					clearHighlight();
					const queryString = buildQuery(needle, pools, own, stage);
					if (stage === 0) {
						const cached = answersRef.current.get(queryString);
						if (cached !== undefined && Date.now() - cached.at <= ANSWER_TTL_MS) {
							setResult(cached.payload);
							setCursor(0);
							setError(null);
							setStatus("ready");
							return;
						}
					}
					abortRef.current?.abort();
					const controller = new AbortController();
					abortRef.current = controller;
					if (stage === 0 && !quiet) setStatus("loading");
					setMore(stage > 0);
					setError(null);
					try {
						const response = await fetch(`${ROUTE}?${queryString}`, {
							signal: controller.signal,
							credentials: "same-origin",
							headers: { accept: "application/json" },
						});
						if (!response.ok) {
							let detail = "";
							try {
								const failure = await response.json();
								detail = typeof failure?.message === "string" ? failure.message : "";
							} catch {}
							// A 400 carries the Host's reason (invalid regex, unsafe pattern,
							// query too long); do not label every failure as a regex problem.
							if (response.status === 400) throw new Error(detail || t("invalidRegex"));
							throw new Error(`HTTP ${response.status}`);
						}
						const payload = await response.json();
						if (controller.signal.aborted) return;
						const items = Array.isArray(payload.items) ? payload.items : [];
						const answer = {
							query: needle,
							mode: payload.mode === "approximate" ? "approximate" : "exact",
							truncated: payload.truncated === true,
							items,
							matched: Number.isFinite(payload.matched) ? payload.matched : 0,
							total: Number.isFinite(payload.total) ? payload.total : items.length,
							pending: Number.isFinite(payload.pending) ? payload.pending : 0,
							workspaces: Array.isArray(payload.workspaces) ? payload.workspaces : [],
						};
						if (stage > 0) {
							setResult((current) => ({ ...answer, items: current.items.concat(items) }));
							setMore(false);
							setStatus("ready");
							return;
						}
						answersRef.current.set(queryString, { at: Date.now(), payload: answer });
						while (answersRef.current.size > ANSWER_CACHE_MAX) {
							const oldest = answersRef.current.keys().next();
							if (oldest.done === true) break;
							answersRef.current.delete(oldest.value);
						}
						setResult(answer);
						setCursor(0);
						setStatus("ready");
					} catch (failure) {
						if (controller.signal.aborted) return;
						setMore(false);
						setError(failure instanceof Error ? failure : new Error(String(failure)));
						setStatus("error");
					}
				};

				// A first-ever search builds the Host index; say so when it is slow.
				useEffect(() => {
					if (status !== "loading") {
						setSlow(false);
						return undefined;
					}
					const timer = setTimeout(() => setSlow(true), SLOW_SEARCH_MS);
					return () => clearTimeout(timer);
				}, [status]);

				// Debounced search: one request per settled keyword phrase.
				useEffect(() => {
					if (!open) return undefined;
					const needle = query.trim();
					if (needle.length < MIN_QUERY_LENGTH) {
						setStatus("idle");
						setResult((current) => ({
							query: "",
							items: [],
							matched: 0,
							total: 0,
							pending: 0,
							workspaces: current.workspaces,
						}));
						return undefined;
					}
					const timer = setTimeout(() => {
						void runSearch(needle, fields, matchers, 0);
					}, DEBOUNCE_MS);
					return () => clearTimeout(timer);
				}, [open, query, fields, matchers, shape]);

				// The Host reads unseen Session logs in the background, so an answer can
				// be partial. While it says so, refresh it instead of leaving the rows
				// short until the next keystroke.
				useEffect(() => {
					if (!open || status !== "ready" || result.pending === 0) return undefined;
					if (result.query === "") return undefined;
					const timer = setTimeout(() => {
						answersRef.current.clear();
						void runSearch(result.query, fields, matchers, 0, true);
					}, PENDING_POLL_MS);
					return () => clearTimeout(timer);
				}, [open, status, result.pending, result.query, fields, matchers, shape]);

				// Clicking anywhere else dismisses the options popover.
				useEffect(() => {
					if (!pickerOpen) return undefined;
					const onDown = (event) => {
						const panel = pickerRef.current;
						if (panel !== null && event.target instanceof Node && panel.contains(event.target)) return;
						setPickerOpen(false);
					};
					document.addEventListener("mousedown", onDown, true);
					return () => document.removeEventListener("mousedown", onDown, true);
				}, [pickerOpen]);

				// Abort an in-flight request when the plugin unloads.
				useEffect(() => () => abortRef.current?.abort(), []);

				// Hide the shipped session list while the surface occupies that space.
				useEffect(() => {
					if (surfaceHost === null) return undefined;
					if (!open) {
						surfaceHost.removeAttribute(INLINE_ATTRIBUTE);
						return undefined;
					}
					surfaceHost.setAttribute(INLINE_ATTRIBUTE, "on");
					return () => surfaceHost.removeAttribute(INLINE_ATTRIBUTE);
				}, [surfaceHost, open]);

				// Expand the shipped header row itself, so the field grows in place
				// exactly like the native inline search instead of opening below it.
				useEffect(() => {
					if (header === null) return undefined;
					if (!open) {
						header.removeAttribute(HEADER_OPEN_ATTRIBUTE);
						return undefined;
					}
					header.setAttribute(HEADER_OPEN_ATTRIBUTE, "on");
					return () => header.removeAttribute(HEADER_OPEN_ATTRIBUTE);
				}, [header, open]);

				// A collapsed sidebar has no browser container to take over.
				useEffect(() => {
					if (open && surfaceHost === null) setOpen(false);
				}, [open, surfaceHost]);

				// The rail hides the session list, so a search surface there has no
				// room: close it as soon as the sidebar collapses.
				useEffect(() => {
					if (!open || surfaceHost === null) return undefined;
					const isRail = () => /_rail(?:[\s_-]|$)/u.test(surfaceHost.className);
					if (isRail()) {
						setOpen(false);
						return undefined;
					}
					const observer = new MutationObserver(() => {
						if (isRail()) setOpen(false);
					});
					observer.observe(surfaceHost, { attributes: true, attributeFilter: ["class"] });
					return () => observer.disconnect();
				}, [open, surfaceHost]);

				// Fill the Workspace selector before the first keystroke.
				useEffect(() => {
					if (!open || result.workspaces.length > 0) return undefined;
					let cancelled = false;
					fetch(`${ROUTE}?q=&limit=1`, {
						credentials: "same-origin",
						headers: { accept: "application/json" },
					})
						.then((response) => (response.ok ? response.json() : null))
						.then((payload) => {
							if (cancelled || payload === null) return;
							if (!Array.isArray(payload.workspaces)) return;
							setResult((current) => ({ ...current, workspaces: payload.workspaces }));
						})
						.catch(() => {});
					return () => {
						cancelled = true;
					};
				}, [open, result.workspaces.length]);

				// Focus the field as soon as the surface is in the sidebar.
				useEffect(() => {
					if (!open) return;
					const input = inputRef.current;
					if (input !== null) {
						input.focus();
						input.select();
					}
				}, [open]);

				useDismiss(open, close, triggerRef, surfaceRef, fieldHostRef);

				// Keep the highlighted row inside the scroll viewport.
				useEffect(() => {
					const list = listRef.current;
					if (list === null) return;
					const row = list.querySelector('[data-active="true"]');
					if (row instanceof HTMLElement) row.scrollIntoView({ block: "nearest" });
				}, [cursor, result.items.length]);

				const toggle = () => {
					if (open) {
						close();
						return;
					}
					setOpen(true);
					setCursor(0);
					setError(null);
					// 关掉再打开时保留上次的关键词，并直接按它重搜一次。
					if (query.trim() !== "") void runSearch(query, fields, true, 1);
					setOpen(true);
				};

				/** Edit the keyword by hand; that ends ↑/↓ history browsing. */
				const editQuery = (value) => {
					historyIndexRef.current = -1;
					setQuery(value);
				};

				/**
				 * Step through remembered keywords: +1 is older, -1 is newer, and
				 * stepping past the newest restores the keyword being typed.
				 * @param {number} step - +1 older, -1 newer.
				 * @returns {boolean} whether the input was changed.
				 */
				const recallHistory = (step) => {
					const list = historyRef.current;
					if (list.length === 0) return false;
					if (historyIndexRef.current === -1) {
						draftRef.current = queryRef.current;
						historyIndexRef.current = 0;
						setQuery(list[0]);
						setCursor(0);
						return true;
					}
					const next = historyIndexRef.current + step;
					if (next < 0) {
						historyIndexRef.current = -1;
						setQuery(draftRef.current);
					} else if (next < list.length) {
						historyIndexRef.current = next;
						setQuery(list[next]);
					} else {
						// Already on the oldest keyword: nothing older to show.
						return true;
					}
					setCursor(0);
					return true;
				};

				const openSession = async (item, hit) => {
					const uiWorkspace = service("uiWorkspace");
					if (uiWorkspace === undefined || uiWorkspace === null) return;
					const needle = (hit ?? item).focus ?? item.focus ?? result.query.trim();
					try {
						uiWorkspace.openSession(item.sessionId);
						close();
						if (needle !== "") revealHit(needle);
					} catch (failure) {
						setError(failure instanceof Error ? failure : new Error(String(failure)));
						setStatus("error");
					}
				};

				const onKeyDown = (event) => {
					if (event.key === "Escape" && pickerOpen) {
						event.preventDefault();
						setPickerOpen(false);
						return;
					}
					if (event.key === "ArrowUp") {
						// ↑ walks remembered keywords. Inside the result list it first
						// walks the rows and enters history from the top one, so a shown
						// answer is never skipped by accident.
						if (historyIndexRef.current >= 0) {
							event.preventDefault();
							recallHistory(1);
							return;
						}
						if (result.items.length > 0 && cursor > 0) {
							event.preventDefault();
							setCursor(cursor - 1);
							return;
						}
						event.preventDefault();
						if (!recallHistory(1) && result.items.length > 0) setCursor(result.items.length - 1);
						return;
					}
					if (event.key === "ArrowDown") {
						if (historyIndexRef.current >= 0) {
							event.preventDefault();
							recallHistory(-1);
							return;
						}
						const count = result.items.length;
						if (count === 0) return;
						event.preventDefault();
						setCursor((index) => (index + 1) % count);
						return;
					}
					if (event.key === "Enter") {
						rememberQuery(queryRef.current);
						// A recalled keyword starts a new search; its rows arrive after the
						// debounce, so opening the row still on screen would open the wrong one.
						if (result.query !== query.trim()) return;
						const item = result.items[cursor];
						if (item === undefined) return;
						event.preventDefault();
						void openSession(item);
					}
				};

				/** What the row shows as its title; shared titles need the id tail. */
				const rowTitle = (item) => {
					if (typeof item.title === "string" && item.title !== "") return item.title;
					const opening = proseChunk(item.snippet) || item.snippet || "";
					return firstLine(opening, 60) || t("untitled");
				};

				// Several Sessions that open with the same sentence get the same
				// derived title, so only those rows carry their id tail.
				const duplicateTitles = useMemo(() => {
					const counts = new Map();
					for (const item of result.items) {
						const key = rowTitle(item);
						counts.set(key, (counts.get(key) ?? 0) + 1);
					}
					return new Set(
						[...counts].filter(([, count]) => count > 1).map(([key]) => key),
					);
				}, [result.items, t]);

				/** One timeline row: Session title, why it matched, and its metadata. */
				const HIGHLIGHT_NAME = "dsh-shs-hit";

				// 模块作用域里有一个布局样式表常量叫 CSS，会遮住全局 CSS，所以这里显式走 window.CSS。
				const highlightRegistry = () => (typeof window === "undefined" ? undefined : window.CSS?.highlights);

				const clearHighlight = () => {
					try {
						highlightRegistry()?.delete(HIGHLIGHT_NAME);
					} catch {}
				};

				// 打开会话后尽力把命中处滚到眼前并高亮。会话视图是分窗加载的（顶部有「加载更早」），
				// 命中的消息还没载入时找不到文本节点，这里 3 秒内反复重试，找不到就安静放弃。
				const revealHit = (needle) => {
					clearHighlight();
					const keyword = needle.trim().toLowerCase();
					if (keyword === "" || typeof Highlight === "undefined" || highlightRegistry() === undefined) return;
					const started = Date.now();
					const attempt = () => {
						const root = document.querySelector('[class*="scrollBody"]');
						if (root === null) return retry();
						const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
						let node = walker.nextNode();
						while (node !== null && (node.nodeValue === null || node.nodeValue.toLowerCase().indexOf(keyword) < 0)) node = walker.nextNode();
						if (node === null) return retry();
						const index = node.nodeValue.toLowerCase().indexOf(keyword);
						const range = document.createRange();
						range.setStart(node, index);
						range.setEnd(node, index + keyword.length);
						if (node.parentElement !== null) node.parentElement.scrollIntoView({ block: "center", behavior: "smooth" });
						highlightRegistry()?.set(HIGHLIGHT_NAME, new Highlight(range));
					};
					const retry = () => {
						if (Date.now() - started < 3000) setTimeout(attempt, 200);
					};
					setTimeout(attempt, 120);
				};

				// 悬停预览：展示命中消息的开头和结尾，不是会话标题。
				const showTip = (event, item) => {
					const rect = event.currentTarget.getBoundingClientRect();
					const width = 328;
					const height = tip === null ? 150 : 150;
					const left = Math.min(window.innerWidth - width - 8, rect.right + 10);
					const top = Math.max(8, Math.min(rect.top - 4, window.innerHeight - height - 8));
					setTip({
						left,
						top,
						focus: item.focus ?? "",
						head: item.head ?? "",
						match: item.match ?? "",
						tail: item.tail ?? (item.head === undefined ? (item.snippet ?? "") : ""),
					});
				};
				const hideTip = () => setTip(null);

				const timelineRow = (item, index) =>
					h(
						"button",
						{
							type: "button",
							className: "shs-row",
							"data-active": index === cursor ? "true" : "false",
							onMouseMove: () => setCursor(index),
							onMouseEnter: (event) => showTip(event, item),
							onMouseLeave: hideTip,
							onClick: () => void openSession(item),
						},
						h("span", { className: "shs-row-head" }, h("span", { className: "shs-row-title" }, rowTitle(item))),
						h(
							"span",
							{ className: "shs-row-snippet" },
							highlight(focusExcerpt(item.snippet, item.focus), item.focus),
						),
						h(
							"span",
							{ className: "shs-row-meta" },
							fields.inputs && fields.outputs && item.kind === "output"
								? h("span", { className: "shs-badge" }, t("kindOutput"))
								: null,
							item.workspaceTitle === null || item.workspaceTitle === undefined
								? null
								: h("span", { className: "shs-badge", title: item.workspaceTitle }, item.workspaceTitle),
							duplicateTitles.has(rowTitle(item))
								? h(
										"span",
										{ className: "shs-badge", title: item.sessionId },
										`#${String(item.sessionId).slice(-6)}`,
									)
								: null,
							h("span", null, formatAge(item.time, t)),
							item.coverage < 1
								? h("span", { className: "shs-badge", title: t("approximateHint") }, `≈${Math.round(item.coverage * 100)}%`)
								: null,
						),
					);

				const trigger =
					triggerSlot === null
						? null
						: createPortal(
								h(
									"button",
									{
										ref: triggerRef,
										type: "button",
										className: "shs-trigger",
										[TRIGGER_ATTRIBUTE]: "",
										"aria-label": t("trigger"),
										title: t("trigger"),
										"aria-expanded": open ? "true" : "false",
										tabIndex: open ? -1 : 0,
										onClick: toggle,
									},
									ICON,
								),
								triggerSlot,
							);

				const activeWorkspaces = result.workspaces.filter((workspace) =>
					shape.workspaces.includes(workspace.id),
				);
				const workspaceTitle =
					activeWorkspaces.length === 0
						? t("workspaceAll")
						: activeWorkspaces.map((workspace) => workspace.title).join(" · ");

				let statusLine = null;
				if (status === "loading") {
					statusLine = h("div", { className: "shs-status" }, t(slow ? "indexing" : "searching"));
				} else if (status === "error") {
					statusLine = h(
						"div",
						{ className: "shs-status", "data-tone": "error" },
						`${t("error")}${error === null ? "" : `（${error.message}）`}`,
					);
				} else if (status === "ready" && (result.total > 0 || result.pending > 0)) {
					const parts = [];
					if (result.total > 0) {
						parts.push(
							result.items.length < result.total
								? t(shape.group ? "partial" : "partialSessions", {
										shown: result.items.length,
										count: result.total,
									})
								: t(shape.group ? "count" : "countSessions", { count: result.total }),
						);
					}
					if (result.mode === "approximate") parts.push(t("approximate"));
					if (result.truncated) parts.push(t("truncatedQuery"));
					const hasTruncatedMessage = result.items.some(
						(item) =>
							item.truncated === true ||
							(Array.isArray(item.hits) && item.hits.some((hit) => hit.truncated === true)),
					);
					if (hasTruncatedMessage) parts.push(t("truncatedMessages"));
					if (result.pending > 0) parts.push(t("building", { count: result.pending }));
					statusLine = h("div", { className: "shs-status" }, parts.join(" \u00b7 "));
				}

				let body;
				if (status === "idle") {
					body = h(
						"div",
						{ className: "shs-empty" },
						t("hint"),
						historyRef.current.length === 0
							? null
							: h("div", { className: "shs-empty-note" }, t("historyHint")),
					);
				} else if (status === "error") {
					body = h("div", { className: "shs-empty" }, t("error"));
				} else if (status === "ready" && result.items.length === 0) {
					body = h(
						"div",
						{ className: "shs-empty" },
						result.pending > 0 ? t("building", { count: result.pending }) : t("noResults"),
					);
				} else {
					const rows = result.items.map((item, index) => {
						if (Array.isArray(item.hits)) {
							return h(
								"li",
								{ key: item.sessionId, className: "shs-group" },
								h(
									"div",
									{ className: "shs-group-head" },
									h(
										"span",
										{ className: "shs-group-title" },
										rowTitle(item),
									),
									item.workspaceTitle === null || item.workspaceTitle === undefined
										? null
										: h("span", { className: "shs-badge" }, item.workspaceTitle),
									h("span", { className: "shs-spacer" }),
									h(
										"span",
										null,
										item.hits.length < (item.totalHits ?? item.hits.length)
											? t("groupCountPartial", { shown: item.hits.length, count: item.totalHits })
											: t("groupCount", { count: item.totalHits ?? item.hits.length }),
									),
								),
								item.hits.map((hit) =>
									h(
										"button",
										{
											key: `${item.sessionId}-${hit.seq}`,
											type: "button",
											className: "shs-row",
											onMouseEnter: (event) => showTip(event, hit),
											onMouseLeave: hideTip,
											onClick: () => void openSession(item, hit),
										},
										h(
											"span",
											{ className: "shs-row-snippet" },
											highlight(focusExcerpt(hit.snippet, hit.focus), hit.focus),
										),
										h(
											"span",
											{ className: "shs-row-meta" },
											fields.inputs && fields.outputs && hit.kind === "output"
												? h("span", { className: "shs-badge" }, t("kindOutput"))
												: null,
											h("span", null, formatAge(hit.time, t)),
											hit.coverage < 1
												? h("span", { className: "shs-badge", title: t("approximateHint") }, `≈${Math.round(hit.coverage * 100)}%`)
												: null,
										),
									),
								),
							);
						}
						return h("li", { key: item.sessionId }, timelineRow(item, index));
					});
					const moreButton =
						result.items.length < result.total
							? h(
									"button",
									{
										type: "button",
										className: "shs-more",
										disabled: more,
										onClick: () =>
											void runSearch(result.query, fields, matchers, result.items.length),
									},
									more ? t("searching") : t("loadMore"),
								)
							: null;
					body = h(
						"div",
						{ className: "shs-results" },
						h("ul", { className: "shs-list", ref: listRef }, rows),
						moreButton,
					);
				}

				// Matcher switches ride in the header pill like VS Code's search box does;
				// they are only tabbable while the row is expanded.
				const matcherChips = [
					h(
						"button",
						{
							key: "case",
							type: "button",
							className: "shs-chip",
							"data-on": matchers.caseSensitive ? "true" : "false",
							title: t("caseSensitive"),
							tabIndex: open ? 0 : -1,
							"aria-label": t("caseSensitive"),
							onClick: () => toggleMatcher("caseSensitive"),
						},
						"Aa",
					),
					h(
						"button",
						{
							key: "whole",
							type: "button",
							className: "shs-chip",
							"data-on": matchers.whole ? "true" : "false",
							title: t("wholeWord"),
							tabIndex: open ? 0 : -1,
							"aria-label": t("wholeWord"),
							onClick: () => toggleMatcher("whole"),
						},
						h("span", { className: "shs-whole" }, "ab"),
					),
					h(
						"button",
						{
							key: "regex",
							type: "button",
							className: "shs-chip",
							"data-on": matchers.regex ? "true" : "false",
							title: t("regex"),
							tabIndex: open ? 0 : -1,
							"aria-label": t("regex"),
							onClick: () => toggleMatcher("regex"),
						},
						".*",
					),
				];

				// The field always lives in the header row, even collapsed, so opening
				// and closing are the same width transition the native search runs.
				const field =
					fieldSlot === null
						? null
						: createPortal(
								h(
									"div",
									{ className: "shs-field", "aria-hidden": open ? null : "true" },
									ICON,
									h("input", {
										ref: inputRef,
										className: "shs-input",
										type: "text",
										value: query,
										placeholder: t("placeholder"),
										"aria-label": t("dialogTitle"),
										autoComplete: "off",
										spellCheck: false,
										maxLength: MAX_QUERY_CHARS,
										tabIndex: open ? 0 : -1,
										onChange: (event) => editQuery(event.target.value),
										onKeyDown,
									}),
									matcherChips,
									open
										? h(
												"button",
												{
													type: "button",
													className: "shs-clear",
													"aria-label": t("clear"),
													title: t("clear"),
													tabIndex: 0,
													onClick: () => {
														editQuery("");
														// Same gesture as the shipped search: the clear button
														// empties the box and folds the row back.
														close();
													},
												},
												ICON_CLEAR,
											)
										: null,
								),
								fieldSlot,
							);

				const surface =
					!open || surfaceHost === null
						? null
						: createPortal(
								h(
									"div",
									{
										ref: surfaceRef,
										className: "shs-inline",
										role: "region",
										"aria-label": t("dialogTitle"),
									},
									h(
										"div",
										{ className: "shs-fields" },
										h("span", { className: "shs-note" }, t("searchLabel")),
										h(
											"label",
											{ className: "shs-check" },
											h("input", {
												type: "checkbox",
												checked: fields.inputs,
												onChange: () => toggleField("inputs"),
											}),
											h("span", null, t("fieldInput")),
										),
										h(
											"label",
											{ className: "shs-check" },
											h("input", {
												type: "checkbox",
												checked: fields.outputs,
												onChange: () => toggleField("outputs"),
											}),
											h("span", null, t("fieldOutput")),
										),
										h("span", { className: "shs-spacer" }),
										h(
											"button",
											{
												type: "button",
												className: "shs-tool",
												"data-on": shape.workspaces.length === 0 ? "false" : "true",
												"aria-label": t("workspaceLabel"),
												title: workspaceTitle,
												onClick: () => setPickerOpen((value) => !value),
											},
											ICON_WORKSPACE,
										),
										h(
											"button",
											{
												type: "button",
												className: "shs-tool",
												"data-on": shape.group ? "true" : "false",
												"aria-label": t("groupToggle"),
												title: t("groupToggle"),
												onClick: () =>
													setShape((current) => ({
														...current,
														group: !current.group,
													})),
											},
											ICON_GROUP,
										),
										h(
											"button",
											{
												type: "button",
												className: "shs-tool",
												"data-on": shape.sort === "relevance" ? "true" : "false",
												"aria-label": shape.sort === "time" ? t("sortTime") : t("sortRelevance"),
												title: shape.sort === "time" ? t("sortTime") : t("sortRelevance"),
												onClick: () =>
													setShape((current) => ({
														...current,
														sort: current.sort === "time" ? "relevance" : "time",
													})),
											},
											shape.sort === "time" ? ICON_SORT_TIME : ICON_SORT_REL,
										),
									),
									pickerOpen
										? h(
												"div",
												{ className: "shs-picker", ref: pickerRef },
												h(
													"button",
													{
														type: "button",
														className: "shs-pick-item",
														"data-on": shape.workspaces.length === 0 ? "true" : "false",
														onClick: () =>
															setShape((current) => ({ ...current, workspaces: [] })),
													},
													h(
														"span",
														{ className: "shs-pick-box", "aria-hidden": "true" },
														shape.workspaces.length === 0 ? CHECK : null,
													),
													h("span", { className: "shs-pick-label" }, t("workspaceAll")),
												),
												result.workspaces.map((workspace) =>
													h(
														"button",
														{
															key: workspace.id,
															type: "button",
															className: "shs-pick-item",
															"data-on": shape.workspaces.includes(workspace.id)
																? "true"
																: "false",
															onClick: () =>
																setShape((current) => ({
																	...current,
																	workspaces: current.workspaces.includes(workspace.id)
																		? current.workspaces.filter(
																				(id) => id !== workspace.id,
																			)
																		: [...current.workspaces, workspace.id],
																})),
														},
														h(
															"span",
															{ className: "shs-pick-box", "aria-hidden": "true" },
															shape.workspaces.includes(workspace.id) ? CHECK : null,
														),
														h("span", { className: "shs-pick-label" }, workspace.title),
													),
												),
											)
										: null,
									statusLine,
									body,
									tip === null
										? null
										: h(
												"div",
												{
													className: "shs-tip",
													style: { left: `${tip.left}px`, top: `${tip.top}px` },
												},
												h(
													"div",
													{ className: "shs-tip-body" },
													tip.head === "" ? null : highlight(tip.head, tip.focus),
													tip.match === "" ? null : h("mark", { className: "shs-hit" }, tip.match),
													tip.tail === "" ? null : highlight(tip.tail, tip.focus),
												),
											),
								),
								surfaceHost,
							);

				return h(React.Fragment, null, trigger, field, surface);
			};
		}

		// ---------------------------------------------------------------- plugin

		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => {
				ensureStyle();
				return () => {
					document.getElementById(STYLE_ID)?.remove();
				};
			}, "find-history: styles");
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "find-history: locale");
			const Component = createComponent(ctx);
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "find-history",
						order: 100,
						priority: -1,
						locale: NS,
					},
					Component,
				),
			);
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
