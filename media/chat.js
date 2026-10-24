/* Coding Harness — agent panel client.

   Plain JS, no build step. The extension owns all state; this file renders the
   transcript items it posts and sends user intent back.

   Two things are worth knowing before editing:
   - assistant text is real Markdown (headings, lists, tables, code), rendered
     here with an escaping-first parser because the panel has no dependencies;
   - streamed items are patched in place, so a long answer does not rebuild its
     subtree on every token (that used to reset scroll and kill the selection). */
(function () {
  const vscode = acquireVsCodeApi();

  const stream = document.getElementById('stream');
  const empty = document.getElementById('empty');
  const emptyNote = document.getElementById('empty-note');
  const input = document.getElementById('input');
  const btnSend = document.getElementById('btn-send');
  const btnStop = document.getElementById('btn-stop');
  const btnRevert = document.getElementById('btn-revert');
  const btnReset = document.getElementById('btn-reset');
  const btnSettings = document.getElementById('btn-settings');
  const btnSelection = document.getElementById('btn-selection');
  const btnCompact = document.getElementById('btn-compact');
  const btnMcp = document.getElementById('btn-mcp');
  const btnAgents = document.getElementById('btn-agents');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const chipProvider = document.getElementById('chip-provider');
  const chipPolicy = document.getElementById('chip-policy');
  const chipWorkspace = document.getElementById('chip-workspace');
  const chipTokens = document.getElementById('chip-tokens');
  const chipSpeed = document.getElementById('chip-speed');
  const chipContext = document.getElementById('chip-context');
  const chipMcp = document.getElementById('chip-mcp');
  const chipAgents = document.getElementById('chip-agents');
  const chipStream = document.getElementById('chip-stream');
  const chipThinking = document.getElementById('chip-thinking');
  const hintUsage = document.getElementById('hint-usage');
  const activityBox = document.getElementById('activity');
  const activityText = document.getElementById('activity-text');
  const activityDetail = document.getElementById('activity-detail');
  const activityElapsed = document.getElementById('activity-elapsed');
  const btnJump = document.getElementById('jump-latest');
  const compactBanner = document.getElementById('compact-banner');
  const compactText = document.getElementById('compact-text');
  const btnCompactBanner = document.getElementById('btn-compact-banner');
  const btnCompactDismiss = document.getElementById('btn-compact-dismiss');
  const attachments = document.getElementById('attachments');
  const btnAttach = document.getElementById('btn-attach');
  const fileInput = document.getElementById('file-input');

  /** @type {Map<string, any>} */
  const items = new Map();
  /** @type {Map<string, HTMLElement>} */
  const elements = new Map();
  let busy = false;
  /** Latest activity payload from the extension (drives the live strip). */
  let activity = null;
  let streamEnabled = true;
  let thinkingEnabled = true;
  /** Auto-follow the transcript, until the reader scrolls up to inspect something. */
  let stickToBottom = true;
  /** Token tracking for the live speed/context readout. */
  let cumulativeUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let currentSpeed = 0;
  let contextWindow = 128000;
  let contextTokens = 0;
  let contextPercent = 0;
  let codeSeq = 0;

  /* Images staged for the next message: { id, name, mediaType, dataUrl, bytes }. */
  const pending = [];
  let attachmentSeq = 0;
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_IMAGES = 8;

  /* ------------------------------------------------------------ helpers */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** `<svg class="icon"><use href="#i-name"></use></svg>` */
  function icon(name, className) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon' + (className ? ' ' + className : ''));
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function oneLine(text, limit) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    const max = limit || 110;
    return flat.length > max ? flat.slice(0, max - 1) + '\u2026' : flat;
  }

  function formatMs(ms) {
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return Math.round(ms / 60000) + 'm';
  }

  function formatTokens(n) {
    if (n == null) return '0';
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1) + 'k';
    return Math.round(n / 1000) + 'k';
  }

  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /* ----------------------------------------------------------- markdown */

  /* Inline formatting. The text is escaped *before* any tag is added, so model
     output can never inject markup; only the tags built here reach innerHTML. */
  function inlineMarkdown(text) {
    const codes = [];
    let out = escapeHtml(text).replace(/`([^`\n]+)`/g, (_match, code) => {
      codes.push(code);
      return '\u0000' + (codes.length - 1) + '\u0000';
    });

    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\s([{>])__([^_\n]+)__/g, '$1<strong>$2</strong>');
    out = out.replace(/(^|[\s([{>])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/(^|[\s([{>])_([^_\n]+)_/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    return out.replace(/\u0000(\d+)\u0000/g, (_match, index) => '<code>' + codes[Number(index)] + '</code>');
  }

  function codeBlockHtml(lang, code) {
    const id = 'code-' + ++codeSeq;
    const label = lang ? escapeHtml(lang) : 'text';
    return (
      '<div class="code-block">' +
      '<div class="code-head">' +
      '<span class="code-lang">' + label + '</span>' +
      '<button type="button" class="code-btn code-insert" data-target="' + id + '" title="Insert at the cursor in the active editor">insert</button>' +
      '<button type="button" class="code-btn code-copy" data-target="' + id + '" title="Copy this code">copy</button>' +
      '</div>' +
      '<pre id="' + id + '"><code>' + escapeHtml(code) + '</code></pre>' +
      '</div>'
    );
  }

  const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const BLOCK_START_RE = /^(\s*```|#{1,6}\s|\s*>|\s*([-*+]|\d+[.)])\s+|\s*\|)/;

  function renderList(lines, start) {
    const first = LIST_RE.exec(lines[start]);
    const ordered = /^\d/.test(first[2]);
    const indent = first[1].length;
    let html = ordered ? '<ol>' : '<ul>';
    let i = start;
    while (i < lines.length) {
      const match = LIST_RE.exec(lines[i]);
      if (!match) break;
      if (match[1].length < indent) break;
      if (match[1].length > indent) break;
      if (/^\d/.test(match[2]) !== ordered) break;

      let text = match[3];
      let nested = '';
      i += 1;
      // Continuation lines and nested lists belong to this item.
      while (i < lines.length) {
        const next = LIST_RE.exec(lines[i]);
        if (next && next[1].length > indent) {
          const sub = renderList(lines, i);
          nested += sub.html;
          i = sub.next;
          continue;
        }
        if (next) break;
        if (!lines[i].trim()) {
          const after = lines[i + 1] || '';
          if (new RegExp('^\\s{' + (indent + 2) + ',}\\S').test(after)) {
            i += 1;
            continue;
          }
          break;
        }
        const leading = lines[i].match(/^\s*/)[0].length;
        if (leading > indent) {
          text += '\n' + lines[i].trim();
          i += 1;
          continue;
        }
        break;
      }

      let prefix = '';
      const task = /^\[([ xX])\]\s+/.exec(text);
      if (task) {
        prefix = '<span class="task' + (task[1] === ' ' ? '' : ' done') + '">' + (task[1] === ' ' ? '\u2610' : '\u2611') + '</span> ';
        text = text.slice(task[0].length);
      }
      const body = inlineMarkdown(text).replace(/\n/g, '<br>');
      html += '<li>' + prefix + body + nested + '</li>';
    }
    html += ordered ? '</ol>' : '</ul>';
    return { html, next: i };
  }

  /* Alignment is a class, not a style attribute: the panel CSP allows the
     stylesheet but not inline styles. */
  function alignClass(align) {
    if (align === 'center') return ' class="ta-center"';
    if (align === 'right') return ' class="ta-right"';
    return '';
  }

  function renderTable(lines, start) {
    const split = (row) =>
      row
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim());
    const header = split(lines[start]);
    const align = split(lines[start + 1]).map((cell) => {
      if (/^:-+:$/.test(cell)) return 'center';
      if (/^-+:$/.test(cell)) return 'right';
      return 'left';
    });
    let html = '<table><thead><tr>';
    header.forEach((cell, index) => {
      html += '<th' + alignClass(align[index]) + '>' + inlineMarkdown(cell) + '</th>';
    });
    html += '</tr></thead><tbody>';
    let i = start + 2;
    while (i < lines.length && /^\s*\|/.test(lines[i])) {
      const cells = split(lines[i]);
      html += '<tr>';
      for (let c = 0; c < header.length; c += 1) {
        html += '<td' + alignClass(align[c]) + '>' + inlineMarkdown(cells[c] || '') + '</td>';
      }
      html += '</tr>';
      i += 1;
    }
    html += '</tbody></table>';
    return { html, next: i };
  }

  /** Markdown -> HTML. Escaping happens first; only tags built here are emitted. */
  function renderMarkdown(source) {
    const lines = String(source == null ? '' : source).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) {
        i += 1;
        continue;
      }

      // Fenced code: ```lang … ```
      const fence = /^\s*```(.*)$/.exec(line);
      if (fence) {
        const lang = fence[1].trim().split(/\s+/)[0] || '';
        const body = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          body.push(lines[i]);
          i += 1;
        }
        i += 1;
        out.push(codeBlockHtml(lang, body.join('\n')));
        continue;
      }

      const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) {
        const level = heading[1].length;
        out.push('<h' + level + '>' + inlineMarkdown(heading[2]) + '</h' + level + '>');
        i += 1;
        continue;
      }

      if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
        out.push('<hr>');
        i += 1;
        continue;
      }

      if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const table = renderTable(lines, i);
        out.push(table.html);
        i = table.next;
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quoted = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quoted.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        out.push('<blockquote>' + renderMarkdown(quoted.join('\n')) + '</blockquote>');
        continue;
      }

      if (LIST_RE.test(line)) {
        const list = renderList(lines, i);
        out.push(list.html);
        i = list.next;
        continue;
      }

      // Paragraph: stop at a blank line or the start of another block.
      const paragraph = [line];
      i += 1;
      while (i < lines.length && lines[i].trim() && !BLOCK_START_RE.test(lines[i])) {
        paragraph.push(lines[i]);
        i += 1;
      }
      out.push('<p>' + paragraph.map((part) => inlineMarkdown(part)).join('<br>') + '</p>');
    }
    return out.join('');
  }

  /* ------------------------------------------------------------ status */

  function setStatus(status, step, maxSteps) {
    const labels = {
      idle: 'Idle',
      thinking: 'Thinking',
      executing: 'Running tools',
      approval: 'Waiting for approval',
      running: 'Working',
    };
    let text = labels[status] || status || 'Idle';
    if ((status === 'thinking' || status === 'executing') && step) {
      text += ' · step ' + step + (maxSteps ? '/' + maxSteps : '');
    }
    statusText.textContent = text;
    statusDot.dataset.status = status || 'idle';
  }

  function updateTokenChips() {
    const total = cumulativeUsage.totalTokens || 0;
    const inputTokens = cumulativeUsage.inputTokens || 0;
    const outputTokens = cumulativeUsage.outputTokens || 0;
    if (chipTokens) {
      chipTokens.textContent = formatTokens(total) + ' tokens';
      chipTokens.title = 'Input: ' + inputTokens + ' · Output: ' + outputTokens + ' · Total: ' + total;
      chipTokens.hidden = total === 0;
    }
    if (chipSpeed) {
      const show = currentSpeed > 0 && total > 0;
      chipSpeed.hidden = !show;
      if (show) {
        chipSpeed.textContent = currentSpeed.toFixed(1) + ' tok/s';
        chipSpeed.title = 'Generation speed, last turn';
      }
    }
    if (chipContext) {
      const pct = contextPercent || 0;
      chipContext.textContent = 'ctx ' + Math.round(pct) + '%';
      chipContext.title = 'Context: ' + contextTokens + ' / ' + contextWindow + ' tokens (' + Math.round(pct) + '%) — click to preview the system message';
      chipContext.classList.toggle('warn', pct >= 75 && pct < 90);
      chipContext.classList.toggle('error', pct >= 90);
      if (compactBanner && compactText) {
        if (pct >= 75 && !busy) {
          compactBanner.hidden = false;
          compactText.textContent =
            pct >= 90
              ? 'Context ' + Math.round(pct) + '% full (' + contextTokens + '/' + contextWindow + ' tokens). Compact to avoid truncation.'
              : 'Context ' + Math.round(pct) + '% used. Compacting frees space for the next task.';
        } else if (pct < 70) {
          compactBanner.hidden = true;
        }
      }
    }
  }

  /** Active count and discovered count for the empty state and the chip. */
  function agentCounts(state) {
    const files = Array.isArray(state.agentFiles) ? state.agentFiles : [];
    const available = typeof state.agentFilesAvailable === 'number' ? state.agentFilesAvailable : files.length;
    const pinned = Array.isArray(state.agentSelection) && state.agentSelection.length > 0;
    return { files, available, pinned };
  }

  function applyEmptyNote(state) {
    if (!emptyNote) return;
    const { files, available, pinned } = agentCounts(state);
    if (state.agentFilesEnabled === false) {
      emptyNote.innerHTML =
        'Instruction loading is off, so the agent gets context but no guidance. Enable <code>codingHarness.agentFiles.enabled</code>.';
      return;
    }
    if (available === 0) {
      emptyNote.innerHTML =
        'No instruction files found. Add <code>agent.md</code>, or any <code>.md</code> inside <code>.agents/</code>.';
      return;
    }
    const shown = files.slice(0, 3).map((file) => '<code>' + escapeHtml(file.displayPath) + '</code>');
    const more = files.length > shown.length ? ' +' + (files.length - shown.length) + ' more' : '';
    const scope = pinned ? files.length + ' of ' + available : String(available);
    emptyNote.innerHTML = scope + ' instruction file(s) loaded: ' + shown.join(', ') + more;
  }

  function applyState(state) {
    if (!state) return;
    busy = Boolean(state.busy);
    btnSend.disabled = busy;
    btnStop.hidden = !busy;

    if (chipProvider) {
      const provider = state.provider || 'mock';
      chipProvider.textContent = provider + (state.model ? ' · ' + state.model : '');
      chipProvider.title = state.keyPresent
        ? 'API key: configured'
        : provider === 'mock'
          ? 'Offline planner — no API key needed'
          : 'No API key configured (Coding Harness: Set API Key)';
      chipProvider.classList.toggle('warn', !state.keyPresent && provider !== 'mock');
    }

    if (chipPolicy) {
      chipPolicy.textContent = 'edits: ' + state.editPolicy + ' · shell: ' + state.commandPolicy;
      chipPolicy.title =
        'File writes: ' + state.editPolicy + '\nShell commands: ' + state.commandPolicy + '\nChange both in settings.';
    }

    if (chipAgents) {
      const { files, available, pinned } = agentCounts(state);
      const enabled = state.agentFilesEnabled !== false;
      chipAgents.classList.remove('warn');
      chipAgents.classList.toggle('pinned', pinned);
      if (!enabled) {
        chipAgents.textContent = 'agents: off';
        chipAgents.classList.add('warn');
        chipAgents.title = 'Instruction loading is disabled (codingHarness.agentFiles.enabled). Click to open the setting.';
      } else if (available === 0) {
        chipAgents.textContent = 'agents: none';
        chipAgents.classList.add('warn');
        chipAgents.title = 'No instruction files found — click to create agent.md. The extension has no built-in prompt.';
      } else {
        // `2/3` means a pinned subset is in use; a bare number is everything.
        chipAgents.textContent = 'agents: ' + files.length + (pinned ? '/' + available : '');
        const names = files.map((file) => file.displayPath).join('\n');
        chipAgents.title = pinned
          ? 'Active (' + files.length + ' of ' + available + '):\n' + names + '\n\nPinned for this workspace. Click to change.'
          : 'All ' + available + ' instruction file(s):\n' + names + '\n\nClick to choose which ones are sent.';
      }
    }

    if (chipStream) {
      streamEnabled = state.stream !== false;
      chipStream.textContent = 'stream: ' + (streamEnabled ? 'on' : 'off');
      chipStream.title = streamEnabled
        ? 'Model output is rendered token by token'
        : 'Streaming disabled (codingHarness.stream = false)';
      chipStream.hidden = streamEnabled;
      chipStream.classList.toggle('warn', !streamEnabled);
    }

    if (chipThinking) {
      thinkingEnabled = state.showThinking !== false;
      chipThinking.textContent = 'thinking: ' + (thinkingEnabled ? 'shown' : 'hidden');
      chipThinking.title = thinkingEnabled
        ? "The model's reasoning stream is shown in its own lane"
        : 'Reasoning hidden (codingHarness.showThinking = false)';
      chipThinking.hidden = thinkingEnabled;
      chipThinking.classList.toggle('warn', !thinkingEnabled);
    }

    if (chipWorkspace) {
      const workspace = state.workspace || '';
      const base = workspace.split(/[\\/]/).filter(Boolean).pop() || '';
      chipWorkspace.textContent = base || 'no folder';
      chipWorkspace.title = workspace;
      chipWorkspace.hidden = !workspace;
    }

    if (state.usage) {
      cumulativeUsage = {
        inputTokens: state.usage.inputTokens || cumulativeUsage.inputTokens,
        outputTokens: state.usage.outputTokens || cumulativeUsage.outputTokens,
        totalTokens:
          state.usage.totalTokens ||
          (state.usage.inputTokens || 0) + (state.usage.outputTokens || 0) ||
          cumulativeUsage.totalTokens,
      };
    }
    if (state.cumulativeUsage) cumulativeUsage = state.cumulativeUsage;
    if (typeof state.tokensPerSecond === 'number') currentSpeed = state.tokensPerSecond;
    if (typeof state.contextWindow === 'number') contextWindow = state.contextWindow;
    if (typeof state.contextTokens === 'number') contextTokens = state.contextTokens;
    if (typeof state.contextPercent === 'number') contextPercent = state.contextPercent;
    else if (contextWindow && contextTokens) contextPercent = (contextTokens / contextWindow) * 100;

    if (chipMcp) {
      const configured = state.mcpConfigured || 0;
      const running = state.mcpServers || 0;
      const tools = state.mcpToolCount || 0;
      chipMcp.classList.remove('warn');
      if (state.mcpEnabled) {
        chipMcp.textContent = 'mcp: ' + running + ' srv · ' + tools + ' tools';
        chipMcp.title =
          'MCP enabled: ' + running + ' connected server(s), ' + tools + ' tool(s), ' + configured + ' configured. Click to configure.';
        chipMcp.hidden = configured === 0 && running === 0 && tools === 0;
      } else if (configured > 0) {
        chipMcp.textContent = 'mcp: off';
        chipMcp.title = 'MCP is disabled (codingHarness.mcp.enabled)';
        chipMcp.hidden = false;
        chipMcp.classList.add('warn');
      } else {
        chipMcp.hidden = true;
      }
    }

    applyEmptyNote(state);
    updateTokenChips();
    setStatus(state.status === 'running' ? (busy ? 'running' : 'idle') : state.status, state.step, state.maxSteps);
  }

  function applyActivity(next) {
    if (!next) return;
    activity = next;
    const active = next.status && next.status !== 'idle';
    activityBox.hidden = !active;
    activityBox.dataset.status = next.status || 'idle';
    if (!active) {
      activityElapsed.textContent = '';
      return;
    }
    const labels = {
      thinking: 'Thinking',
      executing: 'Running ' + (next.tool || 'tool'),
      approval: 'Waiting for your approval',
      running: 'Working',
      idle: 'Idle',
    };
    activityText.textContent = labels[next.status] || next.status;
    activityDetail.textContent =
      next.detail || (next.step ? 'step ' + next.step + (next.maxSteps ? '/' + next.maxSteps : '') : '');
    tickActivity();
  }

  function tickActivity() {
    if (!activity || !activity.status || activity.status === 'idle') return;
    const seconds = Math.max(0, Math.round((Date.now() - (activity.startedAt || Date.now())) / 1000));
    activityElapsed.textContent = seconds >= 1 ? seconds + 's' : '';
  }

  /**
   * Kept for compatibility with the layout tests. Streaming thinking has no
   * inner scrollbar (max-height:none in CSS), so the outer autoScroll follows
   * it; forcing an inner scrollTop here used to make the block jump.
   */
  function tickThinking() {
    // Intentionally empty — see the comment above.
  }

  function tickRunningTools() {
    for (const node of stream.querySelectorAll('.tool.running')) {
      const started = Number(node.dataset.startedAt || 0);
      const time = node.querySelector('.tool-time');
      if (!started || !time) continue;
      const seconds = (Date.now() - started) / 1000;
      time.textContent = seconds < 60 ? seconds.toFixed(1) + 's' : Math.round(seconds / 60) + 'm';
    }
  }

  function nearBottom() {
    return stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120;
  }

  /**
   * Follow the newest output, but do not yank the view back down while the
   * reader is scrolled up reading earlier tool calls — offer the jump button
   * instead.
   */
  function autoScroll(force) {
    const atBottom = nearBottom();
    if (force || stickToBottom || atBottom) {
      stickToBottom = true;
      stream.scrollTop = stream.scrollHeight;
      btnJump.hidden = true;
      return;
    }
    btnJump.hidden = false;
  }

  stream.addEventListener('scroll', () => {
    if (nearBottom()) {
      stickToBottom = true;
      btnJump.hidden = true;
    } else {
      stickToBottom = false;
      btnJump.hidden = false;
    }
  });

  btnJump.addEventListener('click', () => {
    stickToBottom = true;
    btnJump.hidden = true;
    stream.scrollTop = stream.scrollHeight;
  });

  function toggleEmpty() {
    if (items.size === 0) {
      if (!empty.parentElement) stream.appendChild(empty);
    } else if (empty.parentElement) {
      empty.remove();
    }
  }

  /* -------------------------------------------------------- small pieces */

  function copyText(text, button) {
    vscode.postMessage({ type: 'copy', text: String(text == null ? '' : text) });
    if (!button) return;
    button.classList.add('copied');
    // Icon-only buttons have no <span>; never write text into them, or the SVG
    // glyph is destroyed. They report success through colour and the tooltip.
    const label = button.querySelector('span');
    const original = label ? label.textContent : button.title;
    if (label) label.textContent = 'Copied';
    else button.title = 'Copied';
    setTimeout(() => {
      button.classList.remove('copied');
      if (label) label.textContent = original;
      else button.title = original;
    }, 1200);
  }

  function actionButton(iconName, title, onClick) {
    const button = el('button', 'icon-btn');
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.appendChild(icon(iconName));
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function caretInto(container) {
    const caret = el('span', 'caret');
    const last = container.lastElementChild;
    const blockTags = ['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'BLOCKQUOTE'];
    if (last && blockTags.indexOf(last.tagName) !== -1) last.appendChild(caret);
    else container.appendChild(caret);
  }

  function toolIconName(name) {
    switch (name) {
      case 'read_file':
      case 'list_files':
      case 'open_file':
        return 'file';
      case 'create_file':
      case 'write_file':
      case 'replace_in_file':
        return 'pencil';
      case 'delete_file':
        return 'trash';
      case 'search_text':
        return 'search';
      case 'run_command':
        return 'terminal';
      case 'get_diagnostics':
        return 'warn';
      default:
        return name && name.indexOf('mcp_') === 0 ? 'plug' : 'terminal';
    }
  }

  /** The one argument worth showing in a collapsed tool row. */
  function primaryArg(item) {
    let args = {};
    try {
      args = JSON.parse(item.args || '{}') || {};
    } catch {
      return oneLine(item.args, 60);
    }
    if (item.name === 'run_command' && args.command) return args.command;
    return (
      args.path ||
      args.file ||
      args.pattern ||
      args.query ||
      args.glob ||
      args.command ||
      args.url ||
      ''
    );
  }

  /* ------------------------------------------------------------ renderers */

  function renderItem(item) {
    switch (item.kind) {
      case 'user':
        return renderUser(item);
      case 'assistant':
        return renderAssistant(item);
      case 'thinking':
        return renderThinking(item);
      case 'notice':
        return renderNotice(item);
      case 'tool':
        return renderTool(item);
      case 'approval':
        return renderApproval(item);
      case 'done':
        return renderDone(item);
      default:
        return el('div', 'msg notice', JSON.stringify(item));
    }
  }

  function renderUser(item) {
    const node = el('div', 'msg user');
    node.dataset.id = item.id;
    const head = el('div', 'msg-head');
    head.appendChild(el('span', null, 'You'));
    if (item.text) {
      const actions = el('div', 'msg-actions');
      actions.appendChild(actionButton('copy', 'Copy this message', () => copyText(item.text)));
      head.appendChild(actions);
    }
    node.appendChild(head);
    if (item.text) node.appendChild(el('div', 'msg-text', item.text));
    if (item.images && item.images.length) node.appendChild(renderUserImages(item.images));
    return node;
  }

  function renderAssistant(item) {
    const node = el('div', 'msg assistant' + (item.streaming ? ' streaming' : ''));
    node.dataset.id = item.id;
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', 'Assistant');

    const body = el('div', 'msg-body prose');
    body.innerHTML = renderMarkdown(item.text);
    if (item.streaming) caretInto(body);
    node.appendChild(body);

    if (!item.streaming && item.text) {
      const head = el('div', 'msg-actions assistant-actions');
      head.appendChild(actionButton('copy', 'Copy this answer', () => copyText(item.text)));
      node.appendChild(head);
    }
    return node;
  }

  /**
   * The reasoning lane. Expanded and following along while the model is
   * thinking, then collapsed to a one-line summary once the answer lands so it
   * does not crowd out the actual results.
   */
  function renderThinking(item) {
    const node = el('div', 'thinking' + (item.streaming ? ' open' : ''));
    node.dataset.id = item.id;
    if (item.open) {
      node.classList.add('open');
      node.dataset.userOpen = '1';
    }

    const head = el('div', 'thinking-head');
    head.appendChild(icon('spark', 'thinking-icon'));
    head.appendChild(el('span', 'thinking-label', item.streaming ? 'Thinking' : 'Thought'));
    const preview = el('span', 'thinking-preview');
    preview.textContent = item.streaming ? '' : oneLine(item.text);
    head.appendChild(preview);
    if (!item.streaming && item.durationMs) head.appendChild(el('span', 'thinking-time', formatMs(item.durationMs)));
    head.appendChild(icon('chevron', 'thinking-chevron'));
    head.addEventListener('click', () => {
      const open = node.classList.toggle('open');
      // Distinguish "the reader opened this" from "it auto-opened because it is
      // streaming", so finishing the stream collapses the latter only.
      node.dataset.userOpen = open ? '1' : '0';
    });
    node.appendChild(head);

    const body = el('div', 'thinking-body');
    body.textContent = item.text || '';
    node.appendChild(body);
    return node;
  }

  function renderNotice(item) {
    const level = item.level === 'info' ? '' : ' ' + item.level;
    const node = el('div', 'msg notice' + level);
    node.dataset.id = item.id;
    node.appendChild(icon(item.level === 'error' || item.level === 'warn' ? 'warn' : 'info'));
    node.appendChild(el('div', 'notice-text', item.message));
    return node;
  }

  function renderTool(item) {
    const status = item.status || 'running';
    const node = el('div', 'tool ' + status);
    node.dataset.id = item.id;
    // A running tool stays open so its output is visible; a failure stays open
    // because the user needs to read it. Success collapses to one line.
    if (item.open === undefined) {
      if (status === 'running' || status === 'failed') node.classList.add('open');
    } else if (item.open) {
      node.classList.add('open');
    }
    if (item.open !== undefined) node.dataset.userOpen = item.open ? '1' : '0';
    if (status === 'running') node.dataset.startedAt = String(item.startedAt || Date.now());

    const head = el('div', 'tool-head');
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.appendChild(icon(toolIconName(item.name), 'tool-icon'));
    head.appendChild(el('span', 'tool-name', item.name));
    const arg = primaryArg(item);
    if (arg) {
      const argNode = el('span', 'tool-arg', arg);
      argNode.title = arg;
      head.appendChild(argNode);
    }
    if (item.summary) {
      const summary = el('span', 'tool-summary', oneLine(item.summary, 60));
      summary.title = item.summary;
      head.appendChild(summary);
    }
    if (item.durationMs) head.appendChild(el('span', 'tool-time', formatMs(item.durationMs)));
    else if (status === 'running') head.appendChild(el('span', 'tool-time', '0.0s'));
    head.appendChild(icon('chevron', 'tool-chevron'));
    const toggle = () => {
      const open = node.classList.toggle('open');
      node.dataset.userOpen = open ? '1' : '0';
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });
    node.appendChild(head);

    const body = el('div', 'tool-body');
    let args = '';
    try {
      args = JSON.stringify(JSON.parse(item.args || '{}'), null, 2);
    } catch {
      args = item.args || '';
    }
    if (args && args !== '{}') {
      body.appendChild(el('div', 'tool-label', 'arguments'));
      const pre = el('pre');
      pre.textContent = args.length > 1500 ? args.slice(0, 1500) + '\n… (truncated)' : args;
      body.appendChild(pre);
    }
    if (item.detail) {
      body.appendChild(el('div', 'tool-label', status === 'failed' ? 'error' : 'output'));
      const pre = el('pre');
      pre.textContent = item.detail.length > 4000 ? item.detail.slice(0, 4000) + '\n… (truncated)' : item.detail;
      body.appendChild(pre);
    }
    const actions = el('div', 'tool-actions');
    if (item.relPath) {
      const open = el('button', null, 'Open ' + item.relPath);
      open.type = 'button';
      open.title = 'Open this file in the editor';
      open.addEventListener('click', (event) => {
        event.stopPropagation();
        vscode.postMessage({ type: 'open-file', path: item.relPath });
      });
      actions.appendChild(open);
    }
    if (item.detail || args) {
      const copy = el('button', null, 'Copy output');
      copy.type = 'button';
      copy.addEventListener('click', (event) => {
        event.stopPropagation();
        copyText(item.detail || args, copy);
      });
      actions.appendChild(copy);
    }
    if (actions.childElementCount > 0) body.appendChild(actions);
    node.appendChild(body);
    return node;
  }

  function renderDiff(diffText) {
    const box = el('div', 'diff');
    const lines = String(diffText).split('\n');
    const limit = 240;
    const shown = lines.slice(0, limit);
    for (const line of shown) {
      let cls = 'ctx';
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) cls = 'hunk';
      else if (line.startsWith('+')) cls = 'add';
      else if (line.startsWith('-')) cls = 'del';
      box.appendChild(el('span', 'line ' + cls, line));
    }
    if (lines.length > limit) box.appendChild(el('span', 'line hunk', '… ' + (lines.length - limit) + ' more lines'));
    return box;
  }

  function approvalKind(request) {
    switch (request.kind) {
      case 'write':
        return { icon: 'pencil', label: 'edit' };
      case 'delete':
        return { icon: 'trash', label: 'delete' };
      case 'command':
        return { icon: 'terminal', label: 'command' };
      default:
        return { icon: 'info', label: request.kind || 'action' };
    }
  }

  function renderApproval(item) {
    const request = item.request || {};
    const resolved = Boolean(item.decision);
    const node = el(
      'div',
      'approval' + (resolved ? ' resolved ' + (item.decision === 'apply' ? 'applied' : 'rejected') : ''),
    );
    node.dataset.id = item.id;
    const kind = approvalKind(request);

    const head = el('div', 'approval-head');
    head.appendChild(icon(resolved ? (item.decision === 'apply' ? 'check' : 'x') : kind.icon));
    const title = resolved ? (item.decision === 'apply' ? 'Applied' : 'Rejected') : 'Approval needed';
    head.appendChild(el('span', null, title));
    head.appendChild(el('span', 'approval-kind', kind.label));
    const target = request.path || (request.command ? request.command : '');
    if (target) {
      const targetNode = el('span', 'approval-target', target);
      targetNode.title = target;
      head.appendChild(targetNode);
    }
    node.appendChild(head);

    const body = el('div', 'approval-body');
    if (request.kind === 'write' || request.kind === 'delete') {
      if (request.detail) body.appendChild(renderDiff(request.detail));
    } else {
      const pre = el('div', 'command');
      pre.textContent = request.detail || request.title || '';
      body.appendChild(pre);
    }
    node.appendChild(body);

    if (!resolved) {
      const actions = el('div', 'approval-actions');
      const apply = el('button', 'primary', request.kind === 'command' ? 'Run command' : 'Apply change');
      apply.type = 'button';
      apply.addEventListener('click', () =>
        vscode.postMessage({ type: 'approval-response', id: item.approvalId, decision: 'apply' }),
      );
      const always = el('button', null, 'Always');
      always.type = 'button';
      always.title = 'Apply this, and stop asking about ' + request.kind + ' actions for the rest of the session';
      always.addEventListener('click', () =>
        vscode.postMessage({ type: 'approval-response', id: item.approvalId, decision: 'apply', remember: 'all' }),
      );
      const reject = el('button', 'danger', 'Reject');
      reject.type = 'button';
      reject.addEventListener('click', () =>
        vscode.postMessage({ type: 'approval-response', id: item.approvalId, decision: 'reject' }),
      );
      actions.appendChild(apply);
      actions.appendChild(always);
      actions.appendChild(reject);
      if (request.kind !== 'command') {
        const diffBtn = el('button', null, 'Diff editor');
        diffBtn.type = 'button';
        diffBtn.title = 'Open this change in the editor’s diff view';
        diffBtn.addEventListener('click', () => vscode.postMessage({ type: 'open-diff', id: item.approvalId }));
        actions.appendChild(diffBtn);
      }
      node.appendChild(actions);
    }
    return node;
  }

  const DONE_LABEL = {
    complete: 'Done',
    'max-steps': 'Step limit reached',
    cancelled: 'Cancelled',
    error: 'Failed',
  };

  function renderDone(item) {
    const reason = item.reason || 'complete';
    const node = el('div', 'msg done ' + reason);
    node.dataset.id = item.id;

    const head = el('div', 'done-head');
    head.appendChild(icon(reason === 'complete' ? 'check' : reason === 'cancelled' ? 'stop' : 'warn'));
    head.appendChild(el('span', 'done-title', DONE_LABEL[reason] || reason));

    const stats = el('div', 'done-stats');
    if (item.usage) {
      stats.appendChild(el('span', null, formatTokens(item.usage.totalTokens || 0) + ' tokens'));
    }
    if (item.tokensPerSecond) stats.appendChild(el('span', null, item.tokensPerSecond.toFixed(1) + ' tok/s'));
    if (item.filesChanged && item.filesChanged.length) {
      stats.appendChild(el('span', null, item.filesChanged.length + ' file(s) changed'));
    }
    if (stats.childElementCount) head.appendChild(stats);
    node.appendChild(head);

    if (item.summary) {
      const summary = el('div', 'done-summary prose');
      summary.innerHTML = renderMarkdown(item.summary);
      node.appendChild(summary);
    }

    if (item.filesChanged && item.filesChanged.length) {
      const files = el('div', 'files');
      for (const file of item.filesChanged) {
        const chip = el('button', 'file', file);
        chip.type = 'button';
        chip.title = 'Open ' + file;
        chip.addEventListener('click', () => vscode.postMessage({ type: 'open-file', path: file }));
        files.appendChild(chip);
      }
      node.appendChild(files);
    }
    return node;
  }

  /* -------------------------------------------------------- attachments */

  function attachmentNotice(text) {
    addItem({ id: 'attach-note-' + ++attachmentSeq, kind: 'notice', level: 'warn', message: text });
  }

  /** Read one File/Blob into a data URL and stage it for the next message. */
  function stageFile(file) {
    if (!file) return;
    const type = (file.type || '').toLowerCase();
    if (IMAGE_TYPES.indexOf(type) === -1) {
      attachmentNotice('Only PNG, JPEG, GIF and WebP images can be attached' + (type ? ' (got ' + type + ')' : '') + '.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      attachmentNotice('Image is ' + formatBytes(file.size) + ', over the ' + formatBytes(MAX_IMAGE_BYTES) + ' limit.');
      return;
    }
    if (pending.length >= MAX_IMAGES) {
      attachmentNotice('At most ' + MAX_IMAGES + ' images can be attached to one message.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      pending.push({
        id: 'img-' + ++attachmentSeq,
        name: file.name || 'pasted image',
        mediaType: type,
        dataUrl: reader.result,
        bytes: file.size,
      });
      renderAttachments();
    };
    reader.onerror = () => attachmentNotice('Could not read the pasted image.');
    reader.readAsDataURL(file);
  }

  function removeAttachment(id) {
    const index = pending.findIndex((entry) => entry.id === id);
    if (index >= 0) pending.splice(index, 1);
    renderAttachments();
  }

  function clearAttachments() {
    pending.length = 0;
    renderAttachments();
  }

  /** The strip of thumbnails above the composer. */
  function renderAttachments() {
    if (!attachments) return;
    attachments.innerHTML = '';
    attachments.hidden = pending.length === 0;
    for (const item of pending) {
      const chip = el('div', 'attachment');
      const img = document.createElement('img');
      img.src = item.dataUrl;
      img.alt = item.name;
      chip.appendChild(img);
      const label = el('span', 'attachment-name', item.name);
      label.title = item.name + ' · ' + item.mediaType + ' · ' + formatBytes(item.bytes);
      chip.appendChild(label);
      const remove = el('button', 'attachment-remove', '\u2715');
      remove.type = 'button';
      remove.title = 'Remove attachment';
      remove.addEventListener('click', () => removeAttachment(item.id));
      chip.appendChild(remove);
      attachments.appendChild(chip);
    }
  }

  /** Thumbnails shown inside a sent user message. */
  function renderUserImages(images) {
    const row = el('div', 'msg-images');
    for (const image of images) {
      const img = document.createElement('img');
      img.src = image.dataUrl;
      img.alt = image.name || 'attached image';
      img.title = (image.name || 'attached image') + (image.bytes ? ' · ' + formatBytes(image.bytes) : '');
      img.addEventListener('click', () => img.classList.toggle('zoom'));
      row.appendChild(img);
    }
    return row;
  }

  /* --------------------------------------------------------- item plumbing */

  function addItem(item, forceScroll) {
    items.set(item.id, item);
    const node = renderItem(item);
    elements.set(item.id, node);
    stream.appendChild(node);
    toggleEmpty();
    autoScroll(forceScroll);
  }

  function replaceNode(item, node) {
    const previous = elements.get(item.id);
    if (previous && previous.parentElement) previous.parentElement.replaceChild(node, previous);
    else stream.appendChild(node);
    elements.set(item.id, node);
  }

  function updateItem(item) {
    const previous = items.get(item.id);
    const merged = Object.assign({}, previous, item);
    items.set(item.id, merged);

    // Streamed assistant text: patch the body, keep the element (and therefore
    // the scroll position, text selection and any open code block) intact.
    if (merged.kind === 'assistant') {
      const node = elements.get(item.id);
      const body = node && node.querySelector('.msg-body');
      if (body) {
        body.innerHTML = renderMarkdown(merged.text);
        if (merged.streaming) caretInto(body);
        node.classList.toggle('streaming', Boolean(merged.streaming));
        const oldActions = node.querySelector('.assistant-actions');
        if (oldActions && !merged.streaming) oldActions.remove();
        if (!merged.streaming && merged.text) {
          const actions = el('div', 'msg-actions assistant-actions');
          actions.appendChild(actionButton('copy', 'Copy this answer', () => copyText(merged.text)));
          node.appendChild(actions);
        }
        autoScroll();
        return;
      }
    }

    // Streamed thinking: append text without rebuilding the header.
    if (merged.kind === 'thinking') {
      const node = elements.get(item.id);
      const body = node && node.querySelector('.thinking-body');
      if (body && merged.streaming) {
        body.textContent = merged.text || '';
        node.classList.add('open', 'streaming');
        autoScroll();
        return;
      }
      if (node && body) {
        // Only an explicit click keeps the block expanded. Auto-open while
        // streaming must end with the stream, or the rationale buries the answer.
        const explicit = node.dataset.userOpen;
        if (explicit === '1') merged.open = true;
        else if (explicit === '0') merged.open = false;
        else delete merged.open;
        body.textContent = merged.text || '';
        node.classList.remove('streaming');
        node.classList.toggle('open', Boolean(merged.open));
        const preview = node.querySelector('.thinking-preview');
        if (preview) preview.textContent = oneLine(merged.text);
        const label = node.querySelector('.thinking-label');
        if (label) label.textContent = 'Thought';
        const head = node.querySelector('.thinking-head');
        if (head && merged.durationMs && !head.querySelector('.thinking-time')) {
          head.appendChild(el('span', 'thinking-time', formatMs(merged.durationMs)));
        }
        autoScroll();
        return;
      }
    }

    // Everything else: re-render, but keep a tool card open if the reader
    // opened it (or toggled it closed) while it was running.
    if (merged.kind === 'tool') {
      const node = elements.get(item.id);
      const explicit = node && node.dataset.userOpen;
      if (explicit === '1') merged.open = true;
      else if (explicit === '0') merged.open = false;
      // No explicit choice: drop the flag so the status decides (running and
      // failed open, success collapsed).
      else delete merged.open;
    }
    replaceNode(merged, renderItem(merged));
    autoScroll();
  }

  /* --------------------------------------------------------------- events */

  /* One delegated listener for everything rendered inside the transcript:
     copy buttons, "insert" on a code block, and external links. */
  stream.addEventListener('click', (event) => {
    const copyButton = event.target.closest('.code-copy');
    if (copyButton) {
      const target = document.getElementById(copyButton.dataset.target || '');
      copyText(target ? target.textContent : '', copyButton);
      return;
    }
    const insertButton = event.target.closest('.code-insert');
    if (insertButton) {
      const target = document.getElementById(insertButton.dataset.target || '');
      vscode.postMessage({ type: 'insert-code', text: target ? target.textContent : '' });
      return;
    }
    const link = event.target.closest('a[href]');
    if (link) {
      event.preventDefault();
      vscode.postMessage({ type: 'open-external', url: link.getAttribute('href') });
    }
  });

  function submit(text) {
    const value = (text !== undefined ? text : input.value).trim();
    // An image on its own is a valid prompt ("what is wrong in this screenshot?").
    if ((!value && pending.length === 0) || busy) return;
    const images = pending.map((entry) => ({ name: entry.name, mediaType: entry.mediaType, dataUrl: entry.dataUrl }));
    vscode.postMessage({ type: 'submit', text: value, images });
    clearAttachments();
    if (text === undefined) {
      input.value = '';
      input.style.height = 'auto';
    }
    stickToBottom = true;
    autoScroll(true);
  }

  btnSend.addEventListener('click', () => submit());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(200, input.scrollHeight) + 'px';
  });

  /* Pasting a screenshot: the clipboard carries it as an image/* item, which we
     stage as an attachment instead of letting the textarea swallow the event. */
  function imagesFromDataTransfer(data) {
    const files = [];
    if (!data) return files;
    for (const item of data.items || []) {
      if (item.kind === 'file' && (item.type || '').indexOf('image/') === 0) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length === 0) {
      for (const file of data.files || []) {
        if ((file.type || '').indexOf('image/') === 0) files.push(file);
      }
    }
    return files;
  }

  input.addEventListener('paste', (event) => {
    const files = imagesFromDataTransfer(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    for (const file of files) stageFile(file);
  });

  for (const target of [input, document.body]) {
    target.addEventListener('dragover', (event) => {
      if (!event.dataTransfer) return;
      const hasFiles = Array.prototype.some.call(event.dataTransfer.types || [], (type) => type === 'Files');
      if (!hasFiles) return;
      event.preventDefault();
      document.body.classList.add('dragging');
    });
    target.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
    target.addEventListener('drop', (event) => {
      const files = imagesFromDataTransfer(event.dataTransfer);
      document.body.classList.remove('dragging');
      if (files.length === 0) return;
      event.preventDefault();
      for (const file of files) stageFile(file);
    });
  }

  if (btnAttach && fileInput) {
    btnAttach.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      for (const file of fileInput.files || []) stageFile(file);
      fileInput.value = '';
    });
  }

  btnStop.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  btnRevert.addEventListener('click', () => vscode.postMessage({ type: 'revert' }));
  btnReset.addEventListener('click', () => vscode.postMessage({ type: 'reset' }));
  btnSettings.addEventListener('click', () => vscode.postMessage({ type: 'open-settings' }));
  btnSelection.addEventListener('click', () => vscode.postMessage({ type: 'insert-selection' }));
  if (btnCompact) btnCompact.addEventListener('click', () => vscode.postMessage({ type: 'compact' }));
  if (btnMcp) btnMcp.addEventListener('click', openMcpModal);
  if (btnAgents) btnAgents.addEventListener('click', () => vscode.postMessage({ type: 'open-agents' }));
  if (chipAgents) chipAgents.addEventListener('click', openAgentsModal);
  if (chipContext) chipContext.addEventListener('click', () => vscode.postMessage({ type: 'preview-context' }));
  if (btnCompactBanner) btnCompactBanner.addEventListener('click', () => vscode.postMessage({ type: 'compact' }));
  if (btnCompactDismiss) {
    btnCompactDismiss.addEventListener('click', () => {
      if (compactBanner) compactBanner.hidden = true;
    });
  }

  for (const button of document.querySelectorAll('#examples .example')) {
    button.addEventListener('click', () => {
      input.value = button.dataset.prompt || '';
      input.focus();
      input.dispatchEvent(new Event('input'));
    });
  }

  /* --------------------------------------------------------- mcp settings */

  const mcpModal = document.getElementById('mcp-modal');
  const mcpEnabled = document.getElementById('mcp-enabled');
  const mcpTimeout = document.getElementById('mcp-timeout');
  const mcpServerList = document.getElementById('mcp-server-list');
  const mcpFileServers = document.getElementById('mcp-file-servers');
  const mcpAddServer = document.getElementById('mcp-add');
  const mcpTarget = document.getElementById('mcp-target');
  const mcpModalStatus = document.getElementById('mcp-modal-status');
  const mcpSave = document.getElementById('mcp-save');
  const mcpReloadBtn = document.getElementById('mcp-reload');
  const mcpModalClose = document.getElementById('mcp-modal-close');

  /** Live per-server status posted by the extension: { running, tools, error }. */
  let mcpServerStatus = {};
  /** True when the form was edited since it was last rendered or saved, so a
      status refresh never clobbers half-typed input. */
  let mcpDirty = false;

  function openMcpModal() {
    mcpModal.hidden = false;
    mcpModalStatus.classList.remove('error');
    mcpModalStatus.textContent = 'Loading…';
    vscode.postMessage({ type: 'get-mcp-settings' });
  }

  function closeMcpModal() {
    mcpModal.hidden = true;
  }

  function mcpBadgeFor(id, disabled) {
    const info = id ? mcpServerStatus[id] : undefined;
    if (disabled) return { text: 'disabled', cls: 'off', title: 'Server is disabled' };
    if (info && info.error) return { text: 'failed', cls: 'error', title: info.error };
    if (info && info.running) {
      return { text: info.tools + ' tools', cls: 'ok', title: 'Connected — ' + info.tools + ' tool(s) available' };
    }
    return { text: 'not running', cls: 'off', title: 'Configured but not connected (MCP off, or a reload is pending)' };
  }

  function mcpField(label, control) {
    const row = el('div', 'form-row');
    row.appendChild(el('label', null, label));
    row.appendChild(control);
    return row;
  }

  function mcpTextInput(className, placeholder) {
    const node = document.createElement('input');
    node.type = 'text';
    node.className = className;
    node.placeholder = placeholder || '';
    node.spellcheck = false;
    return node;
  }

  function mcpArea(className, placeholder) {
    const node = document.createElement('textarea');
    node.className = className;
    node.placeholder = placeholder || '';
    node.rows = 2;
    node.spellcheck = false;
    return node;
  }

  function mapToLines(map, separator) {
    return Object.keys(map || {})
      .map((key) => key + separator + ' ' + map[key])
      .join('\n');
  }

  /** Parse "KEY=value" / "Name: value" lines into an object; bad lines are reported. */
  function linesToMap(text, separator) {
    const map = {};
    const bad = [];
    for (const rawLine of String(text || '').split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const index = line.indexOf(separator);
      if (index <= 0) {
        bad.push(line);
        continue;
      }
      const key = line.slice(0, index).trim();
      const value = line.slice(index + separator.length).trim();
      if (key) map[key] = value;
    }
    return { map, bad };
  }

  /** One server card. `cfg` uses the codingHarness.mcp.servers shape. */
  function mcpServerCard(id, cfg) {
    cfg = cfg || {};
    const kind = cfg.type || (cfg.url ? 'http' : 'stdio');
    const card = el('div', 'mcp-server');
    card.dataset.originalId = id || '';

    const head = el('div', 'mcp-server-head');
    const name = mcpTextInput('mcp-name', 'server name (e.g. filesystem)');
    name.value = id || '';
    const badge = el('span', 'mcp-badge');
    const state = mcpBadgeFor(id, cfg.disabled);
    badge.textContent = state.text;
    badge.classList.add(state.cls);
    badge.title = state.title;
    const remove = el('button', 'icon-btn');
    remove.type = 'button';
    remove.title = 'Remove this server';
    remove.setAttribute('aria-label', 'Remove this server');
    remove.appendChild(icon('x'));
    remove.addEventListener('click', () => {
      card.remove();
      mcpDirty = true;
    });
    head.appendChild(name);
    head.appendChild(badge);
    head.appendChild(remove);
    card.appendChild(head);

    const type = document.createElement('select');
    type.className = 'mcp-type';
    const kinds = [
      ['stdio', 'stdio — spawn a command'],
      ['http', 'http — Streamable HTTP'],
      ['sse', 'sse — legacy HTTP + SSE'],
    ];
    for (const [value, label] of kinds) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      if (value === kind) option.selected = true;
      type.appendChild(option);
    }
    card.appendChild(mcpField('Transport', type));

    const stdioBox = el('div', 'mcp-fields mcp-stdio');
    const command = mcpTextInput('mcp-command', 'e.g. node or npx');
    command.value = cfg.command || '';
    stdioBox.appendChild(mcpField('Command', command));
    const args = mcpArea('mcp-args', 'one argument per line, e.g.\n-y\n@modelcontextprotocol/server-filesystem\n.');
    args.value = Array.isArray(cfg.args) ? cfg.args.join('\n') : '';
    stdioBox.appendChild(mcpField('Arguments', args));
    const env = mcpArea('mcp-env', 'KEY=value, one per line');
    env.value = mapToLines(cfg.env, '=');
    stdioBox.appendChild(mcpField('Environment', env));
    const cwd = mcpTextInput('mcp-cwd', 'optional — relative to the workspace');
    cwd.value = cfg.cwd || '';
    stdioBox.appendChild(mcpField('Working dir', cwd));
    card.appendChild(stdioBox);

    const httpBox = el('div', 'mcp-fields mcp-http');
    const url = mcpTextInput('mcp-url', 'https://mcp.example.com/mcp');
    url.value = cfg.url || '';
    httpBox.appendChild(mcpField('URL', url));
    const headers = mcpArea('mcp-headers', 'Header-Name: value, one per line');
    headers.value = mapToLines(cfg.headers, ':');
    httpBox.appendChild(mcpField('Headers', headers));
    card.appendChild(httpBox);

    const options = el('div', 'mcp-options');
    const enabledLabel = el('label', 'check-row');
    const enabledFlag = document.createElement('input');
    enabledFlag.type = 'checkbox';
    enabledFlag.className = 'mcp-on';
    enabledFlag.checked = !cfg.disabled;
    enabledLabel.appendChild(enabledFlag);
    enabledLabel.appendChild(el('span', null, 'enabled'));
    options.appendChild(enabledLabel);
    options.appendChild(el('label', null, 'timeout (ms)'));
    const perTimeout = document.createElement('input');
    perTimeout.type = 'number';
    perTimeout.min = '1000';
    perTimeout.className = 'mcp-to';
    perTimeout.placeholder = 'default';
    if (cfg.timeoutMs) perTimeout.value = String(cfg.timeoutMs);
    options.appendChild(perTimeout);
    card.appendChild(options);

    function syncVisibility() {
      const isStdio = type.value === 'stdio';
      stdioBox.hidden = !isStdio;
      httpBox.hidden = isStdio;
    }
    type.addEventListener('change', () => {
      syncVisibility();
      mcpDirty = true;
    });
    enabledFlag.addEventListener('change', () => {
      const next = mcpBadgeFor(card.dataset.originalId, !enabledFlag.checked);
      badge.textContent = next.text;
      badge.className = 'mcp-badge ' + next.cls;
      badge.title = next.title;
    });
    syncVisibility();
    card.addEventListener('input', () => {
      mcpDirty = true;
    });
    return card;
  }

  function refreshMcpBadges() {
    for (const card of mcpServerList.querySelectorAll('.mcp-server')) {
      const badge = card.querySelector('.mcp-badge');
      const enabledFlag = card.querySelector('.mcp-on');
      if (!badge) continue;
      const id = card.dataset.originalId || '';
      const state = mcpBadgeFor(id, enabledFlag ? !enabledFlag.checked : false);
      badge.textContent = state.text;
      badge.className = 'mcp-badge ' + state.cls;
      badge.title = state.title;
    }
  }

  function renderMcpSettings(data) {
    mcpServerStatus = data.status || {};
    if (mcpModalStatus.textContent === 'Loading…' || mcpModalStatus.textContent === 'Reloading…') {
      mcpModalStatus.textContent = '';
    }
    // Preserve half-typed edits: only the live badges get refreshed.
    if (mcpDirty) {
      refreshMcpBadges();
      return;
    }
    mcpEnabled.checked = Boolean(data.enabled);
    mcpTimeout.value = data.timeoutMs ? String(data.timeoutMs) : '';
    if (mcpFileServers) {
      mcpFileServers.innerHTML = '';
      const fileServers = data.fileServers || {};
      const fileIds = Object.keys(fileServers);
      const sources = Array.isArray(data.sources) ? data.sources : [];
      if (fileIds.length > 0 || sources.length > 0 || (data.errors || []).length > 0) {
        mcpFileServers.hidden = false;
        if (sources.length) {
          mcpFileServers.appendChild(
            el('p', 'mcp-file-note', 'Read-only servers from config files: ' + sources.map((source) => source.path).join(', ')),
          );
        }
        for (const id of fileIds) {
          const cfg = fileServers[id] || {};
          const row = el('div', 'mcp-file-server');
          row.appendChild(el('span', 'mcp-file-name', id));
          const detail = el(
            'span',
            'mcp-file-detail',
            cfg.url ? 'http · ' + cfg.url : 'stdio · ' + (cfg.command || '?') + ' ' + ((cfg.args || []).join(' ')),
          );
          detail.title = detail.textContent;
          row.appendChild(detail);
          const badge = el('span', 'mcp-badge', 'config file');
          const info = mcpServerStatus[id];
          badge.classList.add(info && info.running ? 'ok' : info && info.error ? 'error' : 'off');
          badge.title = info && info.error ? info.error : info && info.running ? (info.tools || 0) + ' tool(s)' : 'not running';
          if (cfg.disabled) badge.title = 'disabled in the config file';
          row.appendChild(badge);
          mcpFileServers.appendChild(row);
        }
        for (const error of data.errors || []) {
          mcpFileServers.appendChild(el('p', 'mcp-file-error', error.path + ': ' + error.message));
        }
      } else {
        mcpFileServers.hidden = true;
      }
    }
    mcpServerList.innerHTML = '';
    const servers = data.servers || {};
    const ids = Object.keys(servers);
    if (ids.length === 0) {
      mcpServerList.appendChild(el('p', 'mcp-empty', 'No servers configured yet.'));
    }
    for (const id of ids) mcpServerList.appendChild(mcpServerCard(id, servers[id]));
    const workspaceOption = mcpTarget.querySelector('option[value="workspace"]');
    if (workspaceOption) workspaceOption.disabled = !data.supportsWorkspace;
    if (!data.supportsWorkspace && mcpTarget.value === 'workspace') mcpTarget.value = 'user';
  }

  function collectServers() {
    const servers = {};
    const errors = [];
    for (const card of mcpServerList.querySelectorAll('.mcp-server')) {
      const id = card.querySelector('.mcp-name').value.trim();
      if (!id) {
        errors.push('Every server needs a name.');
        continue;
      }
      if (servers[id]) {
        errors.push('Duplicate server name "' + id + '".');
        continue;
      }
      const kind = card.querySelector('.mcp-type').value;
      const cfg = { type: kind };
      if (kind === 'stdio') {
        const command = card.querySelector('.mcp-command').value.trim();
        if (!command) {
          errors.push('"' + id + '": a command is required for stdio servers.');
          continue;
        }
        cfg.command = command;
        const args = card
          .querySelector('.mcp-args')
          .value.split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        if (args.length) cfg.args = args;
        const env = linesToMap(card.querySelector('.mcp-env').value, '=');
        if (env.bad.length) {
          errors.push('"' + id + '": environment lines must look like KEY=value — "' + env.bad[0] + '"');
          continue;
        }
        if (Object.keys(env.map).length) cfg.env = env.map;
        const cwd = card.querySelector('.mcp-cwd').value.trim();
        if (cwd) cfg.cwd = cwd;
      } else {
        const url = card.querySelector('.mcp-url').value.trim();
        if (!/^https?:\/\//i.test(url)) {
          errors.push('"' + id + '": the URL must start with http:// or https://');
          continue;
        }
        cfg.url = url;
        const headers = linesToMap(card.querySelector('.mcp-headers').value, ':');
        if (headers.bad.length) {
          errors.push('"' + id + '": header lines must look like Name: value — "' + headers.bad[0] + '"');
          continue;
        }
        if (Object.keys(headers.map).length) cfg.headers = headers.map;
      }
      if (!card.querySelector('.mcp-on').checked) cfg.disabled = true;
      const perTimeout = Number(card.querySelector('.mcp-to').value);
      if (Number.isFinite(perTimeout) && perTimeout > 0) cfg.timeoutMs = Math.floor(perTimeout);
      servers[id] = cfg;
    }
    return { servers, errors };
  }

  mcpModalClose.addEventListener('click', closeMcpModal);
  mcpModal.addEventListener('click', (event) => {
    if (event.target === mcpModal) closeMcpModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!mcpModal.hidden) closeMcpModal();
    if (agentsModal && !agentsModal.hidden) closeAgentsModal();
  });
  mcpAddServer.addEventListener('click', () => {
    const emptyNoteNode = mcpServerList.querySelector('.mcp-empty');
    if (emptyNoteNode) emptyNoteNode.remove();
    const card = mcpServerCard('', {});
    mcpServerList.appendChild(card);
    mcpDirty = true;
    const name = card.querySelector('.mcp-name');
    if (name) name.focus();
  });
  mcpSave.addEventListener('click', () => {
    const collected = collectServers();
    if (collected.errors.length) {
      mcpModalStatus.classList.add('error');
      mcpModalStatus.textContent = collected.errors[0];
      return;
    }
    const timeout = Number(mcpTimeout.value);
    mcpModalStatus.classList.remove('error');
    mcpModalStatus.textContent = 'Saving…';
    // The form now matches what we asked to save; the reply may re-render it.
    mcpDirty = false;
    vscode.postMessage({
      type: 'save-mcp-settings',
      enabled: mcpEnabled.checked,
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : 10000,
      servers: collected.servers,
      target: mcpTarget.value,
    });
  });
  mcpReloadBtn.addEventListener('click', () => {
    mcpModalStatus.classList.remove('error');
    mcpModalStatus.textContent = 'Reloading…';
    vscode.postMessage({ type: 'mcp-reload' });
  });
  if (chipMcp) chipMcp.addEventListener('click', openMcpModal);

  /* -------------------------------------------------------- agents dialog */

  const agentsModal = document.getElementById('agents-modal');
  const agentsAll = document.getElementById('agents-all');
  const agentsList = document.getElementById('agents-list');
  const agentsEmpty = document.getElementById('agents-empty');
  const agentsCreate = document.getElementById('agents-create');
  const agentsOpen = document.getElementById('agents-open');
  const agentsCancel = document.getElementById('agents-cancel');
  const agentsSaveBtn = document.getElementById('agents-save');
  const agentsStatus = document.getElementById('agents-modal-status');
  const agentsClose = document.getElementById('agents-modal-close');

  function openAgentsModal() {
    if (!agentsModal) return;
    agentsModal.hidden = false;
    agentsStatus.classList.remove('error');
    agentsStatus.textContent = 'Loading…';
    vscode.postMessage({ type: 'get-agent-settings' });
  }

  function closeAgentsModal() {
    if (agentsModal) agentsModal.hidden = true;
  }

  function checkedAgentPaths() {
    if (!agentsList) return [];
    return Array.from(agentsList.querySelectorAll('.agent-check'))
      .filter((box) => box.checked)
      .map((box) => box.value);
  }

  /** "Every discovered file" disables the individual boxes instead of hiding them. */
  function syncAgentRows() {
    if (!agentsAll || !agentsList) return;
    const all = agentsAll.checked;
    let checked = 0;
    for (const row of agentsList.querySelectorAll('.agent-row')) {
      const box = row.querySelector('.agent-check');
      if (!box) continue;
      box.disabled = all;
      const on = all || box.checked;
      row.classList.toggle('active', on);
      if (box.checked) checked += 1;
    }
    if (agentsSaveBtn) agentsSaveBtn.disabled = !all && checked === 0;
  }

  function agentRow(file) {
    const row = el('label', 'agent-row' + (file.active ? ' active' : ''));
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'agent-check';
    box.value = file.displayPath;
    box.checked = Boolean(file.active);
    box.addEventListener('change', syncAgentRows);
    row.appendChild(box);

    const text = el('span', 'agent-text');
    text.appendChild(el('span', 'agent-path', file.displayPath));
    const meta = [];
    if (file.origin === 'user') meta.push('user-level');
    else if (file.scope) meta.push('applies to ' + file.scope + '/**');
    else meta.push('workspace root');
    if (file.bytes != null) meta.push(formatBytes(file.bytes));
    if (file.truncated) meta.push('truncated');
    text.appendChild(el('span', 'agent-meta', meta.join(' · ')));
    row.appendChild(text);
    return row;
  }

  function renderAgentSettings(data) {
    if (!agentsList) return;
    agentsAll.checked = data.selection === null;
    agentsList.innerHTML = '';
    for (const file of data.files || []) agentsList.appendChild(agentRow(file));
    const available = typeof data.available === 'number' ? data.available : (data.files || []).length;
    if (agentsEmpty) agentsEmpty.hidden = available > 0;
    agentsStatus.classList.remove('error');
    agentsStatus.textContent = available === 0 ? '' : '';
    if (data.enabled === false) {
      agentsStatus.textContent = 'Instruction loading is disabled in settings.';
    }
    syncAgentRows();
  }

  if (agentsClose) agentsClose.addEventListener('click', closeAgentsModal);
  if (agentsCancel) agentsCancel.addEventListener('click', closeAgentsModal);
  if (agentsModal) {
    agentsModal.addEventListener('click', (event) => {
      if (event.target === agentsModal) closeAgentsModal();
    });
  }
  if (agentsAll) agentsAll.addEventListener('change', syncAgentRows);
  if (agentsOpen) {
    agentsOpen.addEventListener('click', () => {
      // The extension opens a quick pick over the panel; close first so it is visible.
      closeAgentsModal();
      vscode.postMessage({ type: 'open-agents' });
    });
  }
  if (agentsCreate) {
    agentsCreate.addEventListener('click', () => {
      agentsStatus.textContent = 'Creating agent.md…';
      vscode.postMessage({ type: 'create-agent-file' });
    });
  }
  if (agentsSaveBtn) {
    agentsSaveBtn.addEventListener('click', () => {
      const selection = agentsAll.checked ? null : checkedAgentPaths();
      if (!agentsAll.checked && selection.length === 0) {
        agentsStatus.classList.add('error');
        agentsStatus.textContent = 'Select at least one file, or use “every discovered file”.';
        return;
      }
      agentsStatus.classList.remove('error');
      agentsStatus.textContent = 'Saving…';
      vscode.postMessage({ type: 'save-agent-selection', selection });
    });
  }

  /* --------------------------------------------------------------- message */

  function rebuild(itemsToRender) {
    items.clear();
    elements.clear();
    stream.innerHTML = '';
    if (empty) stream.appendChild(empty);
    for (const item of itemsToRender || []) {
      items.set(item.id, item);
      const node = renderItem(item);
      elements.set(item.id, node);
      stream.appendChild(node);
    }
    toggleEmpty();
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'init':
        rebuild(message.items);
        applyState(message.state);
        applyActivity(message.activity);
        if (message.usage) {
          cumulativeUsage = message.usage;
          updateTokenChips();
        }
        stickToBottom = true;
        autoScroll(true);
        break;
      case 'item':
        addItem(message.item, message.item.kind === 'user' || message.item.kind === 'approval');
        break;
      case 'update':
        updateItem(message.item);
        break;
      case 'state':
        applyState(message.state);
        break;
      case 'status':
        setStatus(message.status, message.step, message.maxSteps);
        break;
      case 'activity':
        applyActivity(message.activity);
        break;
      case 'usage': {
        const usage = message.usage;
        const step = message.step;
        if (usage) {
          if (message.cumulative) {
            cumulativeUsage = message.cumulative;
          } else {
            cumulativeUsage = {
              inputTokens: (cumulativeUsage.inputTokens || 0) + (usage.inputTokens || 0),
              outputTokens: (cumulativeUsage.outputTokens || 0) + (usage.outputTokens || 0),
              totalTokens:
                (cumulativeUsage.totalTokens || 0) +
                (usage.totalTokens || (usage.inputTokens || 0) + (usage.outputTokens || 0)),
            };
          }
          if (typeof message.tokensPerSecond === 'number') currentSpeed = message.tokensPerSecond;
          else if (typeof message.durationMs === 'number' && usage.outputTokens) {
            const seconds = message.durationMs / 1000;
            if (seconds > 0) currentSpeed = usage.outputTokens / seconds;
          }
          if (typeof message.contextWindow === 'number') contextWindow = message.contextWindow;
          if (typeof message.contextTokens === 'number') contextTokens = message.contextTokens;
          if (typeof message.contextPercent === 'number') contextPercent = message.contextPercent;
          else if (contextWindow && contextTokens) contextPercent = (contextTokens / contextWindow) * 100;

          if (hintUsage) {
            const total = cumulativeUsage.totalTokens || 0;
            const speed = currentSpeed > 0 ? ' · ' + currentSpeed.toFixed(1) + ' tok/s' : '';
            hintUsage.textContent = (step ? 'step ' + step + ' · ' : '') + total + ' tokens' + speed;
          }
          updateTokenChips();
        }
        break;
      }
      case 'token-speed':
        if (typeof message.tokensPerSecond === 'number') {
          currentSpeed = message.tokensPerSecond;
          updateTokenChips();
        }
        break;
      case 'context':
        if (typeof message.contextTokens === 'number') contextTokens = message.contextTokens;
        if (typeof message.contextWindow === 'number') contextWindow = message.contextWindow;
        if (typeof message.contextPercent === 'number') contextPercent = message.contextPercent;
        else if (contextWindow && contextTokens) contextPercent = (contextTokens / contextWindow) * 100;
        updateTokenChips();
        break;
      case 'mcp-status':
        if (chipMcp) {
          if (message.enabled) {
            chipMcp.textContent = 'mcp: ' + (message.servers || 0) + ' srv · ' + (message.tools || 0) + ' tools';
            chipMcp.hidden = false;
          } else {
            chipMcp.hidden = true;
          }
        }
        break;
      case 'mcp-settings':
        if (mcpModal.hidden) break;
        renderMcpSettings(message);
        break;
      case 'agent-settings':
        if (!agentsModal || agentsModal.hidden) break;
        renderAgentSettings(message);
        break;
      case 'agent-settings-saved':
        if (!agentsModal || agentsModal.hidden) break;
        if (message.ok) {
          agentsStatus.classList.remove('error');
          agentsStatus.textContent = 'Saved ✓';
          setTimeout(() => {
            if (agentsModal && !agentsModal.hidden) closeAgentsModal();
          }, 600);
        } else {
          agentsStatus.classList.add('error');
          agentsStatus.textContent = message.error || 'Could not save the selection.';
        }
        break;
      case 'mcp-settings-saved':
        if (mcpModal.hidden) break;
        if (message.ok) {
          mcpModalStatus.classList.remove('error');
          mcpModalStatus.textContent = 'Saved ✓';
        } else {
          mcpModalStatus.classList.add('error');
          mcpModalStatus.textContent = 'Save failed: ' + (message.error || 'unknown error');
          // The stored settings did not change — keep the user's edits.
          mcpDirty = true;
        }
        break;
      case 'approval-request':
        addItem(
          {
            id: 'approval-' + message.id,
            kind: 'approval',
            approvalId: message.id,
            request: message.request,
          },
          true,
        );
        break;
      case 'reset':
        rebuild([]);
        clearAttachments();
        if (hintUsage) hintUsage.textContent = '';
        cumulativeUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        currentSpeed = 0;
        contextTokens = 0;
        contextPercent = 0;
        updateTokenChips();
        stickToBottom = true;
        break;
      case 'prefill':
        input.value = (input.value ? input.value + '\n' : '') + (message.text || '');
        input.focus();
        input.dispatchEvent(new Event('input'));
        break;
      default:
        break;
    }
  });

  /* Running tools get a tiny spinner so long commands do not look frozen. */
  const frames = ['◐', '◓', '◑', '◒'];
  const spinner = document.getElementById('activity-spinner');
  let frame = 0;
  setInterval(() => {
    frame = (frame + 1) % frames.length;
    // Tool icons are <svg>; the running state pulses them via CSS. Only the
    // activity strip carries the text spinner.
    if (spinner && !activityBox.hidden) spinner.textContent = frames[frame];
    if (!busy) return;
    tickActivity();
    tickRunningTools();
    tickThinking();
  }, 250);

  vscode.postMessage({ type: 'ready' });
})();
