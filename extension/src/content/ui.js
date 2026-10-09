(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	function formatSeconds(totalSeconds) {
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}:${String(seconds).padStart(2, '0')}`;
	}

	function formatResetCountdown(timestampMs) {
		// <= 0: reset time reached
		const diffMs = timestampMs - Date.now();
		if (diffMs <= 0) return '0s';

		// < 1 min: show seconds
		const totalSeconds = Math.floor(diffMs / 1000);
		if (totalSeconds < 60) return `${totalSeconds}s`;

		// < 1 hour: show minutes
		const totalMinutes = Math.round(totalSeconds / 60);
		if (totalMinutes < 60) return `${totalMinutes}m`;

		// < 1 day: show hours
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		if (hours < 24) return `${hours}h ${minutes}m`;

		// >= 1 day: show days
		const days = Math.floor(hours / 24);
		const remHours = hours % 24;
		return `${days}d ${remHours}h`;
	}

	function setupTooltip(element, tooltip, { topOffset = 10 } = {}) {
		if (!element || !tooltip) return;
		if (element.hasAttribute('data-tooltip-setup')) return;
		element.setAttribute('data-tooltip-setup', 'true');
		element.classList.add('cc-tooltipTrigger');

		let pressTimer;
		let hideTimer;

		const show = () => {
			const rect = element.getBoundingClientRect();
			tooltip.style.opacity = '1';
			const tipRect = tooltip.getBoundingClientRect();

			let left = rect.left + rect.width / 2;
			if (left + tipRect.width / 2 > window.innerWidth) left = window.innerWidth - tipRect.width / 2 - 10;
			if (left - tipRect.width / 2 < 0) left = tipRect.width / 2 + 10;

			let top = rect.top - tipRect.height - topOffset;
			if (top < 10) top = rect.bottom + 10;

			tooltip.style.left = `${left}px`;
			tooltip.style.top = `${top}px`;
			tooltip.style.transform = 'translateX(-50%)';
		};

		const hide = () => {
			tooltip.style.opacity = '0';
			clearTimeout(hideTimer);
		};

		element.addEventListener('pointerdown', (e) => {
			if (e.pointerType === 'touch' || e.pointerType === 'pen') {
				pressTimer = setTimeout(() => {
					show();
					hideTimer = setTimeout(hide, 3000);
				}, 500);
			}
		});

		element.addEventListener('pointerup', () => clearTimeout(pressTimer));
		element.addEventListener('pointercancel', () => {
			clearTimeout(pressTimer);
			hide();
		});

		element.addEventListener('pointerenter', (e) => {
			if (e.pointerType === 'mouse') show();
		});

		element.addEventListener('pointerleave', (e) => {
			if (e.pointerType === 'mouse') hide();
		});
	}

	function makeTooltip(text) {
		const tip = document.createElement('div');
		tip.className = 'bg-bg-500 text-text-000 cc-tooltip';
		tip.textContent = text;
		document.body.appendChild(tip);
		return tip;
	}

	class CounterUI {
		constructor({ onUsageRefresh } = {}) {
			this.onUsageRefresh = onUsageRefresh || null;

			this.headerContainer = null;
			this.headerDisplay = null;
			this.lengthGroup = null;
			this.lengthDisplay = null;
			this.cachedDisplay = null;
			this.lengthBar = null;
			this.lengthTooltip = null;
			this.lastCachedUntilMs = null;
			this.pendingCache = false;

			this.usageLine = null;
			this.sessionUsageSpan = null;
			this.weeklyUsageSpan = null;
			this.sessionBar = null;
			this.sessionBarFill = null;
			this.weeklyBar = null;
			this.weeklyBarFill = null;
			this.sessionResetMs = null;
			this.weeklyResetMs = null;
			this.sessionMarker = null;
			this.weeklyMarker = null;
			this.sessionWindowStartMs = null;
			this.weeklyWindowStartMs = null;
			this.refreshingUsage = false;

			this.domObserver = null;
		}

		getProgressChrome() {
			const root = document.documentElement;
			const modeDark = root.dataset?.mode === 'dark';
			const modeLight = root.dataset?.mode === 'light';
			const isDark = modeDark && !modeLight;

			return {
				strokeColor: isDark ? CC.COLORS.PROGRESS_OUTLINE_DARK : CC.COLORS.PROGRESS_OUTLINE_LIGHT,
				fillColor: isDark ? CC.COLORS.PROGRESS_FILL_DARK : CC.COLORS.PROGRESS_FILL_LIGHT,
				markerColor: isDark ? CC.COLORS.PROGRESS_MARKER_DARK : CC.COLORS.PROGRESS_MARKER_LIGHT,
				boldColor: isDark ? CC.COLORS.BOLD_DARK : CC.COLORS.BOLD_LIGHT
			};
		}

		refreshProgressChrome() {
			const { strokeColor, fillColor, markerColor } = this.getProgressChrome();

			const applyBarChrome = (bar, { fillWarn } = {}) => {
				if (!bar) return;
				bar.style.setProperty('--cc-stroke', strokeColor);
				bar.style.setProperty('--cc-fill', fillColor);
				bar.style.setProperty('--cc-fill-warn', fillWarn ?? fillColor);
				bar.style.setProperty('--cc-marker', markerColor);
			};

			applyBarChrome(this.lengthBar, { fillWarn: fillColor });
			applyBarChrome(this.sessionBar, { fillWarn: CC.COLORS.RED_WARNING });
			applyBarChrome(this.weeklyBar, { fillWarn: CC.COLORS.RED_WARNING });
		}

		initialize() {
			// Header container (tokens + cache timer)
			this.headerContainer = document.createElement('div');
			this.headerContainer.className = 'text-text-500 text-xs !px-1 cc-header';

			this.headerDisplay = document.createElement('span');
			this.headerDisplay.className = 'cc-headerItem';

			this.lengthGroup = document.createElement('span');
			this.lengthDisplay = document.createElement('span');
			this.cachedDisplay = document.createElement('span');
			this.cacheTimeSpan = null; // reference to inner time span

			this.lengthGroup.appendChild(this.lengthDisplay);
			this.headerDisplay.appendChild(this.lengthGroup);

			// Usage line (session + weekly)
			this._initUsageLine();

			this._setupTooltips();
			this._observeDom();
			this._observeTheme();
		}

		_observeTheme() {
			// Watch for theme changes (data-mode attribute on <html>)
			const observer = new MutationObserver(() => this.refreshProgressChrome());
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
		}

		_observeDom() {
			// Track pending reattach attempts independently
			let usageReattachPending = false;
			let headerReattachPending = false;

			this.domObserver = new MutationObserver(() => {
				const usageMissing = this.usageLine && !document.contains(this.usageLine);
				const headerMissing = !document.contains(this.headerContainer);

				if (usageMissing && !usageReattachPending) {
					usageReattachPending = true;
					CC.waitForElement(CC.DOM.MODEL_SELECTOR_DROPDOWN, 60000).then((el) => {
						usageReattachPending = false;
						if (el) this.attachUsageLine();
					});
				}

				if (headerMissing && !headerReattachPending) {
					headerReattachPending = true;
					CC.waitForElement(CC.DOM.CHAT_MENU_TRIGGER, 60000).then((el) => {
						headerReattachPending = false;
						if (el) this.attachHeader();
					});
				}
			});
			this.domObserver.observe(document.body, { childList: true, subtree: true });
		}

		_initUsageLine() {
			this.usageLine = document.createElement('div');
			this.usageLine.className =
				'text-text-400 text-[11px] cc-usageRow cc-hidden flex flex-row items-center gap-3 w-full';

			this.sessionUsageSpan = document.createElement('span');
			this.sessionUsageSpan.className = 'cc-usageText';

			this.sessionBar = document.createElement('div');
			this.sessionBar.className = 'cc-bar cc-bar--usage';
			this.sessionBarFill = document.createElement('div');
			this.sessionBarFill.className = 'cc-bar__fill';
			this.sessionMarker = document.createElement('div');
			this.sessionMarker.className = 'cc-bar__marker cc-hidden';
			this.sessionMarker.style.left = '0%';
			this.sessionBar.appendChild(this.sessionBarFill);
			this.sessionBar.appendChild(this.sessionMarker);

			this.weeklyUsageSpan = document.createElement('span');
			this.weeklyUsageSpan.className = 'cc-usageText';

			this.weeklyBar = document.createElement('div');
			this.weeklyBar.className = 'cc-bar cc-bar--usage';
			this.weeklyBarFill = document.createElement('div');
			this.weeklyBarFill.className = 'cc-bar__fill';
			this.weeklyMarker = document.createElement('div');
			this.weeklyMarker.className = 'cc-bar__marker cc-hidden';
			this.weeklyMarker.style.left = '0%';
			this.weeklyBar.appendChild(this.weeklyBarFill);
			this.weeklyBar.appendChild(this.weeklyMarker);

			this.sessionGroup = document.createElement('div');
			this.sessionGroup.className = 'cc-usageGroup';
			this.sessionGroup.appendChild(this.sessionUsageSpan);
			this.sessionGroup.appendChild(this.sessionBar);

			this.weeklyGroup = document.createElement('div');
			this.weeklyGroup.className = 'cc-usageGroup cc-usageGroup--weekly';
			this.weeklyGroup.appendChild(this.weeklyBar);
			this.weeklyGroup.appendChild(this.weeklyUsageSpan);

			this.usageLine.appendChild(this.sessionGroup);
			this.usageLine.appendChild(this.weeklyGroup);

			this.refreshProgressChrome();

			this.usageLine.addEventListener('click', async () => {
				if (!this.onUsageRefresh || this.refreshingUsage) return;
				this.refreshingUsage = true;
				this.usageLine.classList.add('cc-usageRow--dim');
				try {
					await this.onUsageRefresh();
				} finally {
					this.usageLine.classList.remove('cc-usageRow--dim');
					this.refreshingUsage = false;
				}
			});
		}

		_setupTooltips() {
			this.lengthTooltip = makeTooltip(
				"Approximate tokens (excludes system prompt).\nUses a generic tokenizer, may differ from Claude's count.\nBecomes invalid after context compaction.\nBar scale: 200k tokens (Claude's maximum context length, will compact before then)."
			);
			setupTooltip(
				this.lengthGroup,
				this.lengthTooltip,
				{ topOffset: 8 }
			);

			setupTooltip(
				this.cachedDisplay,
				makeTooltip("Messages sent while cached are significantly cheaper."),
				{ topOffset: 8 }
			);

			setupTooltip(
				this.sessionGroup,
				makeTooltip("5-hour session window.\nThe bar shows your usage.\nThe line marks where you are in the window."),
				{ topOffset: 8 }
			);

			setupTooltip(
				this.weeklyGroup,
				makeTooltip("7-day usage window.\nThe bar shows your usage.\nThe line marks where you are in the window."),
				{ topOffset: 8 }
			);
		}

		attach() {
			this.attachHeader();
			this.attachUsageLine();
			this.refreshProgressChrome();
		}

		attachHeader() {
			const chatMenu = document.querySelector(CC.DOM.CHAT_MENU_TRIGGER);
			if (!chatMenu) return;
			const anchor = chatMenu.closest(CC.DOM.CHAT_PROJECT_WRAPPER) || chatMenu.parentElement;
			if (!anchor) return;
			if (anchor.nextElementSibling !== this.headerContainer) {
				anchor.after(this.headerContainer);
			}
			this._renderHeader();
			this.refreshProgressChrome();
		}

		attachUsageLine() {
			if (!this.usageLine) return;
			const modelSelector = document.querySelector(CC.DOM.MODEL_SELECTOR_DROPDOWN);
			if (!modelSelector) return;
			const gridContainer = modelSelector.closest('[data-testid="chat-input-grid-container"]');
			const gridArea = modelSelector.closest('[data-testid="chat-input-grid-area"]');
			const findToolbarRow = (el, stopAt) => {
				let cur = el;
				while (cur && cur !== document.body) {
					if (stopAt && cur === stopAt) break;
					if (cur !== el && cur.nodeType === 1) {
						const style = window.getComputedStyle(cur);
						if (style.display === 'flex' && style.flexDirection === 'row') {
							const buttons = cur.querySelectorAll('button').length;
							if (buttons > 1) return cur;
						}
					}
					cur = cur.parentElement;
				}
				return null;
			};

			const toolbarRow =
				(gridContainer ? findToolbarRow(modelSelector, gridArea || gridContainer) : null) ||
				findToolbarRow(modelSelector) ||
				modelSelector.parentElement?.parentElement?.parentElement;
			if (!toolbarRow) return;
			if (toolbarRow.nextElementSibling !== this.usageLine) {
				toolbarRow.after(this.usageLine);
			}
			this.refreshProgressChrome();
		}

		setPendingCache(pending) {
			this.pendingCache = pending;
			if (this.cacheTimeSpan) {
				if (pending) {
					this.cacheTimeSpan.style.color = '';
				} else {
					const { boldColor } = this.getProgressChrome();
					this.cacheTimeSpan.style.color = boldColor;
				}
			}
		}

		setConversationMetrics({ totalTokens, cachedUntil } = {}) {
			this.pendingCache = false;

			if (typeof totalTokens !== 'number') {
				this.lengthDisplay.textContent = '';
				this.cachedDisplay.textContent = '';
				this.lastCachedUntilMs = null;
				this._renderHeader();
				return;
			}

			const pct = Math.max(0, Math.min(100, (totalTokens / CC.CONST.CONTEXT_LIMIT_TOKENS) * 100));
			this.lengthDisplay.textContent = `~${totalTokens.toLocaleString()} tokens`;

			// Mini bar (hide when full - context is definitely compacted by then)
			const isFull = pct >= 99.5;
			if (isFull) {
				this.lengthDisplay.style.opacity = '0.5';
				this.lengthBar = null;
				this.lengthGroup.replaceChildren(this.lengthDisplay);
				if (this.lengthTooltip) {
					this.lengthTooltip.textContent =
						"Approximate tokens (excludes system prompt).\nUses a generic tokenizer, may differ from Claude's count.\nThis count is invalid after compaction.";
				}
			} else {
				this.lengthDisplay.style.opacity = '';
				const bar = document.createElement('div');
				bar.className = 'cc-bar cc-bar--mini';
				this.lengthBar = bar;
				const fill = document.createElement('div');
				fill.className = 'cc-bar__fill';
				fill.style.width = `${pct}%`;
				bar.appendChild(fill);
				this.refreshProgressChrome();

				const barContainer = document.createElement('span');
				barContainer.className = 'inline-flex items-center';
				barContainer.appendChild(bar);

				this.lengthGroup.replaceChildren(this.lengthDisplay, document.createTextNode('\u00A0\u00A0'), barContainer);
			}

			// Cache timer
			const now = Date.now();
			if (typeof cachedUntil === 'number' && cachedUntil > now) {
				this.lastCachedUntilMs = cachedUntil;
				const secondsLeft = Math.max(0, Math.ceil((cachedUntil - now) / 1000));
				const { boldColor } = this.getProgressChrome();
				this.cacheTimeSpan = Object.assign(document.createElement('span'), {
					className: 'cc-cacheTime',
					textContent: formatSeconds(secondsLeft)
				});
				this.cacheTimeSpan.style.color = boldColor;
				this.cachedDisplay.replaceChildren(document.createTextNode('cached for\u00A0'), this.cacheTimeSpan);
			} else {
				this.lastCachedUntilMs = null;
				this.cacheTimeSpan = null;
				this.cachedDisplay.textContent = '';
			}

			this._renderHeader();
		}

		_renderHeader() {
			this.headerContainer.replaceChildren();

			const hasTokens = !!this.lengthDisplay.textContent;
			const hasCache = !!this.cachedDisplay.textContent;

			if (!hasTokens) return;

			if (hasCache) {
				const gap = this.lengthBar ? '\u00A0\u00A0' : '\u00A0';
				this.headerDisplay.replaceChildren(
					this.lengthGroup,
					document.createTextNode(gap),
					this.cachedDisplay
				);
			} else {
				this.headerDisplay.replaceChildren(this.lengthGroup);
			}

			this.headerContainer.appendChild(this.headerDisplay);
		}

		setUsage(usage) {
			this.refreshProgressChrome();
			const session = usage?.five_hour || null;
			const weekly = usage?.seven_day || null;
			const hasAnyUsage =
				!!(session && typeof session.utilization === 'number') || !!(weekly && typeof weekly.utilization === 'number');
			this.usageLine?.classList.toggle('cc-hidden', !hasAnyUsage);

			if (session && typeof session.utilization === 'number') {
				const rawPct = session.utilization;
				const pct = Math.round(rawPct * 10) / 10;
				this.sessionResetMs = session.resets_at ? Date.parse(session.resets_at) : null;
				this.sessionWindowStartMs = this.sessionResetMs ? this.sessionResetMs - 5 * 60 * 60 * 1000 : null;
				const resetText = this.sessionResetMs ? ` · resets in ${formatResetCountdown(this.sessionResetMs)}` : '';
				this.sessionUsageSpan.textContent = `Session: ${pct}%${resetText}`;

				const width = Math.max(0, Math.min(100, rawPct));
				this.sessionBarFill.style.width = `${width}%`;
				this.sessionBarFill.classList.toggle('cc-warn', width >= 90);
				this.sessionBarFill.classList.toggle('cc-full', width >= 99.5);
			} else {
				this.sessionUsageSpan.textContent = '';
				this.sessionBarFill.style.width = '0%';
				this.sessionBarFill.classList.remove('cc-warn', 'cc-full');
				this.sessionResetMs = null;
				this.sessionWindowStartMs = null;
			}

			const hasWeekly = weekly && typeof weekly.utilization === 'number';
			this.weeklyGroup?.classList.toggle('cc-hidden', !hasWeekly);
			this.sessionGroup?.classList.toggle('cc-usageGroup--single', !hasWeekly);

			if (hasWeekly) {
				this.weeklyUsageSpan.classList.remove('cc-hidden');
				this.weeklyBar.classList.remove('cc-hidden');

				const rawPct = weekly.utilization;
				const pct = Math.round(rawPct * 10) / 10;
				this.weeklyResetMs = weekly.resets_at ? Date.parse(weekly.resets_at) : null;
				this.weeklyWindowStartMs = this.weeklyResetMs ? this.weeklyResetMs - 7 * 24 * 60 * 60 * 1000 : null;
				const resetText = this.weeklyResetMs ? ` · resets in ${formatResetCountdown(this.weeklyResetMs)}` : '';
				this.weeklyUsageSpan.textContent = `Weekly: ${pct}%${resetText}`;

				const width = Math.max(0, Math.min(100, rawPct));
				this.weeklyBarFill.style.width = `${width}%`;
				this.weeklyBarFill.classList.toggle('cc-warn', width >= 90);
				this.weeklyBarFill.classList.toggle('cc-full', width >= 99.5);
			} else {
				this.weeklyUsageSpan.classList.add('cc-hidden');
				this.weeklyBar.classList.add('cc-hidden');
				this.weeklyResetMs = null;
				this.weeklyWindowStartMs = null;
				this.weeklyBarFill.classList.remove('cc-warn', 'cc-full');
			}

			this._updateMarkers();
		}

		_updateMarkers() {
			const now = Date.now();

			if (this.sessionMarker && this.sessionWindowStartMs && this.sessionResetMs) {
				const total = this.sessionResetMs - this.sessionWindowStartMs;
				const elapsed = Math.max(0, Math.min(total, now - this.sessionWindowStartMs));
				const ratio = total > 0 ? elapsed / total : 0;
				const pct = Math.max(0, Math.min(100, ratio * 100));
				this.sessionMarker.classList.remove('cc-hidden');
				this.sessionMarker.style.left = `${pct}%`;
			} else if (this.sessionMarker) {
				this.sessionMarker.classList.add('cc-hidden');
			}

			if (this.weeklyMarker && this.weeklyWindowStartMs && this.weeklyResetMs) {
				const total = this.weeklyResetMs - this.weeklyWindowStartMs;
				const elapsed = Math.max(0, Math.min(total, now - this.weeklyWindowStartMs));
				const ratio = total > 0 ? elapsed / total : 0;
				const pct = Math.max(0, Math.min(100, ratio * 100));
				this.weeklyMarker.classList.remove('cc-hidden');
				this.weeklyMarker.style.left = `${pct}%`;
			} else if (this.weeklyMarker) {
				this.weeklyMarker.classList.add('cc-hidden');
			}
		}

		tick() {
			// Cache countdown
			const now = Date.now();
			if (this.lastCachedUntilMs && this.lastCachedUntilMs > now) {
				const secondsLeft = Math.max(0, Math.ceil((this.lastCachedUntilMs - now) / 1000));
				if (this.cacheTimeSpan) {
					this.cacheTimeSpan.textContent = formatSeconds(secondsLeft);
				}
			} else if (this.lastCachedUntilMs && this.lastCachedUntilMs <= now) {
				this.lastCachedUntilMs = null;
				this.cacheTimeSpan = null;
				this.pendingCache = false;
				this.cachedDisplay.textContent = '';
				this._renderHeader();
			}

			// Reset countdown text + time markers
			if (this.sessionResetMs && this.sessionUsageSpan?.textContent) {
				const idx = this.sessionUsageSpan.textContent.indexOf('· resets in');
				if (idx !== -1) {
					const prefix = this.sessionUsageSpan.textContent.slice(0, idx + '· resets in '.length);
					this.sessionUsageSpan.textContent = `${prefix}${formatResetCountdown(this.sessionResetMs)}`;
				}
			}

			if (this.weeklyResetMs && this.weeklyUsageSpan?.textContent) {
				const idx = this.weeklyUsageSpan.textContent.indexOf('· resets in');
				if (idx !== -1) {
					const prefix = this.weeklyUsageSpan.textContent.slice(0, idx + '· resets in '.length);
					this.weeklyUsageSpan.textContent = `${prefix}${formatResetCountdown(this.weeklyResetMs)}`;
				}
			}

			this._updateMarkers();
		}
	}

	function formatQuerySnippet(text, maxLength = 32) {
		if (!text || typeof text !== 'string') return '';
		const clean = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
		if (clean.length <= maxLength) return clean;
		return clean.slice(0, maxLength).trimEnd() + '...';
	}

	class QueryNavigatorUI {
		constructor({ onQuerySelect } = {}) {
			this.onQuerySelect = onQuerySelect || null;
			this.queries = [];
			this.activeIndex = -1;
			this.isPopupOpen = false;

			this.container = null;
			this.timeline = null;
			this.popup = null;
			this.dotElements = [];
			this.dotWrapperElements = [];
			this.itemElements = [];

			this._scrollRaf = null;
			this._closeTimer = null;
			this._onDocumentClick = null;
			this._onKeyDown = null;
			this._onScroll = null;
			this._highlightTimeout = null;
		}

		initialize() {
			if (this.container && document.body?.contains?.(this.container)) return;

			this.container = document.createElement('div');
			this.container.className = 'cc-query-nav cc-hidden';

			this.timeline = document.createElement('div');
			this.timeline.className = 'cc-query-timeline';
			this.timeline.setAttribute('role', 'navigation');
			this.timeline.setAttribute('aria-label', 'Conversation Query Timeline');

			this.popup = document.createElement('div');
			this.popup.className = 'cc-query-popup';
			this.popup.setAttribute('role', 'menu');
			this.popup.setAttribute('aria-label', 'Conversation Queries');

			this.container.appendChild(this.timeline);
			this.container.appendChild(this.popup);

			if (document.body) {
				document.body.appendChild(this.container);
			}

			// Hover on container keeps popup open and cancels any pending close timer
			this.container.addEventListener?.('mouseenter', () => {
				if (this._closeTimer) {
					clearTimeout(this._closeTimer);
					this._closeTimer = null;
				}
				if (this.queries.length > 0) {
					this.openPopup();
				}
			});

			// Mouse leaving container closes popup after a 220ms smooth grace period
			this.container.addEventListener?.('mouseleave', () => {
				if (this._closeTimer) clearTimeout(this._closeTimer);
				this._closeTimer = setTimeout(() => {
					this.closePopup();
					this._closeTimer = null;
				}, 220);
			});

			// Prevent inside clicks from triggering document dismiss
			this.container.addEventListener?.('pointerdown', (e) => e?.stopPropagation?.());
			this.container.addEventListener?.('mousedown', (e) => e?.stopPropagation?.());

			// Click/tap outside dismisses popup
			this._onDocumentClick = (e) => {
				if (!this.isPopupOpen) return;
				if (this.container && !this.container.contains?.(e.target)) {
					this.closePopup();
				}
			};
			document.addEventListener?.('pointerdown', this._onDocumentClick);
			document.addEventListener?.('click', this._onDocumentClick);

			// Escape key dismisses popup
			this._onKeyDown = (e) => {
				if (e.key === 'Escape' && this.isPopupOpen) {
					this.closePopup();
				}
			};
			document.addEventListener?.('keydown', this._onKeyDown, true);

			// ScrollSpy: track viewport scroll position to highlight active query
			this._onScroll = () => {
				if (this._scrollRaf) return;
				if (typeof requestAnimationFrame === 'function') {
					this._scrollRaf = requestAnimationFrame(() => {
						this._scrollRaf = null;
						this.updateActiveFromScroll();
					});
				} else {
					this.updateActiveFromScroll();
				}
			};
			window.addEventListener?.('scroll', this._onScroll, { passive: true, capture: true });
		}

		setQueries(rawQueries) {
			const list = Array.isArray(rawQueries) ? rawQueries : [];
			this.queries = list.map((q, idx) => {
				if (typeof q === 'string') {
					return { id: `q_${idx}`, uuid: null, text: q, index: idx };
				}
				return {
					id: q.id || q.uuid || `q_${idx}`,
					uuid: q.uuid || null,
					text: q.text || '',
					index: idx,
					createdAt: q.createdAt || null
				};
			}).filter((q) => Boolean(q.text.trim()));

			if (!this.container) {
				this.initialize();
			}

			if (this.queries.length === 0) {
				this.container?.classList?.add('cc-hidden');
				this.closePopup();
				this.activeIndex = -1;
				return;
			}

			this.container?.classList?.remove('cc-hidden');

			// Default active query: keep current if valid, else latest query
			if (this.activeIndex < 0 || this.activeIndex >= this.queries.length) {
				this.activeIndex = this.queries.length - 1;
			}

			this.render();
		}

		render() {
			if (!this.timeline || !this.popup) return;

			if (typeof this.timeline.replaceChildren === 'function') {
				this.timeline.replaceChildren();
				this.popup.replaceChildren();
			} else {
				this.timeline.innerHTML = '';
				this.popup.innerHTML = '';
			}
			this.dotElements = [];
			this.dotWrapperElements = [];
			this.itemElements = [];

			this.queries.forEach((query, index) => {
				// 1. Timeline dot wrapper with generous hit target (Image 1)
				// NO title attribute to prevent native browser tooltip box from appearing
				const dotWrapper = document.createElement('div');
				dotWrapper.className = 'cc-query-dot-wrapper';
				dotWrapper.setAttribute('data-index', String(index));

				const dot = document.createElement('div');
				dot.className = 'cc-query-dot' + (index === this.activeIndex ? ' cc-active' : '');
				dot.setAttribute('data-index', String(index));

				dotWrapper.appendChild(dot);

				// Hover directly on dot opens popup card and highlights this item
				dotWrapper.addEventListener?.('mouseenter', () => {
					if (this._closeTimer) {
						clearTimeout(this._closeTimer);
						this._closeTimer = null;
					}
					this.openPopup();
					this.setActiveIndex(index);
				});

				const handleDotTap = (e) => {
					e?.stopPropagation?.();
					this.openPopup();
					this.scrollToQuery(index);
				};

				dotWrapper.addEventListener?.('pointerdown', (e) => e?.stopPropagation?.());
				dotWrapper.addEventListener?.('click', handleDotTap);

				this.timeline.appendChild(dotWrapper);
				this.dotElements.push(dot);
				this.dotWrapperElements.push(dotWrapper);

				// 2. Popup list row item (Image 2)
				// NO title attribute to prevent native browser tooltip box from appearing
				const item = document.createElement('div');
				item.className = 'cc-query-item' + (index === this.activeIndex ? ' cc-active' : '');
				item.setAttribute('role', 'menuitem');
				item.setAttribute('data-index', String(index));

				const textSpan = document.createElement('span');
				textSpan.className = 'cc-query-text';
				textSpan.textContent = formatQuerySnippet(query.text, 32);

				const itemDot = document.createElement('span');
				itemDot.className = 'cc-query-item-dot' + (index === this.activeIndex ? ' cc-active' : '');

				item.appendChild(textSpan);
				item.appendChild(itemDot);

				item.addEventListener?.('mouseenter', () => {
					this.setActiveIndex(index);
				});

				const handleItemTap = (e) => {
					e?.stopPropagation?.();
					this.scrollToQuery(index);
					if (this.onQuerySelect) {
						this.onQuerySelect(query, index);
					}
				};

				item.addEventListener?.('pointerdown', (e) => e?.stopPropagation?.());
				item.addEventListener?.('click', handleItemTap);

				this.popup.appendChild(item);
				this.itemElements.push(item);
			});
		}

		openPopup() {
			if (this.isPopupOpen) return;
			this.isPopupOpen = true;
			this.popup?.classList?.add('cc-open');
		}

		closePopup() {
			if (!this.isPopupOpen) return;
			this.isPopupOpen = false;
			this.popup?.classList?.remove('cc-open');
		}

		togglePopup() {
			if (this.isPopupOpen) {
				this.closePopup();
			} else {
				this.openPopup();
			}
		}

		setActiveIndex(index) {
			if (index < 0 || index >= this.queries.length) return;
			this.activeIndex = index;

			this.dotElements.forEach((dot, idx) => {
				dot.classList?.toggle('cc-active', idx === index);
			});

			this.itemElements.forEach((item, idx) => {
				item.classList?.toggle('cc-active', idx === index);
				const itemDot = item.querySelector ? item.querySelector('.cc-query-item-dot') : null;
				if (itemDot) {
					itemDot.classList?.toggle('cc-active', idx === index);
				}
			});
		}

		findUserMessageElements() {
			if (typeof document.querySelectorAll !== 'function') return [];

			const primarySelectors = [
				'[data-testid="user-message"]',
				'[data-message-author="human"]',
				'[data-message-author-role="user"]',
				'.font-user-message',
				'div[data-testid*="user-message"]'
			];

			let candidates = [];
			for (const sel of primarySelectors) {
				const matches = Array.from(document.querySelectorAll(sel));
				if (matches.length > 0) {
					candidates = matches;
					break;
				}
			}

			if (candidates.length === 0) {
				const chatContainers = document.querySelectorAll(
					'[data-testid="chat-conversation-container"], [data-testid="chat-messages-list"], main'
				);
				for (const container of chatContainers) {
					if (typeof container.querySelectorAll === 'function') {
						const matches = Array.from(container.querySelectorAll('.font-user-message, [class*="user-message"]'));
						if (matches.length > 0) {
							candidates = matches;
							break;
						}
					}
				}
			}

			// Deduplicate nested elements: keep outermost message container
			const distinct = candidates.filter((el, idx, arr) => {
				return !arr.some((other, oIdx) => oIdx !== idx && other.contains && other.contains(el));
			});

			return distinct;
		}

		findChatScrollContainer() {
			if (typeof document.querySelector !== 'function') return null;
			return document.querySelector('[data-testid="chat-conversation-container"]') ||
				document.querySelector('.overflow-y-auto') ||
				document.querySelector('main') ||
				document.documentElement;
		}

		findTargetMessageElement(queryIndex) {
			const query = this.queries[queryIndex];
			if (!query) return null;

			const userNodes = this.findUserMessageElements();

			// 1. Direct 1-to-1 index matching when node count matches query count
			if (userNodes.length === this.queries.length && userNodes[queryIndex]) {
				return userNodes[queryIndex];
			}

			// 2. Exact or substring matching inside userNodes
			const rawText = (query.text || '').trim().toLowerCase();
			if (rawText.length >= 6 && userNodes.length > 0) {
				const sample = rawText.slice(0, 30);
				for (let i = 0; i < userNodes.length; i++) {
					const nodeText = (userNodes[i].textContent || userNodes[i].innerText || '').trim().toLowerCase();
					if (nodeText.includes(sample)) {
						return userNodes[i];
					}
				}
			}

			// 3. Fallback to direct index in userNodes
			if (userNodes.length > queryIndex && userNodes[queryIndex]) {
				return userNodes[queryIndex];
			}

			return null;
		}

		scrollToQuery(index) {
			if (index < 0 || index >= this.queries.length) return;
			this.setActiveIndex(index);

			const targetEl = this.findTargetMessageElement(index);

			if (targetEl) {
				if (typeof targetEl.scrollIntoView === 'function') {
					targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
				}
				this._flashTargetElement(targetEl);
			} else {
				// Estimated scroll if virtualized
				const scrollContainer = this.findChatScrollContainer();

				if (scrollContainer && this.queries.length > 1) {
					const ratio = index / (this.queries.length - 1);
					const scrollTarget = ratio * (scrollContainer.scrollHeight - scrollContainer.clientHeight);
					if (typeof scrollContainer.scrollTo === 'function') {
						scrollContainer.scrollTo({ top: scrollTarget, behavior: 'smooth' });
					} else if (scrollContainer.scrollTop !== undefined) {
						scrollContainer.scrollTop = scrollTarget;
					}

					setTimeout(() => {
						const retryEl = this.findTargetMessageElement(index);
						if (retryEl) {
							if (typeof retryEl.scrollIntoView === 'function') {
								retryEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
							}
							this._flashTargetElement(retryEl);
						}
					}, 180);
				}
			}
		}

		_flashTargetElement(element) {
			if (!element) return;
			if (this._highlightTimeout) {
				clearTimeout(this._highlightTimeout);
			}
			element.classList?.remove?.('cc-query-target-highlight');
			if (element.offsetWidth !== undefined) {
				void element.offsetWidth;
			}
			element.classList?.add?.('cc-query-target-highlight');
			this._highlightTimeout = setTimeout(() => {
				element.classList?.remove?.('cc-query-target-highlight');
			}, 1900);
		}

		updateActiveFromScroll() {
			if (this.queries.length <= 1) return;
			const userNodes = this.findUserMessageElements();
			if (userNodes.length === 0) return;

			const targetTop = (typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800) * 0.35;
			let closestIndex = -1;
			let minDistance = Infinity;

			userNodes.forEach((node, idx) => {
				if (idx >= this.queries.length) return;
				if (typeof node.getBoundingClientRect === 'function') {
					const rect = node.getBoundingClientRect();
					const dist = Math.abs(rect.top - targetTop);
					if (dist < minDistance) {
						minDistance = dist;
						closestIndex = idx;
					}
				}
			});

			if (closestIndex >= 0 && closestIndex !== this.activeIndex) {
				this.setActiveIndex(closestIndex);
			}
		}

		destroy() {
			if (this._closeTimer) {
				clearTimeout(this._closeTimer);
				this._closeTimer = null;
			}
			if (this._onDocumentClick && typeof document.removeEventListener === 'function') {
				document.removeEventListener('pointerdown', this._onDocumentClick);
				document.removeEventListener('click', this._onDocumentClick);
			}
			if (this._onKeyDown && typeof document.removeEventListener === 'function') {
				document.removeEventListener('keydown', this._onKeyDown, true);
			}
			if (this._onScroll && typeof window.removeEventListener === 'function') {
				window.removeEventListener('scroll', this._onScroll, { capture: true });
			}
			if (this._scrollRaf && typeof cancelAnimationFrame === 'function') {
				cancelAnimationFrame(this._scrollRaf);
			}
			if (this.container && this.container.parentElement) {
				this.container.parentElement.removeChild(this.container);
			}
		}
	}

	CC.ui = {
		CounterUI,
		QueryNavigatorUI,
		formatQuerySnippet
	};
})();
