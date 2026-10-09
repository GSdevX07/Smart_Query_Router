/**
 * Smart Query Router - On-Device Local Answer UI Controller
 * 
 * CORE RESPONSIBILITIES:
 * 1. Renders an elegant, non-intrusive floating answer card when a deterministic
 *    query (e.g. arithmetic "5+2" or datetime lookup) is solved on-device.
 * 2. Prevents unnecessary cloud requests to Anthropic servers, saving 100% of LLM tokens.
 * 3. Provides clean user actions:
 *    - "Copy Answer": Copies calculated result to clipboard with visual confirmation.
 *    - "Insert into Prompt": Replaces prompt editor contents with the calculated result.
 *    - "Ask Claude Anyway": Bypasses local resolution and triggers native Claude submission.
 *    - "Dismiss": Dismisses the card (also mapped to the Escape key).
 * 4. Auto-dismisses after 30 seconds of inactivity to avoid visual clutter.
 * 5. UMD wrapper for cross-environment testing and browser execution.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SmartQueryRouterLocalAnswerUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ROOT_ID = 'smart-query-router-local-answer-root';
  const DEFAULT_AUTO_DISMISS_MS = 30000;

  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function applyInlineFormatting(text) {
    if (!text) return '';
    return text
      // Bold + Italic: ***text***
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      // Bold: **text**
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // Italic: *text*
      .replace(/(^|[^\*])\*([^\*\s][^\*]*?[^\*\s]|[^\*\s])\*(?!\*)/g, '$1<em>$2</em>')
      // Italic: _text_
      .replace(/(^|[^_])_([^_]+)_(?!_)/g, '$1<em>$2</em>');
  }

  /**
   * Transforms markdown text into safe, richly formatted HTML styled like Claude's native chat.
   * Eliminates raw markdown syntax (##, **, *, ---) and replaces them with styled elements.
   * @param {string} rawMarkdown
   * @returns {string}
   */
  function renderMarkdownToHtml(rawMarkdown) {
    if (!rawMarkdown || typeof rawMarkdown !== 'string') return '';

    const codeBlocks = [];
    const inlineCodes = [];

    // 1. Extract fenced code blocks (```lang\ncode\n``` or ```code```)
    let text = rawMarkdown.replace(/```([a-zA-Z0-9_-]*)\r?\n?([\s\S]*?)```/g, (match, lang, code) => {
      const placeholder = `__SQR_CODEBLOCK_${codeBlocks.length}__`;
      const escapedCode = escapeHtml(code.replace(/\r?\n$/, ''));
      const safeLang = escapeHtml(lang.trim());
      const headerHtml = safeLang
        ? `<div class="sqr-md-code-header"><span class="sqr-md-code-lang">${safeLang}</span></div>`
        : '';
      codeBlocks.push(
        `<div class="sqr-md-code-wrap">${headerHtml}<pre class="sqr-md-pre"><code class="sqr-md-code">${escapedCode}</code></pre></div>`
      );
      return placeholder;
    });

    // 2. Extract inline code (`code`)
    text = text.replace(/`([^`\r\n]+)`/g, (match, code) => {
      const placeholder = `__SQR_INLINE_${inlineCodes.length}__`;
      inlineCodes.push(`<code class="sqr-md-inline-code">${escapeHtml(code)}</code>`);
      return placeholder;
    });

    // 3. Escape all remaining raw HTML entities in regular text
    text = escapeHtml(text);

    // 4. Parse block structures line-by-line
    const rawLines = text.split(/\r?\n/);
    const outputBlocks = [];
    let currentList = null; // { type: 'ul' | 'ol', items: [] }
    let currentParagraph = [];

    function flushParagraph() {
      if (currentParagraph.length > 0) {
        const content = currentParagraph.join('<br>');
        if (content.trim()) {
          outputBlocks.push(`<p class="sqr-md-p">${applyInlineFormatting(content)}</p>`);
        }
        currentParagraph = [];
      }
    }

    function flushList() {
      if (currentList) {
        if (currentList.type === 'ul') {
          const itemsHtml = currentList.items
            .map((item) => `<li class="sqr-md-li">${applyInlineFormatting(item)}</li>`)
            .join('');
          outputBlocks.push(`<ul class="sqr-md-ul">${itemsHtml}</ul>`);
        } else if (currentList.type === 'ol') {
          const itemsHtml = currentList.items
            .map((item) => `<li class="sqr-md-oli">${applyInlineFormatting(item)}</li>`)
            .join('');
          outputBlocks.push(`<ol class="sqr-md-ol">${itemsHtml}</ol>`);
        }
        currentList = null;
      }
    }

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      const trimmed = line.trim();

      // Check for code block placeholder lines
      const codeBlockMatch = trimmed.match(/^(__SQR_CODEBLOCK_\d+__)$/);
      if (codeBlockMatch) {
        flushParagraph();
        flushList();
        outputBlocks.push(codeBlockMatch[1]);
        continue;
      }

      // Empty line
      if (!trimmed) {
        flushParagraph();
        flushList();
        continue;
      }

      // Horizontal Rule (--- or *** or ___)
      if (/^(?:---+|\*\*\*+|___+)\s*$/.test(trimmed)) {
        flushParagraph();
        flushList();
        outputBlocks.push('<hr class="sqr-md-hr">');
        continue;
      }

      // Headings: #, ##, ###, ####
      const h1Match = trimmed.match(/^#\s+(.+)$/);
      if (h1Match) {
        flushParagraph();
        flushList();
        outputBlocks.push(`<h2 class="sqr-md-h2">${applyInlineFormatting(h1Match[1])}</h2>`);
        continue;
      }

      const h2Match = trimmed.match(/^##\s+(.+)$/);
      if (h2Match) {
        flushParagraph();
        flushList();
        outputBlocks.push(`<h3 class="sqr-md-h3">${applyInlineFormatting(h2Match[1])}</h3>`);
        continue;
      }

      const h3Match = trimmed.match(/^###\s+(.+)$/);
      if (h3Match) {
        flushParagraph();
        flushList();
        outputBlocks.push(`<h4 class="sqr-md-h4">${applyInlineFormatting(h3Match[1])}</h4>`);
        continue;
      }

      const h4Match = trimmed.match(/^####\s+(.+)$/);
      if (h4Match) {
        flushParagraph();
        flushList();
        outputBlocks.push(`<h5 class="sqr-md-h5">${applyInlineFormatting(h4Match[1])}</h5>`);
        continue;
      }

      // Blockquote: > text or &gt; text
      const bqMatch = trimmed.match(/^(?:&gt;|>)\s*(.+)$/);
      if (bqMatch) {
        flushParagraph();
        flushList();
        outputBlocks.push(`<blockquote class="sqr-md-blockquote">${applyInlineFormatting(bqMatch[1])}</blockquote>`);
        continue;
      }

      // Bullet List: - item or * item
      const ulMatch = trimmed.match(/^(?:-|\*|\+)\s+(.+)$/);
      if (ulMatch) {
        flushParagraph();
        if (!currentList || currentList.type !== 'ul') {
          flushList();
          currentList = { type: 'ul', items: [] };
        }
        currentList.items.push(ulMatch[1]);
        continue;
      }

      // Numbered List: 1. item
      const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
      if (olMatch) {
        flushParagraph();
        if (!currentList || currentList.type !== 'ol') {
          flushList();
          currentList = { type: 'ol', items: [] };
        }
        currentList.items.push(olMatch[1]);
        continue;
      }

      // Regular line -> accumulate in current paragraph
      flushList();
      currentParagraph.push(line);
    }

    flushParagraph();
    flushList();

    let html = outputBlocks.join('');

    // 5. Restore inline code placeholders
    inlineCodes.forEach((codeHtml, idx) => {
      html = html.split(`__SQR_INLINE_${idx}__`).join(codeHtml);
    });

    // 6. Restore code block placeholders
    codeBlocks.forEach((blockHtml, idx) => {
      html = html.split(`__SQR_CODEBLOCK_${idx}__`).join(blockHtml);
    });

    return html;
  }

  class LocalAnswerUiController {
    /**
     * @param {object} [options]
     * @param {Document} [options.document] - Document context
     * @param {object} [options.userSettingsManager] - UserSettingsManager
     * @param {object} [options.logger] - DiagnosticLogger
     * @param {number} [options.autoDismissMs] - Auto-dismiss timeout (default: 30000ms)
     * @param {Function} [options.onInsertIntoEditor] - Callback (text) to insert into prompt editor
     */
    constructor(options = {}) {
      this.doc = options.document || (typeof document !== 'undefined' ? document : null);
      this.userSettingsManager = options.userSettingsManager || null;
      this.logger = options.logger || null;
      this.autoDismissMs = typeof options.autoDismissMs === 'number' ? options.autoDismissMs : DEFAULT_AUTO_DISMISS_MS;
      this.onInsertIntoEditor = typeof options.onInsertIntoEditor === 'function' ? options.onInsertIntoEditor : null;

      this.rootElement = null;
      this.currentData = null;
      this.dismissTimer = null;
      this.isVisible = false;

      this._setupKeyboardListener();
    }

    /**
     * Listen for Escape key to dismiss local answer card
     * @private
     */
    _setupKeyboardListener() {
      if (!this.doc) return;
      this.doc.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.isVisible) {
          this.hide();
        }
      }, { capture: true, passive: true });
    }

    /**
     * Ensures root container element exists in DOM
     * @private
     * @returns {HTMLElement|null}
     */
    _ensureRoot() {
      if (!this.doc) return null;
      if (this.rootElement && this.rootElement.isConnected !== false) {
        return this.rootElement;
      }

      let root = this.doc.getElementById(ROOT_ID);
      if (!root) {
        root = this.doc.createElement('div');
        root.id = ROOT_ID;
        root.className = 'smart-query-router-local-answer-container';
        if (this.doc.body) {
          this.doc.body.appendChild(root);
        }
      }
      this.rootElement = root;
      return root;
    }

    /**
     * Displays on-device local answer card or extension cache hit card
     * 
     * @param {object} params
     * @param {string} params.expression - Evaluated expression or query
     * @param {string|number} params.result - Computed result or cached answer
     * @param {string} [params.ruleId] - Identifying rule or cache identifier
     * @param {string} [params.rawQuery] - Original query string
     * @param {boolean} [params.isCache] - Whether this is an extension cache hit
     * @param {number} [params.tokensSaved] - Estimated tokens saved by cache hit
     * @param {number} [params.hitCount] - Cumulative hit count for cached query
     * @param {Function} [params.onAskClaudeAnyway] - Callback to submit natively to Claude
     * @param {HTMLElement} [params.editorElement] - Prompt editor element for contextual positioning
     */
    showAnswer({
      expression,
      result,
      ruleId = 'LOCAL_RULE',
      rawQuery = '',
      isMath = null,
      isCache = false,
      tokensSaved = 0,
      hitCount = 1,
      onAskClaudeAnyway = null,
      editorElement = null
    } = {}) {
      const root = this._ensureRoot();
      if (!root) return;

      this._clearDismissTimer();

      this.currentData = {
        expression: String(expression || rawQuery),
        result: String(result),
        ruleId,
        rawQuery: String(rawQuery || expression),
        isMath,
        isCache: Boolean(isCache || ruleId.includes('CACHE')),
        tokensSaved: Number(tokensSaved) || 0,
        hitCount: Number(hitCount) || 1,
        onAskClaudeAnyway,
        editorElement
      };

      this._render();
      this.isVisible = true;

      // Position near editor if editor is present and has getBoundingClientRect
      if (editorElement && typeof editorElement.getBoundingClientRect === 'function') {
        this._positionNearEditor(editorElement);
      }

      // Auto-dismiss after configured timeout
      if (this.autoDismissMs > 0) {
        this.dismissTimer = setTimeout(() => {
          this.hide();
        }, this.autoDismissMs);
      }

      if (this.logger && typeof this.logger.info === 'function') {
        this.logger.info('OPTIMIZATION_DECISION', 'Local answer card displayed to user', {
          ruleId,
          expression: this.currentData.expression,
          result: this.currentData.result
        });
      }
    }

    /**
     * Dynamically positions card right above prompt editor
     * @private
     */
    _positionNearEditor(editorElement) {
      if (!this.rootElement || !editorElement) return;
      try {
        const rect = editorElement.getBoundingClientRect();
        const card = this.rootElement.querySelector('.sqr-local-card');
        if (!card) return;

        const viewportWidth = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1200;
        const viewportHeight = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800;

        const isCache = Boolean(this.currentData && this.currentData.isCache);
        const targetWidth = isCache ? 540 : 400;
        const cardWidth = Math.min(targetWidth, Math.max(320, viewportWidth - 32));

        // Center card horizontally relative to the editor element's center
        const editorCenterX = rect.left + rect.width / 2;
        const idealLeft = editorCenterX - cardWidth / 2;

        // Clamp safely so the card never overflows the left or right edges of the screen
        const minLeft = 16;
        const maxLeft = Math.max(minLeft, viewportWidth - cardWidth - 16);
        const left = Math.max(minLeft, Math.min(maxLeft, idealLeft));

        // Position bottom directly above the top edge of the editor (with 12px padding)
        const bottomOffset = viewportHeight - rect.top + 12;
        const bottom = Math.max(16, Math.min(viewportHeight - 120, bottomOffset));

        card.style.position = 'fixed';
        card.style.left = `${Math.round(left)}px`;
        card.style.bottom = `${Math.round(bottom)}px`;
        card.style.width = `${Math.round(cardWidth)}px`;
        card.style.transform = 'none'; // Override default translateX(-50%) when explicitly positioned
      } catch (_) {
        // Fallback to default CSS positioning
      }
    }

    /**
     * Renders card content and binds button events
     * @private
     */
    _render() {
      const root = this._ensureRoot();
      if (!root || !this.currentData) return;

      const { expression, result, isMath, ruleId, isCache, tokensSaved, hitCount } = this.currentData;
      const isSimpleMath = !isCache && (isMath === true ||
        (isMath === null && (ruleId === 'RULE_LOCAL_DETERMINISTIC_ARITHMETIC' || /^[0-9\.\s\+\-\*\/\%\^\(\)\=]+$/.test(expression))));

      let badgeHtml = '⚡ Solved on-device · 0ms · $0';
      if (isCache) {
        const hitSuffix = hitCount > 1 ? ` (x${hitCount})` : '';
        const savedSuffix = tokensSaved > 0 ? ` · Saved ${tokensSaved} tokens` : '';
        badgeHtml = `⚡ Extension Cache Hit${hitSuffix}${savedSuffix} · 0ms · $0`;
      }

      const formattedAnswerHtml = isCache ? renderMarkdownToHtml(result) : escapeHtml(result);

      root.innerHTML = `
        <style>
          .smart-query-router-local-answer-container {
            position: fixed;
            inset: 0;
            z-index: 2147483647;
            pointer-events: none;
            overflow: hidden;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
            font-size: 12.5px;
            color: #f4f4f5;
          }
          .sqr-local-card {
            position: fixed;
            bottom: 90px;
            left: 50%;
            transform: translateX(-50%);
            width: ${isCache ? '540px' : '400px'};
            max-width: calc(100vw - 32px);
            max-height: calc(100vh - 120px);
            display: flex;
            flex-direction: column;
            padding: 14px 16px;
            background: rgba(18, 18, 22, 0.96);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 8px;
            box-shadow: 0 16px 40px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05);
            pointer-events: auto;
            box-sizing: border-box;
            z-index: 2147483647;
            animation: sqr-local-slideup 0.18s cubic-bezier(0.16, 1, 0.3, 1);
          }
          @keyframes sqr-local-slideup {
            from { opacity: 0; transform: translateY(6px); }
            to { opacity: 1; transform: translateY(0); }
          }
          .sqr-local-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 8px;
            flex-shrink: 0;
          }
          .sqr-local-badge {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            font-size: 10px;
            font-weight: 500;
            color: #e4e4e7;
            background: rgba(255, 255, 255, 0.07);
            padding: 2px 8px;
            border-radius: 9999px;
            border: 1px solid rgba(255, 255, 255, 0.12);
            letter-spacing: 0.02em;
          }
          .sqr-local-badge-cache {
            background: rgba(218, 119, 86, 0.15);
            border-color: rgba(218, 119, 86, 0.35);
            color: #ff9d79;
          }
          .sqr-local-close {
            background: none;
            border: none;
            color: #71717a;
            cursor: pointer;
            padding: 2px 4px;
            font-size: 13px;
            line-height: 1;
            border-radius: 3px;
            transition: color 0.15s ease;
          }
          .sqr-local-close:hover {
            color: #ffffff;
          }
          .sqr-local-content {
            display: flex;
            align-items: stretch;
            padding: 8px 0 12px 0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.06);
            overflow: hidden;
            flex: 1;
          }
          .sqr-local-cache-view {
            display: flex;
            flex-direction: column;
            gap: 8px;
            width: 100%;
            overflow: hidden;
          }
          .sqr-local-cache-query {
            font-size: 12px;
            color: #d4d4d8;
            font-weight: 500;
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 6px;
            padding: 8px 10px;
            max-height: 90px;
            overflow-y: auto;
            white-space: pre-wrap;
            word-break: break-word;
            line-height: 1.45;
            flex-shrink: 0;
          }
          .sqr-local-cache-answer {
            font-size: 13px;
            font-weight: 400;
            color: #f4f4f5;
            background: rgba(0, 0, 0, 0.35);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 6px;
            padding: 10px 12px;
            max-height: 330px;
            overflow-y: auto;
            white-space: normal;
            word-break: break-word;
            line-height: 1.55;
            flex: 1;
          }
          .sqr-local-cache-query::-webkit-scrollbar,
          .sqr-local-cache-answer::-webkit-scrollbar {
            width: 5px;
          }
          .sqr-local-cache-query::-webkit-scrollbar-thumb,
          .sqr-local-cache-answer::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.15);
            border-radius: 3px;
          }
          /* Claude-Style Rich Markdown Formatting */
          .sqr-md-h2 {
            font-size: 15.5px;
            font-weight: 600;
            color: #ffffff;
            margin: 12px 0 6px 0;
            line-height: 1.35;
          }
          .sqr-md-h3 {
            font-size: 14px;
            font-weight: 600;
            color: #ffffff;
            margin: 10px 0 5px 0;
            line-height: 1.35;
          }
          .sqr-md-h4, .sqr-md-h5 {
            font-size: 13px;
            font-weight: 600;
            color: #f4f4f5;
            margin: 8px 0 4px 0;
            line-height: 1.35;
          }
          .sqr-md-h2:first-child,
          .sqr-md-h3:first-child,
          .sqr-md-h4:first-child {
            margin-top: 0;
          }
          .sqr-md-p {
            font-size: 13px;
            line-height: 1.55;
            color: #e4e4e7;
            margin: 0 0 8px 0;
          }
          .sqr-md-p:last-child {
            margin-bottom: 0;
          }
          .sqr-md-p strong,
          .sqr-md-li strong,
          .sqr-md-oli strong {
            font-weight: 600;
            color: #ffffff;
          }
          .sqr-md-ul {
            margin: 6px 0 10px 0;
            padding-left: 18px;
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 4px;
          }
          .sqr-md-li {
            position: relative;
            font-size: 13px;
            line-height: 1.5;
            color: #e4e4e7;
            padding-left: 2px;
          }
          .sqr-md-li::before {
            content: "";
            position: absolute;
            left: -14px;
            top: 7px;
            width: 5px;
            height: 5px;
            border-radius: 50%;
            background-color: #da7756;
          }
          .sqr-md-ol {
            margin: 6px 0 10px 0;
            padding-left: 20px;
            display: flex;
            flex-direction: column;
            gap: 4px;
            list-style-type: decimal;
          }
          .sqr-md-oli {
            font-size: 13px;
            line-height: 1.5;
            color: #e4e4e7;
          }
          .sqr-md-hr {
            border: 0;
            height: 1px;
            background: rgba(255, 255, 255, 0.12);
            margin: 12px 0;
          }
          .sqr-md-blockquote {
            margin: 8px 0;
            padding: 6px 12px;
            border-left: 3px solid #da7756;
            background: rgba(218, 119, 86, 0.08);
            border-radius: 0 6px 6px 0;
            color: #e4e4e7;
            font-style: italic;
            font-size: 12.5px;
            line-height: 1.5;
          }
          .sqr-md-inline-code {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 11.5px;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.14);
            padding: 1px 5px;
            border-radius: 4px;
            color: #ff9d79;
          }
          .sqr-md-code-wrap {
            margin: 8px 0;
            border-radius: 6px;
            background: #0d0d11;
            border: 1px solid rgba(255, 255, 255, 0.1);
            overflow: hidden;
          }
          .sqr-md-code-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 4px 10px;
            background: rgba(255, 255, 255, 0.04);
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            font-size: 10.5px;
            color: #a1a1aa;
            font-family: ui-monospace, SFMono-Regular, monospace;
            text-transform: lowercase;
          }
          .sqr-md-code-lang {
            color: #da7756;
            font-weight: 500;
          }
          .sqr-md-pre {
            margin: 0;
            padding: 10px 12px;
            overflow-x: auto;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 12px;
            line-height: 1.45;
            color: #f4f4f5;
          }
          .sqr-md-code {
            font-family: inherit;
            font-size: inherit;
            background: transparent;
            padding: 0;
            border: none;
            white-space: pre;
          }
          .sqr-local-calc {
            display: flex;
            align-items: baseline;
            gap: 8px;
            width: 100%;
            overflow: hidden;
          }
          .sqr-local-calc.is-text {
            flex-direction: column;
            align-items: flex-start;
            gap: 4px;
          }
          .sqr-local-expr {
            font-size: 14px;
            color: #a1a1aa;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            max-width: 60%;
          }
          .sqr-local-calc.is-text .sqr-local-expr {
            font-size: 11.5px;
            color: #71717a;
            max-width: 100%;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
            text-transform: capitalize;
          }
          .sqr-local-equals {
            font-size: 14px;
            font-weight: 600;
            color: #52525b;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          }
          .sqr-local-result {
            font-size: 20px;
            font-weight: 600;
            color: #ffffff;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            letter-spacing: -0.02em;
            margin-left: auto;
            font-variant-numeric: tabular-nums;
          }
          .sqr-local-result.sqr-local-result-text {
            font-size: 16px;
            font-weight: 600;
            color: #ffffff;
            margin-left: 0;
            white-space: normal;
            word-break: break-word;
            line-height: 1.35;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
          }
          .sqr-local-actions {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-top: 10px;
            flex-shrink: 0;
          }
          .sqr-action-btn {
            flex: 1;
            padding: 6px 10px;
            font-size: 11px;
            font-weight: 500;
            border-radius: 6px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            cursor: pointer;
            transition: all 0.15s ease;
            background: rgba(255, 255, 255, 0.05);
            color: #e4e4e7;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            white-space: nowrap;
          }
          .sqr-action-btn:hover {
            background: rgba(255, 255, 255, 0.12);
            border-color: rgba(255, 255, 255, 0.22);
            color: #ffffff;
          }
          .sqr-action-btn-primary {
            background: #e4e4e7;
            border-color: #ffffff;
            color: #0c0c0e;
            font-weight: 600;
          }
          .sqr-action-btn-primary:hover {
            background: #ffffff;
            border-color: #ffffff;
            color: #000000;
          }
          .sqr-action-btn-secondary {
            background: transparent;
            border-color: transparent;
            color: #71717a;
            flex: 0 0 auto;
            padding: 6px 8px;
          }
          .sqr-action-btn-secondary:hover {
            background: rgba(255, 255, 255, 0.06);
            color: #d4d4d8;
          }
        </style>
        <div class="sqr-local-card" role="dialog" aria-label="Smart Query Router Local Answer">
          <div class="sqr-local-header">
            <span class="sqr-local-badge ${isCache ? 'sqr-local-badge-cache' : ''}">${badgeHtml}</span>
            <button class="sqr-local-close" id="sqr-local-btn-close" title="Dismiss (Escape)" aria-label="Close">✕</button>
          </div>
          <div class="sqr-local-content">
            ${isCache ? `
              <div class="sqr-local-cache-view">
                <div class="sqr-local-cache-query" title="${escapeHtml(expression)}"><strong style="color:#ff9d79;">Prompt:</strong> ${escapeHtml(expression)}</div>
                <div class="sqr-local-cache-answer" id="sqr-local-result-val">${formattedAnswerHtml}</div>
              </div>
            ` : `
              <div class="sqr-local-calc ${isSimpleMath ? 'is-math' : 'is-text'}">
                <span class="sqr-local-expr" title="${escapeHtml(expression)}">${escapeHtml(expression)}</span>
                ${isSimpleMath ? '<span class="sqr-local-equals">=</span>' : '<span class="sqr-local-equals" style="display:none">=</span>'}
                <span class="sqr-local-result ${isSimpleMath ? '' : 'sqr-local-result-text'}" id="sqr-local-result-val">${formattedAnswerHtml}</span>
              </div>
            `}
          </div>
          <div class="sqr-local-actions">
            <button class="sqr-action-btn sqr-action-btn-primary" id="sqr-local-btn-copy">Copy</button>
            <button class="sqr-action-btn" id="sqr-local-btn-insert">Insert</button>
            <button class="sqr-action-btn sqr-action-btn-secondary" id="sqr-local-btn-ask" title="Send to Claude anyway">Ask Claude</button>
          </div>
        </div>
      `;

      // Bind actions
      const closeBtn = root.querySelector('#sqr-local-btn-close');
      const copyBtn = root.querySelector('#sqr-local-btn-copy');
      const insertBtn = root.querySelector('#sqr-local-btn-insert');
      const askBtn = root.querySelector('#sqr-local-btn-ask');

      if (closeBtn) {
        closeBtn.addEventListener('click', () => this.hide());
      }

      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          this._copyResultToClipboard(copyBtn, result);
        });
      }

      if (insertBtn) {
        insertBtn.addEventListener('click', () => {
          this._insertResultIntoPrompt(result);
        });
      }

      if (askBtn) {
        askBtn.addEventListener('click', () => {
          this._handleAskClaudeAnyway();
        });
      }
    }

    /**
     * Copy result to system clipboard
     * @private
     */
    _copyResultToClipboard(btnElement, textToCopy) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(String(textToCopy)).then(() => {
            btnElement.textContent = '✓ Copied!';
            setTimeout(() => {
              if (btnElement) btnElement.textContent = '📋 Copy';
            }, 1800);
          }).catch(() => {
            btnElement.textContent = '✓ Copied!';
          });
        } else {
          btnElement.textContent = '✓ Copied!';
        }
      } catch (_) {
        btnElement.textContent = '✓ Copied!';
      }
    }

    /**
     * Insert result into Claude prompt box
     * @private
     */
    _insertResultIntoPrompt(resultText) {
      if (this.onInsertIntoEditor && typeof this.onInsertIntoEditor === 'function') {
        this.onInsertIntoEditor(String(resultText));
      } else if (this.currentData && this.currentData.editorElement) {
        const ed = this.currentData.editorElement;
        ed.innerText = String(resultText);
        ed.textContent = String(resultText);
        try {
          if (typeof InputEvent !== 'undefined') {
            ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
          }
        } catch (_) {}
      }
      this.hide();
    }

    /**
     * Trigger Claude native send bypass
     * @private
     */
    _handleAskClaudeAnyway() {
      const callback = this.currentData ? this.currentData.onAskClaudeAnyway : null;
      this.hide();
      if (typeof callback === 'function') {
        callback();
      }
    }

    /**
     * Dismiss and remove local answer card
     */
    hide() {
      this._clearDismissTimer();
      this.isVisible = false;
      this.currentData = null;
      if (this.rootElement) {
        this.rootElement.innerHTML = '';
      }
    }

    /**
     * Clear active dismiss timer
     * @private
     */
    _clearDismissTimer() {
      if (this.dismissTimer) {
        clearTimeout(this.dismissTimer);
        this.dismissTimer = null;
      }
    }
  }

  return {
    ROOT_ID,
    DEFAULT_AUTO_DISMISS_MS,
    LocalAnswerUiController,
    escapeHtml,
    renderMarkdownToHtml,
    applyInlineFormatting
  };
});
