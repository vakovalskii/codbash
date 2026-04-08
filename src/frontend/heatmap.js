// ── Activity Heatmap ───────────────────────────────────────────

function localISO(date) {
  var y = date.getFullYear();
  var m = String(date.getMonth() + 1).padStart(2, '0');
  var d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function renderHeatmap(container) {
  var now = new Date();
  var oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());

  // Count sessions per day + by tool
  var counts = {};
  var toolCounts = {};
  allSessions.forEach(function(s) {
    var d = s.date;
    if (!d) return;
    counts[d] = (counts[d] || 0) + 1;
    if (!toolCounts[d]) toolCounts[d] = {};
    toolCounts[d][s.tool] = (toolCounts[d][s.tool] || 0) + 1;
  });

  // Build weeks array — GitHub style: columns are weeks, rows are days
  var d = new Date(oneYearAgo);
  d.setDate(d.getDate() - d.getDay()); // align to Sunday

  var endDate = new Date(now);
  endDate.setDate(endDate.getDate() + (6 - endDate.getDay()));

  var weeks = [];
  var week = [];
  while (d <= endDate) {
    var iso = localISO(d);
    var count = counts[iso] || 0;
    var level = count >= 8 ? 4 : count >= 4 ? 3 : count >= 2 ? 2 : count >= 1 ? 1 : 0;
    var tools = toolCounts[iso] || {};
    var toolTip = Object.keys(tools).map(function(t) { return t + ': ' + tools[t]; }).join(', ');
    week.push({ date: iso, count: count, level: level, day: d.getDay(), toolTip: toolTip });
    if (week.length === 7) { weeks.push(week); week = []; }
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  }
  if (week.length) weeks.push(week);

  // SVG dimensions — GitHub exact sizes
  var cell = 11;
  var gap = 3;
  var step = cell + gap;
  var labelW = 36;
  var headerH = 20;
  var svgW = labelW + weeks.length * step + 10;
  var svgH = headerH + 7 * step + 5;

  // Month labels
  var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var monthLabels = [];
  var lastMonth = -1;
  weeks.forEach(function(w, wi) {
    var m = parseInt(w[0].date.slice(5, 7)) - 1;
    if (m !== lastMonth) {
      monthLabels.push({ x: labelW + wi * step, label: monthNames[m] });
      lastMonth = m;
    }
  });

  // Summary stats
  var yearStart = localISO(oneYearAgo);
  var totalThisYear = 0;
  var maxDay = '';
  var maxCount = 0;
  var activeDays = 0;
  Object.keys(counts).forEach(function(d) {
    if (d >= yearStart) {
      totalThisYear += counts[d];
      activeDays++;
      if (counts[d] > maxCount) { maxCount = counts[d]; maxDay = d; }
    }
  });

  // Streaks
  var currentStreak = 0;
  var longestStreak = 0;
  var tempStreak = 0;
  var checkDate = new Date(now);
  while (true) {
    var ciso = localISO(checkDate);
    if (counts[ciso] && counts[ciso] > 0) {
      currentStreak++;
      checkDate = new Date(checkDate.getFullYear(), checkDate.getMonth(), checkDate.getDate() - 1);
    } else break;
  }
  // Longest streak
  var streakD = new Date(oneYearAgo);
  while (streakD <= now) {
    if (counts[localISO(streakD)]) { tempStreak++; if (tempStreak > longestStreak) longestStreak = tempStreak; }
    else { tempStreak = 0; }
    streakD = new Date(streakD.getFullYear(), streakD.getMonth(), streakD.getDate() + 1);
  }

  // Colors
  var colors = ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'];

  // Build SVG
  var svg = '<svg width="' + svgW + '" height="' + svgH + '" xmlns="http://www.w3.org/2000/svg">';

  // Month labels
  monthLabels.forEach(function(ml) {
    svg += '<text x="' + ml.x + '" y="12" fill="#8b949e" font-size="11" font-family="-apple-system,BlinkMacSystemFont,sans-serif">' + ml.label + '</text>';
  });

  // Day labels
  var dayLabels = [{row: 1, label: 'Mon'}, {row: 3, label: 'Wed'}, {row: 5, label: 'Fri'}];
  dayLabels.forEach(function(dl) {
    svg += '<text x="0" y="' + (headerH + dl.row * step + cell - 1) + '" fill="#8b949e" font-size="10" font-family="-apple-system,BlinkMacSystemFont,sans-serif">' + dl.label + '</text>';
  });

  // Cells
  weeks.forEach(function(w, wi) {
    w.forEach(function(day, di) {
      var x = labelW + wi * step;
      var y = headerH + di * step;
      var fill = colors[day.level];
      var rx = 2;
      svg += '<rect x="' + x + '" y="' + y + '" width="' + cell + '" height="' + cell + '" rx="' + rx + '" fill="' + fill + '" data-date="' + day.date + '" data-count="' + day.count + '">';
      svg += '<title>' + day.count + ' sessions on ' + day.date + (day.toolTip ? ' (' + day.toolTip + ')' : '') + '</title>';
      svg += '</rect>';
    });
  });

  svg += '</svg>';

  // Full page
  var html = '<div class="gh-activity">';
  html += '<div class="gh-header">';
  html += '<span class="gh-total">' + totalThisYear + ' sessions in the last year</span>';
  html += '</div>';
  html += '<div class="gh-graph">' + svg + '</div>';

  // Legend
  html += '<div class="gh-footer">';
  html += '<a href="#" onclick="event.preventDefault()" class="gh-link">Learn how we count sessions</a>';
  html += '<div class="gh-legend">';
  html += '<span>Less</span>';
  colors.forEach(function(c) {
    html += '<span class="gh-legend-cell" style="background:' + c + '"></span>';
  });
  html += '<span>More</span>';
  html += '</div></div>';

  // Stats grid
  html += '<div class="gh-stats">';
  html += '<div class="gh-stat-card">';
  html += '<div class="gh-stat-num">' + totalThisYear + '</div>';
  html += '<div class="gh-stat-label">Total sessions</div>';
  html += '</div>';
  html += '<div class="gh-stat-card">';
  html += '<div class="gh-stat-num">' + activeDays + '</div>';
  html += '<div class="gh-stat-label">Active days</div>';
  html += '</div>';
  html += '<div class="gh-stat-card">';
  html += '<div class="gh-stat-num">' + currentStreak + '</div>';
  html += '<div class="gh-stat-label">Current streak</div>';
  html += '</div>';
  html += '<div class="gh-stat-card">';
  html += '<div class="gh-stat-num">' + longestStreak + '</div>';
  html += '<div class="gh-stat-label">Longest streak</div>';
  html += '</div>';
  html += '<div class="gh-stat-card">';
  html += '<div class="gh-stat-num">' + maxCount + '</div>';
  html += '<div class="gh-stat-label">Best day (' + (maxDay || '-') + ')</div>';
  html += '</div>';
  html += '<div class="gh-stat-card">';
  html += '<div class="gh-stat-num">' + (totalThisYear / Math.max(activeDays, 1)).toFixed(1) + '</div>';
  html += '<div class="gh-stat-label">Avg per active day</div>';
  html += '</div>';
  html += '</div>';

  // Per-tool breakdown
  var toolTotals = {};
  allSessions.forEach(function(s) { if (s.date >= yearStart) { toolTotals[s.tool] = (toolTotals[s.tool] || 0) + 1; } });
  var toolColors = { claude: '#60a5fa', codex: '#22d3ee', opencode: '#c084fc', kiro: '#fb923c' };
  html += '<div class="gh-tools">';
  Object.keys(toolTotals).sort(function(a,b) { return toolTotals[b] - toolTotals[a]; }).forEach(function(tool) {
    var pct = (toolTotals[tool] / Math.max(totalThisYear, 1) * 100).toFixed(0);
    var color = toolColors[tool] || '#6b7280';
    html += '<div class="gh-tool-row">';
    html += '<span class="gh-tool-name" style="color:' + color + '">' + tool + '</span>';
    html += '<div class="gh-tool-bar"><div class="gh-tool-fill" style="width:' + pct + '%;background:' + color + '"></div></div>';
    html += '<span class="gh-tool-val">' + toolTotals[tool] + ' (' + pct + '%)</span>';
    html += '</div>';
  });
  html += '</div>';

  html += '</div>';
  container.innerHTML = html;
}
