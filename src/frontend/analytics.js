// ── Cost Analytics ────────────────────────────────────────────

var _analyticsHtmlCache = null;
var _analyticsCacheUrl = null;

function switchAnalyticsTab(tab) {
  document.querySelectorAll('.atab-pane').forEach(function(el) {
    el.style.display = el.dataset.tab === tab ? 'block' : 'none';
  });
  document.querySelectorAll('.atab-btn').forEach(function(el) {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  localStorage.setItem('codedash-analytics-tab', tab);
}

async function renderAnalytics(container) {
  // Check frontend cache first — show instantly if same filters
  var url = '/api/analytics/cost';
  var params = [];
  if (dateFrom) params.push('from=' + dateFrom);
  if (dateTo) params.push('to=' + dateTo);
  if (params.length) url += '?' + params.join('&');

  if (_analyticsHtmlCache && _analyticsCacheUrl === url) {
    container.innerHTML = _analyticsHtmlCache;
    var activeTab = localStorage.getItem('codedash-analytics-tab') || 'overview';
    switchAnalyticsTab(activeTab);
    return;
  }

  container.innerHTML = '<div class="loading">Loading analytics...</div>';

  try {
    var resp = await fetch(url);
    var data = await resp.json();

    // Guard: if user navigated away during fetch, don't overwrite
    if (currentView !== 'analytics') return;

    var html = '<div class="analytics-container">';
    html += '<h2 class="heatmap-title">Cost Analytics</h2>';

    // ── Tab bar ────────────────────────────────────────────────
    html += '<div class="analytics-tabs">';
    html += '<button class="atab-btn" data-tab="overview" onclick="switchAnalyticsTab(\'overview\')">Overview</button>';
    html += '<button class="atab-btn" data-tab="breakdown" onclick="switchAnalyticsTab(\'breakdown\')">Breakdown</button>';
    html += '<button class="atab-btn" data-tab="history" onclick="switchAnalyticsTab(\'history\')">History</button>';
    html += '</div>';

    // ══ TAB: Overview ══════════════════════════════════════════
    html += '<div class="atab-pane" data-tab="overview">';

    // ── Summary cards ──────────────────────────────────────────
    html += '<div class="analytics-summary">';
    html += '<div class="analytics-card"><span class="analytics-val">$' + data.totalCost.toFixed(2) + '</span><span class="analytics-label">Total cost (API-equivalent)</span></div>';
    html += '<div class="analytics-card"><span class="analytics-val">' + formatTokens(data.totalTokens) + '</span><span class="analytics-label">Total tokens</span></div>';
    html += '<div class="analytics-card"><span class="analytics-val">$' + (data.dailyRate || 0).toFixed(2) + '</span><span class="analytics-label">Avg per day (' + (data.days || 1) + ' days)</span></div>';
    html += '<div class="analytics-card"><span class="analytics-val">' + data.totalSessions + '</span><span class="analytics-label">Sessions with cost data' + (data.totalSessionsAll > data.totalSessions ? ' / ' + data.totalSessionsAll + ' total' : '') + '</span></div>';
    html += '</div>';

    // ── Burn rate ──────────────────────────────────────────────
    var todayCost = data.todayCost || 0;
    var last1hCost = data.last1hCost || 0;
    var dailyRate = data.dailyRate || 0;
    var hoursElapsed = data.hoursElapsedToday || 1;
    // Project today's pace to a full day for comparison
    var projectedDaily = todayCost / (hoursElapsed / 24);
    var paceRatio = dailyRate > 0 ? projectedDaily / dailyRate : 0;
    var burnClass = paceRatio >= 2 ? 'burn-high' : paceRatio >= 1.3 ? 'burn-medium' : 'burn-low';
    var paceLabel = paceRatio >= 2 ? '🔥 ' + Math.round(paceRatio) + 'x avg' : paceRatio >= 1.3 ? '↑ ' + paceRatio.toFixed(1) + 'x avg' : dailyRate > 0 ? '✓ normal' : '';
    html += '<div class="burn-rate-bar">';
    html += '<div class="burn-rate-title">Burn Rate</div>';
    html += '<div class="burn-rate-stats">';
    html += '<div class="burn-stat"><span class="burn-val ' + burnClass + '">$' + todayCost.toFixed(3) + '</span><span class="burn-label">today</span>' + (paceLabel ? '<span class="burn-pace ' + burnClass + '">' + paceLabel + '</span>' : '') + '</div>';
    html += '<div class="burn-stat"><span class="burn-val">$' + last1hCost.toFixed(3) + '</span><span class="burn-label">last hour</span></div>';
    if (dailyRate > 0) {
      html += '<div class="burn-stat"><span class="burn-val">$' + projectedDaily.toFixed(2) + '</span><span class="burn-label">projected today</span></div>';
    }
    html += '</div>';
    html += '</div>';

    // ── Data coverage note ────────────────────────────────────
    if (data.byAgent || data.agentNoCostData) {
      var coverageparts = [];
      var byAgent = data.byAgent || {};
      var noCost = data.agentNoCostData || {};
      if (byAgent['claude'] && byAgent['claude'].sessions > 0)
        coverageparts.push('<span class="coverage-ok">Claude Code \u2713</span>');
      if (byAgent['claude-ext'] && byAgent['claude-ext'].sessions > 0)
        coverageparts.push('<span class="coverage-ok">Claude Extension \u2713</span>');
      if (byAgent['codex'] && byAgent['codex'].sessions > 0)
        coverageparts.push('<span class="coverage-est">Codex ~est.</span>');
      if (byAgent['qwen'] && byAgent['qwen'].sessions > 0) {
        coverageparts.push(byAgent['qwen'].unavailable
          ? '<span class="coverage-est">Qwen tokens only</span>'
          : '<span class="coverage-ok">Qwen Code \u2713</span>');
      }
      if (byAgent['opencode'] && byAgent['opencode'].sessions > 0)
        coverageparts.push(byAgent['opencode'].estimated
          ? '<span class="coverage-est">OpenCode ~est.</span>'
          : '<span class="coverage-ok">OpenCode \u2713</span>');
      ['cursor', 'kiro'].forEach(function(a) {
        if (noCost[a] > 0)
          coverageparts.push('<span class="coverage-none">' + a + ' \u2717 (no token data)</span>');
      });
      if (noCost['opencode'] > 0 && !(byAgent['opencode'] && byAgent['opencode'].sessions > 0))
        coverageparts.push('<span class="coverage-none">opencode \u2717 (no token data)</span>');
      if (coverageparts.length > 0) {
        html += '<div class="analytics-coverage">Cost data: ' + coverageparts.join(' \u00b7 ') + '</div>';
      }
    }

    // ── Cost by agent (overview) ───────────────────────────────
    var agentEntriesOv = Object.entries(data.byAgent || {}).filter(function(e) { return e[1].sessions > 0; });
    if (agentEntriesOv.length > 1) {
      agentEntriesOv.sort(function(a, b) { return b[1].cost - a[1].cost; });
      html += '<div class="chart-section"><h3>Cost by Agent</h3>';
      html += '<div class="hbar-chart">';
      var maxAgentCostOv = agentEntriesOv[0][1].cost || 1;
      agentEntriesOv.forEach(function(entry) {
        var name = entry[0]; var info = entry[1];
        var pct = maxAgentCostOv > 0 ? (info.cost / maxAgentCostOv * 100) : 0;
        var label = getToolLabel(name);
        var estMark = info.unavailable
          ? ' <span style="font-size:10px;opacity:0.6">tokens only</span>'
          : (info.estimated ? ' <span style="font-size:10px;opacity:0.6">~est.</span>' : '');
        html += '<div class="hbar-row">';
        html += '<span class="hbar-name">' + label + estMark + '</span>';
        html += '<div class="hbar-track"><div class="hbar-fill" style="width:' + pct + '%"></div></div>';
        html += '<span class="hbar-val">$' + info.cost.toFixed(2) + ' <span style="font-size:10px;opacity:0.6">(' + info.sessions + ' sess.)</span></span>';
        html += '</div>';
      });
      html += '</div></div>';
    }

    html += '</div>'; // end atab-pane overview

    // ══ TAB: Breakdown ═════════════════════════════════════════
    html += '<div class="atab-pane" data-tab="breakdown">';

    // ── Token breakdown ────────────────────────────────────────
    if (data.totalInputTokens !== undefined) {
      var totalTok = data.totalInputTokens + data.totalOutputTokens + data.totalCacheReadTokens + data.totalCacheCreateTokens;
      var pctOf = function(n) { return totalTok > 0 ? Math.round(n / totalTok * 100) : 0; };
      html += '<div class="chart-section analytics-token-breakdown">';
      html += '<h3>Token Breakdown</h3>';
      html += '<div class="token-breakdown-grid">';
      html += '<div class="token-type-card"><span class="token-type-val">' + formatTokens(data.totalInputTokens) + '</span><span class="token-type-label">Input</span><span class="token-type-pct">' + pctOf(data.totalInputTokens) + '%</span></div>';
      html += '<div class="token-type-card"><span class="token-type-val">' + formatTokens(data.totalOutputTokens) + '</span><span class="token-type-label">Output</span><span class="token-type-pct">' + pctOf(data.totalOutputTokens) + '%</span></div>';
      html += '<div class="token-type-card token-cache-read"><span class="token-type-val">' + formatTokens(data.totalCacheReadTokens) + '</span><span class="token-type-label">Cache read</span><span class="token-type-pct">' + pctOf(data.totalCacheReadTokens) + '%</span></div>';
      html += '<div class="token-type-card token-cache-create"><span class="token-type-val">' + formatTokens(data.totalCacheCreateTokens) + '</span><span class="token-type-label">Cache write</span><span class="token-type-pct">' + pctOf(data.totalCacheCreateTokens) + '%</span></div>';
      if (data.avgContextPct > 0) {
        html += '<div class="token-type-card token-context"><span class="token-type-val">' + data.avgContextPct + '%</span><span class="token-type-label">Avg context used</span><span class="token-type-pct">window avg</span></div>';
      }
      html += '</div>';

      // ── Cost attribution stacked bar ──────────────────────────
      // Uses Sonnet-baseline ratios projected onto actual totalCost.
      // Ratios are model-agnostic (Claude output/input is ~5:1 across all tiers).
      if (data.outputCostEst !== undefined && data.totalCost > 0) {
        var estTotal = data.inputCostEst + data.outputCostEst + data.cacheReadCostEst + data.cacheCreateCostEst;
        var sharePct = function(v) { return estTotal > 0 ? (v / estTotal * 100) : 0; };
        var actualOf = function(v) { return (sharePct(v) / 100 * data.totalCost); };

        var outPct = sharePct(data.outputCostEst).toFixed(1);
        var inPct  = sharePct(data.inputCostEst).toFixed(1);
        var cwPct  = sharePct(data.cacheCreateCostEst).toFixed(1);
        var crPct  = sharePct(data.cacheReadCostEst).toFixed(1);

        html += '<div class="cost-attr-section">';
        html += '<div class="cost-attr-title">Where your money goes</div>';
        html += '<div class="cost-attr-bar">';
        if (parseFloat(outPct) > 0) html += '<div class="cost-attr-seg seg-output" style="width:' + outPct + '%" title="Output tokens: ~' + outPct + '% of cost"></div>';
        if (parseFloat(inPct) > 0)  html += '<div class="cost-attr-seg seg-input"  style="width:' + inPct  + '%" title="Input tokens: ~' + inPct + '% of cost"></div>';
        if (parseFloat(cwPct) > 0)  html += '<div class="cost-attr-seg seg-cw"     style="width:' + cwPct  + '%" title="Cache write: ~' + cwPct + '% of cost"></div>';
        if (parseFloat(crPct) > 0)  html += '<div class="cost-attr-seg seg-cr"     style="width:' + crPct  + '%" title="Cache read: ~' + crPct + '% of cost"></div>';
        html += '</div>';
        html += '<div class="cost-attr-legend">';
        html += '<span class="cost-attr-item"><span class="cost-attr-dot seg-output"></span>Output ~' + outPct + '% (~$' + actualOf(data.outputCostEst).toFixed(2) + ')</span>';
        html += '<span class="cost-attr-item"><span class="cost-attr-dot seg-input"></span>Input ~' + inPct + '% (~$' + actualOf(data.inputCostEst).toFixed(2) + ')</span>';
        if (parseFloat(cwPct) > 0) html += '<span class="cost-attr-item"><span class="cost-attr-dot seg-cw"></span>Cache write ~' + cwPct + '%</span>';
        if (parseFloat(crPct) > 0) html += '<span class="cost-attr-item"><span class="cost-attr-dot seg-cr"></span>Cache read ~' + crPct + '%</span>';
        html += '</div>';

        if (data.cacheHitRate > 0 || data.cacheSavings > 0) {
          html += '<div class="cache-metrics">';
          if (data.cacheHitRate > 0) {
            var hitColor = data.cacheHitRate >= 60 ? 'var(--accent-green)' : data.cacheHitRate >= 30 ? '#f59e0b' : 'var(--text-muted)';
            html += '<span class="cache-metric" style="color:' + hitColor + '">Cache hit rate: <b>' + data.cacheHitRate + '%</b></span>';
          }
          if (data.cacheSavings > 0.001) {
            html += '<span class="cache-metric" style="color:var(--accent-green)">Cache saved ~<b>$' + data.cacheSavings.toFixed(0) + '</b> vs no-cache</span>';
          }
          html += '</div>';
        }
        html += '</div>';
      }

      html += '</div>'; // chart-section
    }

    html += '</div>'; // end atab-pane breakdown

    // ══ TAB: History ═══════════════════════════════════════════
    html += '<div class="atab-pane" data-tab="history">';

    // ── Subscription vs API ────────────────────────────────────
    var sub = getSubscriptionConfig();
    var subEntries = (sub && sub.entries) || [];
    var totalPaid = subTotalPaid(subEntries);
    html += '<div class="chart-section subscription-section">';
    html += '<h3>Subscription vs API</h3>';

    if (totalPaid > 0) {
      var savings = data.totalCost - totalPaid;
      var multiplier = data.totalCost / totalPaid;
      var savingsPositive = savings > 0;
      var breakdown = subEntries.map(function(e) {
        return escHtml(e.plan || 'Sub') + ' $' + parseFloat(e.paid).toFixed(0);
      }).join(' + ');
      html += '<div class="sub-comparison">';
      html += '<div class="sub-card sub-paid"><span class="sub-val">$' + totalPaid.toFixed(2) + '</span><span class="sub-label">Paid (' + breakdown + ')</span></div>';
      html += '<div class="sub-card sub-api"><span class="sub-val">$' + data.totalCost.toFixed(2) + '</span><span class="sub-label">Would cost at API rates</span></div>';
      html += '<div class="sub-card ' + (savingsPositive ? 'sub-savings' : 'sub-loss') + '"><span class="sub-val">' + (savingsPositive ? '+' : '') + '$' + Math.abs(savings).toFixed(2) + '</span><span class="sub-label">' + (savingsPositive ? 'Saved (' + multiplier.toFixed(1) + '\u00d7 ROI)' : 'API would be cheaper') + '</span></div>';
      html += '</div>';
      var barPct = Math.min(100, data.totalCost > 0 ? (totalPaid / data.totalCost * 100) : 100);
      html += '<div class="sub-bar-track" title="$' + totalPaid.toFixed(2) + ' paid of $' + data.totalCost.toFixed(2) + ' API equivalent">';
      html += '<div class="sub-bar-fill" style="width:' + barPct + '%"></div>';
      html += '</div>';
    } else {
      html += '<p class="sub-hint">Add your subscription periods below to see how much you\'re saving vs API rates.</p>';
    }

    // Period list
    html += '<div class="sub-entries">';
    if (subEntries.length > 0) {
      subEntries.forEach(function(e, i) {
        var serviceLabel = e.service && SERVICE_PLANS[e.service] ? SERVICE_PLANS[e.service].label : e.service || '';
        html += '<div class="sub-entry-row">';
        if (serviceLabel) html += '<span class="sub-entry-service">' + escHtml(serviceLabel) + '</span>';
        html += '<span class="sub-entry-plan">' + escHtml(e.plan || '\u2014') + '</span>';
        html += '<span class="sub-entry-paid">$' + parseFloat(e.paid || 0).toFixed(2) + '/mo</span>';
        html += '<span class="sub-entry-from">' + (e.from ? 'from ' + e.from : 'no date') + '</span>';
        html += '<button class="sub-entry-remove" onclick="removeSubEntry(' + i + ')" title="Remove">\u00d7</button>';
        html += '</div>';
      });
    }
    html += '</div>';

    // Add form
    var serviceOptions = '<option value="">— service —</option>' +
      Object.keys(SERVICE_PLANS).map(function(k) {
        return '<option value="' + k + '">' + SERVICE_PLANS[k].label + '</option>';
      }).join('');
    html += '<div class="sub-add-form">';
    html += '<select id="sub-new-service" onchange="onSubServiceChange()">' + serviceOptions + '</select>';
    html += '<select id="sub-new-plan" onchange="onSubPlanChange()"><option value="">— plan —</option></select>';
    html += '<input id="sub-new-paid" type="number" min="0" step="0.01" placeholder="$/mo" />';
    html += '<input id="sub-new-from" type="date" title="Start date of this billing period" />';
    html += '<button onclick="addSubEntry()">+ Add period</button>';
    html += '</div>';
    html += '</div>';

    // ── Daily cost chart ───────────────────────────────────────
    var dayKeys = Object.keys(data.byDay).sort();
    var last30 = dayKeys.slice(-30);
    if (last30.length > 0) {
      var maxCost = Math.max.apply(null, last30.map(function(d) { return data.byDay[d].cost; }));
      html += '<div class="chart-section"><h3>Daily Cost (last 30 days)</h3>';
      html += '<div class="bar-chart">';
      last30.forEach(function(d) {
        var c = data.byDay[d];
        var pct = maxCost > 0 ? (c.cost / maxCost * 100) : 0;
        var label = d.slice(5); // MM-DD
        html += '<div class="bar-col" title="' + d + ': $' + c.cost.toFixed(2) + ' (' + c.sessions + ' sessions)">';
        html += '<div class="bar-fill" style="height:' + pct + '%"></div>';
        html += '<div class="bar-label">' + label + '</div>';
        html += '</div>';
      });
      html += '</div></div>';
    }

    // ── Cost by project ────────────────────────────────────────
    var projects = Object.entries(data.byProject).sort(function(a, b) { return b[1].cost - a[1].cost; });
    var topProjects = projects.slice(0, 10);
    if (topProjects.length > 0) {
      var maxProjCost = topProjects[0][1].cost;
      html += '<div class="chart-section"><h3>Cost by Project</h3>';
      html += '<div class="hbar-chart">';
      topProjects.forEach(function(entry) {
        var name = entry[0];
        var info = entry[1];
        var pct = maxProjCost > 0 ? (info.cost / maxProjCost * 100) : 0;
        html += '<div class="hbar-row">';
        html += '<span class="hbar-name">' + escHtml(name) + '</span>';
        html += '<div class="hbar-track"><div class="hbar-fill" style="width:' + pct + '%"></div></div>';
        html += '<span class="hbar-val">$' + info.cost.toFixed(2) + '</span>';
        html += '</div>';
      });
      html += '</div></div>';
    }

    // ── Top expensive sessions ─────────────────────────────────
    if (data.topSessions && data.topSessions.length > 0) {
      html += '<div class="chart-section"><h3>Most Expensive Sessions</h3>';
      html += '<div class="top-sessions">';
      data.topSessions.forEach(function(s) {
        html += '<div class="top-session-row" onclick="onCardClick(\'' + s.id + '\', event)">';
        html += '<span class="top-session-cost">$' + s.cost.toFixed(2) + '</span>';
        html += '<span class="top-session-project">' + escHtml(s.project) + '</span>';
        html += '<span class="top-session-date">' + (s.date || '') + '</span>';
        html += '<span class="top-session-id">' + s.id.slice(0, 8) + '</span>';
        html += '</div>';
      });
      html += '</div></div>';
    }

    html += '</div>'; // end atab-pane history
    html += '</div>'; // analytics-container
    container.innerHTML = html;
    _analyticsHtmlCache = html;
    _analyticsCacheUrl = url;

    // Activate the stored (or default) tab
    var activeTab = localStorage.getItem('codedash-analytics-tab') || 'overview';
    switchAnalyticsTab(activeTab);
  } catch (e) {
    container.innerHTML = '<div class="empty-state">Failed to load analytics.</div>';
  }
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
  return String(n);
}
