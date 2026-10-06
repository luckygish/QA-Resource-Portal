(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  var projectSelect = $('#project-select');
  var assigneeSelect = $('#assignee-select');
  var statusEl = $('#status');
  var countLabel = $('#count-label');
  var dueInput = $('#due-input');
  var refreshBtn = $('#refresh-btn');
  var applyBtn = $('#apply-btn');
  var resultBox = $('#result-box');
  var tasksBody = $('#tasks-body');
  var emptyMsg = $('#empty-msg');
  var checkAll = $('#check-all');

  var tasks = [];
  var visibleTasks = [];
  var selected = new Set();
  var configured = false;

  function setStatus(text, isError) {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('error', !!isError);
  }

  function setBusy(busy) {
    refreshBtn.disabled = busy;
    applyBtn.disabled = busy || selected.size === 0;
  }

  function api(url, opts) {
    opts = opts || {};
    return fetch(url, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; });
    });
  }

  function isoToDmY(iso) {
    if (!iso) return '—';
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return iso;
    return m[3] + '/' + m[2] + '/' + m[1];
  }

  function fmtToday() {
    var d = new Date();
    return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
  }

  function isValidDate(s) {
    var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || '').trim());
    if (!m) return false;
    var d = Number(m[1]);
    var mo = Number(m[2]);
    var y = Number(m[3]);
    var dt = new Date(y, mo - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
  }

  function syncCheckAll() {
    var checked = visibleTasks.filter(function (t) { return selected.has(t.key); }).length;
    checkAll.checked = visibleTasks.length > 0 && checked === visibleTasks.length;
    checkAll.indeterminate = checked > 0 && checked < visibleTasks.length;
  }

  function updateSelectionUi() {
    countLabel.textContent = visibleTasks.length
      ? ('Задач: ' + visibleTasks.length
        + (visibleTasks.length !== tasks.length ? ' из ' + tasks.length : '')
        + (selected.size ? ', выбрано: ' + selected.size : ''))
      : '';
    setBusy(false);
  }

  function renderTasks() {
    tasksBody.innerHTML = '';
    emptyMsg.classList.toggle('hidden', visibleTasks.length !== 0);
    emptyMsg.innerHTML = '';
    updateSelectionUi();

    visibleTasks.forEach(function (t) {
      var tr = document.createElement('tr');
      var chkTd = el('td', 'chk');
      var chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = selected.has(t.key);
      chk.addEventListener('change', function () {
        if (chk.checked) { selected.add(t.key); } else { selected.delete(t.key); }
        updateSelectionUi();
        syncCheckAll();
      });
      chkTd.appendChild(chk);

      var keyTd = el('td');
      var a = document.createElement('a');
      a.className = 'key';
      a.href = t.url || ('https://jira.gnivc.ru/browse/' + t.key);
      a.textContent = t.key;
      a.target = '_blank';
      keyTd.appendChild(a);

      var sumTd = el('td', 'summary', t.summary);
      var tpTd = el('td', null, t.type);
      var stTd = el('td', null, t.status);
      var asTd = el('td', null, t.assignee || '—');
      var dueTd = el('td', null, isoToDmY(t.duedate));

      tr.appendChild(chkTd);
      tr.appendChild(keyTd);
      tr.appendChild(sumTd);
      tr.appendChild(tpTd);
      tr.appendChild(stTd);
      tr.appendChild(asTd);
      tr.appendChild(dueTd);
      tasksBody.appendChild(tr);
    });

    syncCheckAll();
    setBusy(false);
  }

  function selectedAssignee() {
    return assigneeSelect.value || '';
  }

  function applyAssigneeFilter() {
    var a = selectedAssignee();
    visibleTasks = a ? tasks.filter(function (t) { return (t.assignee || '') === a; }) : tasks.slice();
    // При смене фильтра выбор ограничивается только видимыми задачами.
    var visibleKeys = new Set(visibleTasks.map(function (t) { return t.key; }));
    selected.forEach(function (k) { if (!visibleKeys.has(k)) selected.delete(k); });
    renderTasks();
  }

  function refillAssignees() {
    var current = assigneeSelect.value || '';
    var list = [...new Set(tasks.map(function (t) { return t.assignee; }).filter(Boolean))].sort(function (a, b) { return a.localeCompare(b, 'ru'); });
    assigneeSelect.innerHTML = '';
    assigneeSelect.appendChild(new Option('Все', ''));
    list.forEach(function (name) {
      assigneeSelect.appendChild(new Option(name, name));
    });
    assigneeSelect.value = list.indexOf(current) >= 0 ? current : '';
    applyAssigneeFilter();
  }

  function loadTasksImpl() {
    var project = projectSelect.value;
    if (!project) return;
    setBusy(true);
    setStatus('Загрузка задач ' + project + '…');
    tasks = [];
    visibleTasks = [];
    selected = new Set();
    api('/api/tasks?project=' + encodeURIComponent(project))
      .then(function (res) {
        if (!res.ok) throw new Error((res.body && res.body.error) || ('HTTP ' + res.status));
        tasks = res.body.tasks || [];
        refillAssignees();
        setStatus('Проект ' + project + ': активный спринт, задач: ' + (res.body.total || 0) + rowWord(res.body.total || 0) + ', показано: ' + tasks.length + '.');
      })
      .catch(function (e) {
        setStatus('Ошибка: ' + e.message, true);
        renderTasks();
      });
  }

  function rowWord(n) {
    var n10 = n % 10;
    var n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return '';
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return 'и';
    return '';
  }

  function loadProjects() {
    api('/api/projects')
      .then(function (res) {
        if (!res.ok) {
          setStatus('Ошибка загрузки проектов: ' + ((res.body && res.body.error) || 'HTTP ' + res.status), true);
          return;
        }
        var list = (res.body.projects || []).sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); });
        projectSelect.innerHTML = '';
        list.forEach(function (p) {
          projectSelect.appendChild(new Option(p.key + ' — ' + p.name, p.key));
        });
        if (res.body.projects.some(function (p) { return p.key === 'ACS'; })) {
          projectSelect.value = 'ACS';
        }
        loadTasksImpl();
      })
      .catch(function (e) {
        setStatus('Ошибка: ' + e.message, true);
      });
  }

  function showResult(res) {
    resultBox.classList.remove('hidden', 'ok', 'err');
    resultBox.innerHTML = '';
    var ok = okResult(res);

    var headline = document.createElement('div');
    headline.className = 'summary-line' + (ok ? ' ok' : ' err');
    headline.textContent = ok
      ? 'Обновлено задач: ' + res.updated
      : 'Обновлено: ' + res.updated + ', ошибок: ' + (res.failed || []).length;
    resultBox.appendChild(headline);

    if (res.failed && res.failed.length) {
      var ul = document.createElement('ul');
      (res.failed || []).forEach(function (f) {
        var li = document.createElement('li');
        li.textContent = f.key + ' — ' + f.error;
        ul.appendChild(li);
      });
      resultBox.appendChild(ul);
    }
    resultBox.classList.add(ok ? 'ok' : 'err');
  }

  function okResult(res) {
    return res.ok === true || (!res.failed || res.failed.length === 0);
  }

  function applyDueDate() {
    var date = dueInput.value.trim();
    if (!isValidDate(date)) {
      setStatus('Укажите дату в формате dd/MM/yyyy', true);
      return;
    }
    if (!selected.size) {
      setStatus('Нет выбранных задач — отметьте чекбоксы.', true);
      return;
    }
    if (!window.confirm('Проставить ' + date + ' для ' + selected.size + rowWord(selected.size) + ' выбранн' + (selected.size === 1 ? 'ой' : 'ых') + ' задач(и)?')) return;

    var keys = tasks.filter(function (t) { return selected.has(t.key); }).map(function (t) { return t.key; });
    setBusy(true);
    setStatus('Обновление ' + keys.length + ' задач…');
    api('/api/tasks/update', {
      method: 'POST',
      body: { tasks: keys, duedate: date },
    })
      .then(function (res) {
        if (!res.ok && !res.body) throw new Error('HTTP ' + res.status);
        showResult(res.body);
        setStatus('Готово: обновлено ' + res.body.updated + ', ошибок ' + (res.body.failed || []).length + '.');
        return loadTasksImpl();
      })
      .then(function () {
        setBusy(false);
      })
      .catch(function (e) {
        setStatus('Ошибка обновления: ' + e.message, true);
        setBusy(false);
      });
  }

  dueInput.value = fmtToday();

  projectSelect.addEventListener('change', function () { loadTasksImpl(); });
  assigneeSelect.addEventListener('change', function () { applyAssigneeFilter(); });
  checkAll.addEventListener('change', function () {
    if (checkAll.checked) {
      visibleTasks.forEach(function (t) { selected.add(t.key); });
    } else {
      visibleTasks.forEach(function (t) { selected.delete(t.key); });
    }
    renderTasks();
  });
  refreshBtn.addEventListener('click', function () { loadTasksImpl(); });
  applyBtn.addEventListener('click', applyDueDate);

  api('/api/config')
    .then(function (res) {
      configured = res.ok;
      if (!res.ok) {
        setStatus((res.body && res.body.error) || 'Jira не настроена', true);
        setBusy(true);
        return;
      }
      loadProjects();
    })
    .catch(function () {
      setStatus('Сервер JiraTime недоступен', true);
      setBusy(true);
    });
})();