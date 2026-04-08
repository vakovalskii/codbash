// ── Calendar ─────────────────────────────────────────────────

var calYear = new Date().getFullYear();
var calMonth = new Date().getMonth();
var calStart = null;
var calEnd = null;
var calSelecting = false;

function toggleCalendar() {
  var popup = document.getElementById('calendarPopup');
  var btn = document.getElementById('dateBtn');
  if (!popup || !btn) return;
  if (popup.classList.contains('open')) {
    popup.classList.remove('open');
    return;
  }
  renderCalendar();
  // Position popup below the button
  var rect = btn.getBoundingClientRect();
  var popupWidth = 280;
  var left = rect.left;
  // Keep within viewport
  if (left + popupWidth > window.innerWidth - 8) {
    left = window.innerWidth - popupWidth - 8;
  }
  popup.style.left = left + 'px';
  popup.style.top = (rect.bottom + 4) + 'px';
  popup.classList.add('open');
  setTimeout(function() {
    document.addEventListener('click', closeCalendarOutside, { once: true });
  }, 0);
}

function closeCalendarOutside(e) {
  var popup = document.getElementById('calendarPopup');
  var btn = document.getElementById('dateBtn');
  if (popup && !popup.contains(e.target) && btn && !btn.contains(e.target)) {
    popup.classList.remove('open');
  } else if (popup && popup.classList.contains('open')) {
    document.addEventListener('click', closeCalendarOutside, { once: true });
  }
}

function renderCalendar() {
  var popup = document.getElementById('calendarPopup');
  if (!popup) return;

  var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var firstDay = new Date(calYear, calMonth, 1);
  var lastDay = new Date(calYear, calMonth + 1, 0);
  var startWeekday = (firstDay.getDay() + 6) % 7; // Monday = 0
  var daysInMonth = lastDay.getDate();
  var today = new Date();
  var todayStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');

  var html = '<div class="cal-header">';
  html += '<button class="cal-nav" onclick="event.stopPropagation();calNav(-1)">&larr;</button>';
  html += '<span>' + monthNames[calMonth] + ' ' + calYear + '</span>';
  html += '<button class="cal-nav" onclick="event.stopPropagation();calNav(1)">&rarr;</button>';
  html += '</div>';

  html += '<div class="cal-weekdays"><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span><span>Su</span></div>';
  html += '<div class="cal-days">';

  var prevLastDay = new Date(calYear, calMonth, 0).getDate();
  for (var i = startWeekday - 1; i >= 0; i--) {
    html += '<div class="cal-day other-month">' + (prevLastDay - i) + '</div>';
  }

  for (var d = 1; d <= daysInMonth; d++) {
    var dateStr = calYear + '-' + String(calMonth+1).padStart(2,'0') + '-' + String(d).padStart(2,'0');
    var cls = 'cal-day';
    if (dateStr === todayStr) cls += ' today';
    if (calStart && calEnd) {
      if (dateStr === calStart) cls += ' range-start';
      if (dateStr === calEnd) cls += ' range-end';
      if (dateStr > calStart && dateStr < calEnd) cls += ' in-range';
      if (calStart === calEnd && dateStr === calStart) cls += ' range-start range-end';
    } else if (calStart && dateStr === calStart) {
      cls += ' range-start range-end';
    }
    html += '<div class="' + cls + '" onclick="event.stopPropagation();calPickDay(\'' + dateStr + '\')">' + d + '</div>';
  }

  var totalCells = startWeekday + daysInMonth;
  var remaining = (7 - (totalCells % 7)) % 7;
  for (var n = 1; n <= remaining; n++) {
    html += '<div class="cal-day other-month">' + n + '</div>';
  }
  html += '</div>';

  html += '<div class="cal-presets">';
  var presets = [['All',''],['Today','0'],['7d','7'],['30d','30'],['90d','90']];
  presets.forEach(function(p) {
    html += '<button class="cal-preset" onclick="event.stopPropagation();calPreset(\'' + p[1] + '\')">' + p[0] + '</button>';
  });
  html += '</div>';

  popup.innerHTML = html;
}

function calNav(dir) {
  calMonth += dir;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
}

function calPickDay(dateStr) {
  if (!calSelecting) {
    calStart = dateStr;
    calEnd = null;
    calSelecting = true;
  } else {
    if (dateStr < calStart) {
      calEnd = calStart;
      calStart = dateStr;
    } else {
      calEnd = dateStr;
    }
    calSelecting = false;
  }
  renderCalendar();
  dateFrom = calStart || '';
  dateTo = calEnd || calStart || '';
  onDateFilter();
}

function calPreset(days) {
  calSelecting = false;
  if (!days) {
    calStart = null;
    calEnd = null;
    dateFrom = '';
    dateTo = '';
  } else {
    var now = new Date();
    calEnd = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
    if (days === '0') {
      calStart = calEnd;
    } else {
      var from = new Date(now.getTime() - parseInt(days) * 86400000);
      calStart = from.getFullYear() + '-' + String(from.getMonth()+1).padStart(2,'0') + '-' + String(from.getDate()).padStart(2,'0');
    }
    dateFrom = calStart;
    dateTo = calEnd;
  }
  renderCalendar();
  onDateFilter();
  var popup = document.getElementById('calendarPopup');
  if (popup) popup.classList.remove('open');
}

function updateDateBtn() {
  var btn = document.getElementById('dateBtn');
  var label = document.getElementById('dateBtnLabel');
  if (!btn || !label) return;
  if (!dateFrom && !dateTo) {
    label.textContent = 'All time';
    btn.classList.remove('has-filter');
  } else if (dateFrom === dateTo) {
    label.textContent = dateFrom;
    btn.classList.add('has-filter');
  } else {
    var f = dateFrom.slice(5) || '';
    var t = dateTo.slice(5) || '';
    label.textContent = f + ' \u2014 ' + t;
    btn.classList.add('has-filter');
  }
}

function toggleGroup() {
  grouped = !grouped;
  var btn = document.getElementById('groupBtn');
  if (btn) btn.classList.toggle('active', grouped);
  render();
}

function setView(view) {
  // Handle tool filter views
  if (view === 'claude-only') {
    toolFilter = toolFilter === 'claude' ? null : 'claude';
    currentView = 'sessions';
  } else if (view === 'codex-only') {
    toolFilter = toolFilter === 'codex' ? null : 'codex';
    currentView = 'sessions';
  } else if (view === 'cursor-only') {
    toolFilter = toolFilter === 'cursor' ? null : 'cursor';
    currentView = 'sessions';
  } else if (view === 'kiro-only') {
    toolFilter = toolFilter === 'kiro' ? null : 'kiro';
    currentView = 'sessions';
  } else if (view === 'opencode-only') {
    toolFilter = toolFilter === 'opencode' ? null : 'opencode';
    currentView = 'sessions';
  } else {
    toolFilter = null;
    currentView = view;
  }

  // Update sidebar active state
  document.querySelectorAll('.sidebar-item').forEach(function(el) {
    el.classList.toggle('active', el.getAttribute('data-view') === view);
  });

  applyFilters();
}

// Wire up sidebar clicks
document.querySelectorAll('.sidebar-item').forEach(function(el) {
  el.addEventListener('click', function() {
    setView(el.getAttribute('data-view'));
  });
});
