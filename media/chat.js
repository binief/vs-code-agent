/* Coding Harness — agent panel client.
   Plain JS (no build step): renders transcript items the extension posts and
   sends user intent back. All state lives in the extension. */
(function () {
  const vscode = acquireVsCodeApi();

  const stream = document.getElementById('stream');
  const empty = document.getElementById('empty');
  const input = document.getElementById('input');
  const btnSend = document.getElementById('btn-send');
  const btnStop = document.getElementById('btn-stop');
  const btnRevert = document.getElementById('btn-revert');
  const btnReset = document.getElementById('btn-reset');
  const btnSettings = document.getElementById('btn-settings');
  const btnSelection = document.getElementById('btn-selection');
  const btnCompact = document.getElementById('btn-compact');
  const btnMcpReload = document.getElementById('btn-mcp-reload');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const chipProvider = document.getElementById('chip-provider');
  const chipPolicy = document.getElementById('chip-policy');
  const chipWorkspace = document.getElementById('chip-workspace');
  const chipTokens = document.getElementById('chip-tokens');
  const chipSpeed = document.getElementById('chip-speed');
  const chipContext = document.getElementById('chip-context');
  const chipMcp = document.getElementById('chip-mcp');
  const hintUsage = document.getElementById('hint-usage');
  const activityBox = document.getElementById('activity');
  const activityText = document.getElementById('activity-text');
  const activityDetail = document.getElementById('activity-detail');
  const activityElapsed = document.getElementById('activity-elapsed');
  const chipStream = document.getElementById('chip-stream');
  const chipThinking = document.getElementById('chip-thinking');
  const btnJump = document.getElementById('jump-latest');
  const compactBanner = document.getElementById('compact-banner');
  const compactText = document.getElementById('compact-text');
  const btnCompactBanner = document.getElementById('btn-compact-banner');
  const btnCompactDismiss = document.getElementById('btn-compact-dismiss');

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

  // Token tracking for live speed
  let cumulativeUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let currentSpeed = 0;
  let contextWindow = 128000;
  let contextTokens = 0;
  let contextPercent = 0;
  const streamTrackers = new Map(); // id -> { start, chars, tokens }

  /* ------------------------------------------------------------ helpers */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;');
  }

  /** Minimal markdown: fenced code, inline code, bold. Everything is escaped. */
  function renderMarkdown(text) {
    const parts = String(text).split(/```/);
    let html = '';
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        const body = parts[i].replace(/^[a-zA-Z0-9+#-]*\n/, '');
        html += `<pre><code>${escapeHtml(body.replace(/\n$/, ''))}</code></pre>`;
      } else {
        html += escapeHtml(parts[i])
          .replace(/`([^`\n]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      }
    }
    return html;
  }

  function setStatus(status, step, maxSteps) {
    const labels = {
      idle: 'Idle',
      thinking: 'Thinking',
      executing: 'Running tools',
      approval: 'Waiting for approval',
      running: 'Working',
    };
    let text = labels[status] || status;
    if ((status === 'thinking' || status === 'executing') && step) {
      text += ' · step ' + step + (maxSteps ? '/' + maxSteps : '');
    }
    statusText.textContent = text;
    statusDot.dataset.status = status;
  }

  function formatTokens(n) {
    if (n == null) return '0';
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1) + 'k';
    return Math.round(n / 1000) + 'k';
  }

  function updateTokenChips() {
    if (!chipTokens) return;
    const total = cumulativeUsage.totalTokens || 0;
    const input = cumulativeUsage.inputTokens || 0;
    const output = cumulativeUsage.outputTokens || 0;
    chipTokens.textContent = formatTokens(total) + ' tokens';
    chipTokens.title = `Input: ${input} · Output: ${output} · Total: ${total}`;
    if (total > 0) chipTokens.hidden = false;

    if (chipSpeed) {
      if (currentSpeed > 0 && busy) {
        chipSpeed.textContent = currentSpeed.toFixed(1) + ' tok/s';
        chipSpeed.hidden = false;
      } else if (!busy) {
        // Keep last speed visible for a moment, then hide if no recent activity
        // For now, show if we have a speed and total tokens
        if (currentSpeed > 0 && total > 0) {
          chipSpeed.textContent = currentSpeed.toFixed(1) + ' tok/s';
          chipSpeed.hidden = false;
        } else {
          chipSpeed.hidden = true;
        }
      }
    }

    if (chipContext) {
      const pct = contextPercent || 0;
      chipContext.textContent = 'ctx ' + Math.round(pct) + '%';
      chipContext.title = `Context: ${contextTokens} / ${contextWindow} tokens (${Math.round(pct)}%)`;
      chipContext.classList.remove('warn', 'error');
      if (pct >= 90) chipContext.classList.add('error');
      else if (pct >= 75) chipContext.classList.add('warn');
      // Show banner when getting full
      if (compactBanner && compactText) {
        if (pct >= 75 && !busy) {
          compactBanner.hidden = false;
          if (pct >= 90) {
            compactText.textContent = `Context ${Math.round(pct)}% full (${contextTokens}/${contextWindow} tokens). Compact now to avoid truncation.`;
          } else {
            compactText.textContent = `Context ${Math.round(pct)}% used. Consider compacting to free space.`;
          }
        } else if (pct < 70) {
          compactBanner.hidden = true;
        }
      }
    }
  }

  function applyState(state) {
    if (!state) return;
    busy = Boolean(state.busy);
    btnSend.disabled = busy;
    btnStop.hidden = !busy;
    chipProvider.textContent = state.provider + ' · ' + state.model;
    chipProvider.title = state.keyPresent
      ? 'API key: configured'
      : state.provider === 'mock'
        ? 'Offline planner — no API key needed'
        : 'No API key configured (Coding Harness: Set API Key)';
    if (!state.keyPresent && state.provider !== 'mock') chipProvider.classList.add('warn');
    else chipProvider.classList.remove('warn');

    chipPolicy.textContent = 'edits: ' + state.editPolicy + ' · shell: ' + state.commandPolicy;
    streamEnabled = state.stream !== false;
    chipStream.textContent = 'stream: ' + (streamEnabled ? 'on' : 'off');
    chipStream.title = streamEnabled
      ? 'Model output is rendered token by token'
      : 'Streaming disabled (codingHarness.stream = false)';
    thinkingEnabled = state.showThinking !== false;
    chipThinking.textContent = 'thinking: ' + (thinkingEnabled ? 'shown' : 'hidden');
    chipThinking.title = thinkingEnabled
      ? "The model's reasoning stream is shown in its own lane"
      : 'Reasoning hidden (codingHarness.showThinking = false)';
    chipWorkspace.textContent = state.workspace || 'no folder open';
    chipWorkspace.title = state.workspace || '';

    // Token usage
    if (state.usage) {
      cumulativeUsage = {
        inputTokens: state.usage.inputTokens || cumulativeUsage.inputTokens,
        outputTokens: state.usage.outputTokens || cumulativeUsage.outputTokens,
        totalTokens: state.usage.totalTokens || (state.usage.inputTokens || 0) + (state.usage.outputTokens || 0) || cumulativeUsage.totalTokens,
      };
    }
    if (state.cumulativeUsage) {
      cumulativeUsage = state.cumulativeUsage;
    }
    if (typeof state.tokensPerSecond === 'number') {
      currentSpeed = state.tokensPerSecond;
    }
    if (typeof state.contextWindow === 'number') contextWindow = state.contextWindow;
    if (typeof state.contextTokens === 'number') contextTokens = state.contextTokens;
    if (typeof state.contextPercent === 'number') contextPercent = state.contextPercent;
    else if (contextWindow && contextTokens) {
      contextPercent = (contextTokens / contextWindow) * 100;
    }

    // MCP
    if (chipMcp) {
      if (state.mcpEnabled) {
        const count = state.mcpToolCount || 0;
        const servers = state.mcpServers || 0;
        chipMcp.textContent = `mcp: ${servers} srv, ${count} tools`;
        chipMcp.title = `MCP enabled: ${servers} server(s), ${count} tool(s)`;
        chipMcp.hidden = false;
      } else {
        chipMcp.hidden = true;
      }
    }

    updateTokenChips();

    if (!state.busy) setStatus(state.status === 'running' ? 'idle' : state.status, state.step, state.maxSteps);
    else setStatus(state.status, state.step, state.maxSteps);
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
   * Previously this function pinned the inner thinking scrollbar to the bottom
   * on every tick. That caused the visible jump: updateItem replaced the
   * thinking node (resetting scrollTop to 0) and then tickThinking forced it
   * back to bottom 250ms later. Now streaming thinking has no inner scrollbar
   * (max-height:none via CSS), so outer autoScroll handles following. This
   * function is kept as a no-op for backwards compatibility and to satisfy
   * existing layout tests that check for its presence.
   */
  function tickThinking() {
    // Intentionally no longer forces inner scrollTop — outer stream handles it.
    // If non-streaming thinking blocks are manually opened and exceed max-height,
    // we leave their scroll position alone to avoid fighting user scroll.
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
   * reader is scrolled up reading earlier tool calls - offer the jump button
   * instead. This is what used to make long transcripts unusable.
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

  /* ------------------------------------------------------------ renderers */

  function renderItem(item) {
    switch (item.kind) {
      case 'user':
        return el('div', 'msg user', item.text);
      case 'assistant': {
        const node = el('div', 'msg assistant' + (item.final ? ' final' : '') + (item.streaming ? ' streaming' : ''));
        node.innerHTML = renderMarkdown(item.text) + '<span class="caret"></span>';
        return node;
      }
      case 'thinking':
        return renderThinking(item);
      case 'notice': {
        const node = el('div', 'msg notice' + (item.level === 'info' ? '' : ' ' + item.level));
        node.textContent = item.message;
        return node;
      }
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

  /**
   * The reasoning lane. Expanded and following along while the model is
   * thinking, then collapsed to a one-line summary once the answer lands so it
   * does not crowd out the actual results.
   */
  function renderThinking(item) {
    const node = el('div', 'thinking' + (item.streaming ? ' streaming' : '') + (item.streaming ? ' open' : ''));
    node.dataset.id = item.id;

    const head = el('div', 'thinking-head');
    head.appendChild(el('span', 'thinking-icon', '\u2733'));
    head.appendChild(el('span', 'thinking-label', item.streaming ? 'Thinking…' : 'Thought'));

    const preview = el('span', 'thinking-preview');
    preview.textContent = item.streaming ? '' : oneLine(item.text);
    head.appendChild(preview);
    if (!item.streaming && item.durationMs) {
      head.appendChild(el('span', 'thinking-time', formatMs(item.durationMs)));
    }
    head.addEventListener('click', () => node.classList.toggle('open'));
    node.appendChild(head);

    const body = el('div', 'thinking-body');
    body.textContent = item.text || '';
    node.appendChild(body);
    return node;
  }

  function oneLine(text) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    return flat.length > 110 ? flat.slice(0, 107) + '\u2026' : flat;
  }

  function renderTool(item) {
    const node = el('div', 'tool ' + (item.status || 'running'));
    node.dataset.id = item.id;
    if (item.status === 'running') {
      node.classList.add('open');
      node.dataset.startedAt = String(item.startedAt || Date.now());
    }

    const head = el('div', 'tool-head');
    const icon = el('span', 'tool-icon', item.status === 'running' ? '◐' : item.status === 'ok' ? '✓' : '✗');
    head.appendChild(icon);
    head.appendChild(el('span', 'tool-name', item.name));
    head.appendChild(el('span', 'tool-summary', item.summary || (item.status === 'running' ? 'running…' : '')));
    if (item.durationMs) head.appendChild(el('span', 'tool-time', formatMs(item.durationMs)));
    else if (item.status === 'running') head.appendChild(el('span', 'tool-time', '0.0s'));
    head.addEventListener('click', () => node.classList.toggle('open'));
    node.appendChild(head);

    const body = el('div', 'tool-body');
    let args = '';
    try {
      args = JSON.stringify(JSON.parse(item.args || '{}'), null, 2);
    } catch {
      args = item.args || '';
    }
    if (args && args !== '{}') {
      const pre = el('pre');
      pre.textContent = args.length > 1500 ? args.slice(0, 1500) + '\n… (truncated)' : args;
      body.appendChild(pre);
    }
    if (item.detail) {
      const pre = el('pre');
      pre.textContent = item.detail.length > 4000 ? item.detail.slice(0, 4000) + '\n… (truncated)' : item.detail;
      body.appendChild(pre);
    }
    if (item.relPath) {
      const actions = el('div', 'tool-actions');
      const open = el('button', null, 'Open ' + item.relPath);
      open.addEventListener('click', (event) => {
        event.stopPropagation();
        vscode.postMessage({ type: 'open-file', path: item.relPath });
      });
      actions.appendChild(open);
      body.appendChild(actions);
    }
    node.appendChild(body);
    return node;
  }

  function renderApproval(item) {
    const request = item.request || {};
    const node = el('div', 'approval' + (item.decision ? ' resolved ' + (item.decision === 'apply' ? 'applied' : 'rejected') : ''));
    node.dataset.id = item.id;

    const head = el('div', 'approval-head');
    head.appendChild(el('span', null, item.decision ? 'Resolved: ' + request.title : 'Approval needed: ' + request.title));
    head.appendChild(el('span', null, request.kind));
    node.appendChild(head);

    const body = el('div', 'approval-body');
    if (request.kind === 'write') {
      body.appendChild(renderDiff(request.detail || ''));
    } else {
      const pre = el('div', 'command');
      pre.textContent = request.detail || '';
      body.appendChild(pre);
    }
    node.appendChild(body);

    if (!item.decision) {
      const actions = el('div', 'approval-actions');

      const apply = el('button', 'primary', request.kind === 'write' ? 'Apply edit' : 'Run command');
      apply.addEventListener('click', () =>
        vscode.postMessage({ type: 'approval-response', id: item.approvalId, decision: 'apply' }),
      );

      const always = el('button', null, 'Always for this session');
      always.title = 'Apply this and stop asking about ' + request.kind + ' for the rest of this session';
      always.addEventListener('click', () =>
        vscode.postMessage({ type: 'approval-response', id: item.approvalId, decision: 'apply', remember: 'all' }),
      );

      const reject = el('button', 'danger', 'Reject');
      reject.addEventListener('click', () =>
        vscode.postMessage({ type: 'approval-response', id: item.approvalId, decision: 'reject' }),
      );

      actions.appendChild(apply);
      actions.appendChild(always);
      actions.appendChild(reject);

      if (request.kind === 'write') {
        const diffBtn = el('button', null, 'Open in diff editor');
        diffBtn.addEventListener('click', () => vscode.postMessage({ type: 'open-diff', id: item.approvalId }));
        actions.appendChild(diffBtn);
      }
      node.appendChild(actions);
    }
    return node;
  }

  function renderDiff(diffText) {
    const box = el('div', 'diff');
    const lines = String(diffText).split('\n');
    const limit = 200;
    const shown = lines.slice(0, limit);
    for (const line of shown) {
      let cls = 'ctx';
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) cls = 'hunk';
      else if (line.startsWith('+')) cls = 'add';
      else if (line.startsWith('-')) cls = 'del';
      const row = el('span', cls, line);
      box.appendChild(row);
    }
    if (lines.length > limit) box.appendChild(el('span', 'hunk', '… ' + (lines.length - limit) + ' more lines'));
    return box;
  }

  function renderDone(item) {
    const node = el('div', 'msg done');
    const title = el('div', 'done-title');
    const badge = el('span', 'pill', item.reason);
    title.appendChild(badge);
    if (item.usage) {
      const usageBadge = el('span', 'pill', (item.usage.totalTokens || 0) + ' tokens');
      usageBadge.title = `Input: ${item.usage.inputTokens || 0} · Output: ${item.usage.outputTokens || 0}`;
      title.appendChild(usageBadge);
    }
    if (item.tokensPerSecond) {
      const speedBadge = el('span', 'pill', item.tokensPerSecond.toFixed(1) + ' tok/s');
      title.appendChild(speedBadge);
    }
    node.appendChild(title);

    const summary = el('div');
    summary.innerHTML = renderMarkdown(item.summary || '');
    node.appendChild(summary);

    if (item.filesChanged && item.filesChanged.length) {
      const files = el('div', 'files');
      for (const file of item.filesChanged) {
        const chip = el('span', 'file', file);
        chip.title = 'Open ' + file;
        chip.addEventListener('click', () => vscode.postMessage({ type: 'open-file', path: file }));
        files.appendChild(chip);
      }
      node.appendChild(files);
    }
    return node;
  }

  function formatMs(ms) {
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return Math.round(ms / 60000) + 'm';
  }

  /* --------------------------------------------------------- item plumbing */

  function addItem(item, position) {
    items.set(item.id, item);
    const node = renderItem(item);
    elements.set(item.id, node);
    if (position === 'prepend' && stream.firstChild && stream.firstChild !== empty) {
      stream.insertBefore(node, stream.firstChild);
    } else {
      stream.appendChild(node);
    }
    toggleEmpty();
    autoScroll();
  }

  function updateItem(item) {
    const previous = items.get(item.id);
    // Fix for thinking scrollbar jumping: when thinking is streaming, we previously
    // replaced the whole node on every delta, resetting scrollTop to 0, then
    // tickThinking forced it to bottom — causing a jump. Now we update in place.
    if (previous && previous.kind === 'thinking' && item.kind === 'thinking' && item.streaming) {
      const existingNode = elements.get(item.id);
      if (existingNode) {
        const body = existingNode.querySelector('.thinking-body');
        if (body) {
          // Preserve scroll position relative to outer, not inner (inner has no scrollbar while streaming)
          body.textContent = item.text || '';
        }
        // Keep open and streaming classes
        existingNode.classList.add('open');
        existingNode.classList.add('streaming');
        items.set(item.id, Object.assign({}, previous, item));
        autoScroll();
        return;
      }
    }

    // A reader who opened a collapsed thinking block should keep it open
    // across the next repaint of that item.
    if (previous && previous.kind === 'thinking' && item.kind === 'thinking') {
      const node = elements.get(item.id);
      if (node && node.classList.contains('open') && !item.streaming) item = Object.assign({}, item, { open: true });
    }
    items.set(item.id, Object.assign({}, previous, item));
    const old = elements.get(item.id);
    const node = renderItem(items.get(item.id));
    if (items.get(item.id).open) node.classList.add('open');
    if (old && old.parentElement) old.parentElement.replaceChild(node, old);
    else stream.appendChild(node);
    elements.set(item.id, node);
    autoScroll();
  }

  /* --------------------------------------------------------------- events */

  btnSend.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(220, input.scrollHeight) + 'px';
  });

  function submit(text) {
    const value = (text !== undefined ? text : input.value).trim();
    if (!value || busy) return;
    vscode.postMessage({ type: 'submit', text: value });
    if (text === undefined) {
      input.value = '';
      input.style.height = 'auto';
    }
  }

  btnStop.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  btnRevert.addEventListener('click', () => vscode.postMessage({ type: 'revert' }));
  btnReset.addEventListener('click', () => vscode.postMessage({ type: 'reset' }));
  btnSettings.addEventListener('click', () => vscode.postMessage({ type: 'open-settings' }));
  btnSelection.addEventListener('click', () => vscode.postMessage({ type: 'insert-selection' }));
  if (btnCompact) btnCompact.addEventListener('click', () => vscode.postMessage({ type: 'compact' }));
  if (btnMcpReload) btnMcpReload.addEventListener('click', () => vscode.postMessage({ type: 'mcp-reload' }));
  if (btnCompactBanner) btnCompactBanner.addEventListener('click', () => vscode.postMessage({ type: 'compact' }));
  if (btnCompactDismiss) btnCompactDismiss.addEventListener('click', () => {
    if (compactBanner) compactBanner.hidden = true;
  });

  for (const li of document.querySelectorAll('#examples li')) {
    li.addEventListener('click', () => {
      input.value = li.dataset.prompt || '';
      input.focus();
    });
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'init':
        items.clear();
        elements.clear();
        stream.innerHTML = '';
        if (empty) stream.appendChild(empty);
        for (const item of message.items || []) addItem(item);
        applyState(message.state);
        applyActivity(message.activity);
        if (message.usage) {
          cumulativeUsage = message.usage;
          updateTokenChips();
        }
        toggleEmpty();
        break;
      case 'item':
        addItem(message.item);
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
          // If message has cumulative flag, replace, else merge
          if (message.cumulative) {
            cumulativeUsage = usage;
          } else {
            // Merge into cumulative
            cumulativeUsage = {
              inputTokens: (cumulativeUsage.inputTokens || 0) + (usage.inputTokens || 0),
              outputTokens: (cumulativeUsage.outputTokens || 0) + (usage.outputTokens || 0),
              totalTokens: (cumulativeUsage.totalTokens || 0) + (usage.totalTokens || (usage.inputTokens || 0) + (usage.outputTokens || 0)),
            };
            // If usage has totalTokens but we double counted, use provided total if larger
            if (usage.totalTokens && usage.totalTokens > 0) {
              // For per-step usage, we should track cumulative as sum, but also allow override if server sends cumulative
              if (message.isCumulative) cumulativeUsage = usage;
            }
          }
          if (typeof message.tokensPerSecond === 'number') currentSpeed = message.tokensPerSecond;
          else if (typeof message.durationMs === 'number' && usage.outputTokens) {
            const sec = message.durationMs / 1000;
            if (sec > 0) currentSpeed = usage.outputTokens / sec;
          }
          if (typeof message.contextWindow === 'number') contextWindow = message.contextWindow;
          if (typeof message.contextTokens === 'number') contextTokens = message.contextTokens;
          if (typeof message.contextPercent === 'number') contextPercent = message.contextPercent;
          else if (contextWindow && contextTokens) contextPercent = (contextTokens / contextWindow) * 100;

          // Live update for hint
          const total = cumulativeUsage.totalTokens || usage.totalTokens || 0;
          const speedStr = currentSpeed > 0 ? ` · ${currentSpeed.toFixed(1)} tok/s` : '';
          const inputStr = usage.inputTokens ? ` in:${usage.inputTokens}` : '';
          const outputStr = usage.outputTokens ? ` out:${usage.outputTokens}` : '';
          if (hintUsage) {
            hintUsage.textContent = `step ${step || ''} · ${total} tokens${inputStr}${outputStr}${speedStr}`.trim();
          }
          updateTokenChips();
        }
        break;
      }
      case 'token-speed': {
        if (typeof message.tokensPerSecond === 'number') {
          currentSpeed = message.tokensPerSecond;
          updateTokenChips();
        }
        break;
      }
      case 'context': {
        if (typeof message.contextTokens === 'number') contextTokens = message.contextTokens;
        if (typeof message.contextWindow === 'number') contextWindow = message.contextWindow;
        if (typeof message.contextPercent === 'number') contextPercent = message.contextPercent;
        else if (contextWindow && contextTokens) contextPercent = (contextTokens / contextWindow) * 100;
        updateTokenChips();
        break;
      }
      case 'mcp-status': {
        if (chipMcp) {
          if (message.enabled) {
            chipMcp.textContent = `mcp: ${message.servers || 0} srv, ${message.tools || 0} tools`;
            chipMcp.hidden = false;
          } else {
            chipMcp.hidden = true;
          }
        }
        break;
      }
      case 'approval-request':
        addItem({
          id: 'approval-' + message.id,
          kind: 'approval',
          approvalId: message.id,
          request: message.request,
        });
        document.querySelector('.app').scrollIntoView(false);
        break;
      case 'reset':
        items.clear();
        elements.clear();
        stream.innerHTML = '';
        if (empty) stream.appendChild(empty);
        hintUsage.textContent = '';
        cumulativeUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        currentSpeed = 0;
        contextTokens = 0;
        contextPercent = 0;
        streamTrackers.clear();
        updateTokenChips();
        toggleEmpty();
        break;
      case 'prefill':
        input.value = (input.value ? input.value + '\n' : '') + (message.text || '');
        input.focus();
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
    for (const node of stream.querySelectorAll('.tool.running .tool-icon')) node.textContent = frames[frame];
    if (spinner && !activityBox.hidden) spinner.textContent = frames[frame];
    if (!busy) return;
    tickActivity();
    tickRunningTools();
    tickThinking();
  }, 250);

  vscode.postMessage({ type: 'ready' });
})();
