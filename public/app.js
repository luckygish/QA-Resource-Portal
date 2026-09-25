(function () {
  'use strict';

  const GRADES = ['Junior', 'Middle', 'Senior', 'Lead'];
  const REQUEST_STATUSES = ['Новая', 'В работе', 'Закрыта', 'Отклонена'];
  const REQUEST_STATUS_CLASS = { 'Новая': 'blue', 'В работе': 'partial', 'Закрыта': 'gray', 'Отклонена': 'full' };

  const state = {
    data: { users: [], projects: [], requests: [], managers: [] },
    currentUserId: null,
    gantt: null,
  };
  let modalStack = [];

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  function outstaffFlag() {
    const s = el('span', 'outstaff-flag');
    s.setAttribute('data-tip', 'Сотрудник вне штата');
    s.setAttribute('aria-label', 'Сотрудник вне штата');
    return s;
  }

  /* ---------------- utils ---------------- */

  const fmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const fmtDate = (iso) => (iso ? fmt.format(new Date(iso)) : '—');
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const dayNum = (iso) => new Date(iso).getTime();

  // normalizes a percent input to an integer in 1..100, or null if invalid
  function validPercent(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 && n <= 100 ? n : null;
  }

  function overlap(aStart, aEnd, bStart, bEnd) {
    return dayNum(aStart) <= dayNum(bEnd) && dayNum(bStart) <= dayNum(aEnd);
  }

  function projectName(id) {
    const p = state.data.projects.find((x) => x.id === Number(id));
    return p ? p.name : `#${id}`;
  }

  function projectById(id) {
    return state.data.projects.find((x) => x.id === Number(id)) || null;
  }

  function managerById(id) {
    return (state.data.managers || []).find((m) => m.id === Number(id)) || null;
  }

  function managerName(id) {
    const m = managerById(id);
    return m ? m.name : '—';
  }

  function activeRange() {
    const from = $('#filter-from').value || null;
    const to = $('#filter-to').value || null;
    return { from, to };
  }

  function refRange() {
    const { from, to } = activeRange();
    if (from || to) return { start: from || '0001-01-01', end: to || '9999-12-31' };
    return null;
  }

  function matchesRef(assignment) {
    const ref = refRange();
    return ref ? overlap(assignment.start, assignment.end, ref.start, ref.end) : true;
  }

  function assignmentSum(user) {
    return user.assignments
      .filter((a) => matchesRef(a))
      .reduce((s, a) => s + (Number(a.percent) || 0), 0);
  }

  function getUserStatus(user) {
    const sum = assignmentSum(user);
    if (sum === 0) return { label: 'свободен', cls: 'free', sum };
    if (sum < 100) return { label: 'частично занят', cls: 'partial', sum };
    return { label: 'полностью занят', cls: 'full', sum };
  }

  function activeAssignments(user) {
    return user.assignments.filter((a) => matchesRef(a));
  }

  // Mirrors server checkOverload: returns conflicts where combined percent > 100 on any day.
  function overloadConflicts(user, candidate) {
    const relevant = user.assignments.filter((a) => a.id !== candidate.id && overlap(a.start, a.end, candidate.start, candidate.end));
    if (relevant.length === 0) return null;
    const DAY = 86400000;
    const cStart = dayNum(candidate.start);
    const cEnd = dayNum(candidate.end);
    for (let t = cStart; t <= cEnd; t += DAY) {
      let total = Number(candidate.percent) || 0;
      const onDay = [];
      relevant.forEach((a) => {
        if (dayNum(a.start) <= t && t <= dayNum(a.end)) {
          total += Number(a.percent) || 0;
          onDay.push(a);
        }
      });
      if (total > 100) {
        return onDay.map((a) => ({ day: new Date(t).toISOString().slice(0, 10), total, assignment: a }));
      }
    }
    return null;
  }

  function uid() {
    return 'uid' + Math.random().toString(36).slice(2, 10);
  }

  // Manager for a given assignment: from the project's manager, preferring that,
  // falling back to the request assigned to this user on the same project.
  function assignmentManager(user, assignment) {
    const project = projectById(assignment.projectId);
    if (project && project.managerId != null) {
      const m = managerById(project.managerId);
      if (m) return m.name;
    }
    const req = state.data.requests.find(
      (r) => r.assignedUserId === user.id && String(r.projectId) === String(assignment.projectId)
    );
    if (req && req.managerId != null) return managerName(req.managerId);
    return null;
  }

  /* ---------------- data ---------------- */

  async function api(path, opts) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
    if (!res.ok) {
      const err = new Error((body && body.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.conflicts = body && body.conflicts;
      throw err;
    }
    return body;
  }

  async function loadData() {
    state.data = await api('/api/data');
    renderProjectFilters();
    renderRegistryFilters();
    renderUsers();
    renderRequests();
    renderRegistry();
    renderAssessment();
    renderProjectOptions();
    renderProjects();
    renderManagers();
  }

  async function refresh() {
    await loadData();
    if (state.currentUserId != null && state.modalBody) {
      const u = state.data.users.find((x) => x.id === state.currentUserId);
      if (u) {
        state.modalHeader.innerHTML = '';
        state.modalHeader.appendChild(renderUserHeader(u));
        state.modalBody.innerHTML = '';
        state.modalBody.appendChild(renderProfile(u));
        state.modalBody.appendChild(renderSkills(u));
        state.modalBody.appendChild(renderGantt(u));
        state.modalBody.appendChild(renderAssignments(u));
      }
    }
  }

  /* ---------------- toast ---------------- */

  function toast(msg, type) {
    const t = el('div', 'toast' + (type === 'error' ? ' error' : ''), msg);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }

  /* ---------------- tabs ---------------- */

  function bindTabs() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        switchTab(tab.dataset.tab);
      });
    });
  }

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    ['resources', 'requests', 'assessment', 'registry', 'projects', 'jira'].forEach((id) => {
      $('#' + id).classList.toggle('hidden', id !== name);
    });
    if (name === 'registry') renderRegistry();
    if (name === 'assessment') renderAssessment();
    if (name === 'projects') switchProjectsSub(projectsSub);
    if (name === 'jira') renderJiraTab();
  }

  /* ---------------- project filter options ---------------- */

  function renderProjectFilters() {
    for (const selId of ['filter-project', 'req-filter-project']) {
      const sel = $(`#${selId}`);
      const current = sel.value;
      sel.innerHTML = '';
      sel.appendChild(new Option('Все', ''));
      state.data.projects.forEach((p) => sel.appendChild(new Option(p.name, String(p.id))));
      if (current) sel.value = current;
    }
  }

  /* ---------------- users table ---------------- */

  function renderUsers() {
    const grade = $('#filter-grade').value;
    const projectId = $('#filter-project').value;
    const status = $('#filter-status').value;

    const list = state.data.users.filter((u) => {
      if (grade && u.grade !== grade) return false;
      if (status && getUserStatus(u).label !== status) return false;
      if (projectId) {
        if (!u.assignments.some((a) => String(a.projectId) === projectId && matchesRef(a))) return false;
      }
      return true;
    });

    const tbody = $('#user-rows');
    tbody.innerHTML = '';
    $('#empty-state').classList.toggle('hidden', list.length > 0);

    list.forEach((u) => {
      const tr = el('tr');
      tr.addEventListener('click', () => openUserCard(u.id));

      const active = activeAssignments(u);
      const projectsCell = el('td');
      if (active.length === 0) {
        projectsCell.appendChild(el('i', null, 'не назначен'));
      } else {
        active.forEach((a) => {
          projectsCell.appendChild(el('span', 'pill', `${projectName(a.projectId)} · ${fmtDate(a.start)} — ${fmtDate(a.end)} · ${a.percent}%`));
        });
      }

      const status = getUserStatus(u);
      const skillParts = u.skills.map((s) => `${skillName(s.skillId)} · у${s.level}`);
      const MAX_SKILLS = 3;
      const skillsText = skillParts.length
        ? skillParts.slice(0, MAX_SKILLS).join(', ') + (skillParts.length > MAX_SKILLS ? ' …' : '')
        : '—';

      const nameTd = el('td');
      const bold = el('b');
      bold.textContent = u.name;
      nameTd.appendChild(bold);
      if (u.isOutstaff) nameTd.appendChild(outstaffFlag());
      if (u.email) nameTd.appendChild(el('div', null, u.email));

      const statusTd = el('td');
      statusTd.appendChild(el('span', `badge ${status.cls}`, status.label));

      tr.appendChild(nameTd);
      tr.appendChild(projectsCell);
      tr.appendChild(statusTd);
      tr.appendChild(el('td', null, u.grade));
      tr.appendChild(el('td', null, skillsText));
      tbody.appendChild(tr);
    });
  }

  /* ---------------- user card modal ---------------- */

  function openUserCard(id) {
    state.currentUserId = id;
    const u = state.data.users.find((x) => x.id === id);
    if (!u) return;

    const modal = el('div', 'modal');
    const header = el('div', 'modal-header');
    header.appendChild(renderUserHeader(u));
    modal.appendChild(header);

    const body = el('div', 'modal-body');
    body.appendChild(renderProfile(u));
    body.appendChild(renderSkills(u));
    body.appendChild(renderGantt(u));
    body.appendChild(renderAssignments(u));
    modal.appendChild(body);

    state.modalHeader = header;
    state.modalBody = body;

    const footer = el('div', 'modal-footer');
    const del = el('button', 'danger', 'Удалить тестировщика');
    del.addEventListener('click', async () => {
      if (!confirm(`Удалить тестировщика «${u.name}»?`)) return;
      await api(`/api/users/${u.id}`, { method: 'DELETE' });
      closeModal();
      await loadData();
    });
    footer.appendChild(del);
    footer.appendChild(el('button', 'primary', 'Закрыть'));
    // modal-footer button "Закрыть" here is decorative; actual close via mask
    footer.lastChild.addEventListener('click', closeModal);
    modal.appendChild(footer);

    openModal(modal);
  }

  function renderUserHeader(u) {
    const h = el('h2');
    h.appendChild(document.createTextNode(`${u.name} · ${u.grade}`));
    if (u.isOutstaff) h.appendChild(outstaffFlag());
    return h;
  }

  function renderProfile(u) {
    const box = el('div');
    box.appendChild(el('div', 'section-title', 'Профиль'));

    const rows = el('div', 'form-row');
    const nameField = el('div', 'field');
    nameField.appendChild(el('label', null, 'ФИО'));
    const nameInput = el('input');
    nameInput.value = u.name;
    nameInput.addEventListener('change', async () => {
      try {
        await api(`/api/users/${u.id}`, { method: 'PUT', body: { name: nameInput.value, grade: u.grade } });
        await refresh();
      } catch (e) { toast(e.message, 'error'); nameInput.value = u.name; }
    });
    nameField.appendChild(nameInput);

    const gradeField = el('div', 'field');
    gradeField.appendChild(el('label', null, 'Грейд'));
    const gradeSel = el('select');
    GRADES.forEach((g) => gradeSel.appendChild(new Option(g, g)));
    gradeSel.value = u.grade;
    gradeSel.addEventListener('change', async () => {
      try {
        await api(`/api/users/${u.id}`, { method: 'PUT', body: { name: u.name, grade: gradeSel.value } });
        await refresh();
      } catch (e) { toast(e.message, 'error'); }
    });
    gradeField.appendChild(gradeSel);

    const emailField = el('div', 'field');
    emailField.appendChild(el('label', null, 'Email'));
    const emailInput = el('input');
    emailInput.value = u.email || '';
    emailInput.addEventListener('change', async () => {
      try {
        await api(`/api/users/${u.id}`, { method: 'PUT', body: { email: emailInput.value } });
        await refresh();
      } catch (e) { toast(e.message, 'error'); }
    });
    emailField.appendChild(emailInput);

    const ageField = el('div', 'field');
    ageField.appendChild(el('label', null, 'Возраст'));
    const ageInput = el('input');
    ageInput.type = 'number';
    ageInput.min = 0;
    ageInput.max = 200;
    ageInput.value = u.age ?? '';
    ageInput.addEventListener('change', async () => {
      const val = ageInput.value.trim();
      const age = val === '' ? null : Number(val);
      if (age !== null && (!Number.isInteger(age) || age < 0 || age > 200)) {
        toast('Возраст должен быть целым числом от 0 до 200', 'error');
        ageInput.value = u.age ?? '';
        return;
      }
      try {
        await api(`/api/users/${u.id}`, { method: 'PUT', body: { age } });
        await refresh();
      } catch (e) { toast(e.message, 'error'); }
    });
    ageField.appendChild(ageInput);

    rows.appendChild(nameField);
    rows.appendChild(gradeField);
    rows.appendChild(emailField);
    rows.appendChild(ageField);
    box.appendChild(rows);

    const aboutField = el('div', 'field');
    aboutField.appendChild(el('label', null, 'О себе (до 255 символов)'));
    const aboutInput = el('textarea');
    aboutInput.rows = 3;
    aboutInput.maxLength = 255;
    aboutInput.value = u.about || '';
    aboutInput.addEventListener('change', async () => {
      try {
        await api(`/api/users/${u.id}`, { method: 'PUT', body: { about: aboutInput.value } });
        await refresh();
      } catch (e) { toast(e.message, 'error'); }
    });
    aboutField.appendChild(aboutInput);
    box.appendChild(aboutField);

    const outstaffField = el('div', 'field');
    const outstaffLabel = el('label', 'check-line');
    const outstaffCheck = el('input');
    outstaffCheck.type = 'checkbox';
    outstaffCheck.checked = !!u.isOutstaff;
    outstaffLabel.appendChild(outstaffCheck);
    outstaffLabel.appendChild(document.createTextNode('Outstaff (вне штата)'));
    outstaffCheck.addEventListener('change', async () => {
      try {
        await api(`/api/users/${u.id}`, { method: 'PUT', body: { isOutstaff: outstaffCheck.checked } });
        await refresh();
      } catch (e) { toast(e.message, 'error'); outstaffCheck.checked = !!u.isOutstaff; }
    });
    outstaffField.appendChild(outstaffLabel);
    box.appendChild(outstaffField);

    return box;
  }

  function renderSkills(u) {
    const box = el('div');
    box.appendChild(el('div', 'section-title', 'Навыки'));

    const list = el('div');
    u.skills.forEach((s, idx) => {
      const row = el('div', 'skill-row');
      const reg = registryById(s.skillId);
      const name = el('span', reg ? 'link' : 'name', skillName(s.skillId));
      if (reg) name.addEventListener('click', () => openSkillInfo(u, s));
      else name.title = 'Навык отсутствует в реестре';
      row.appendChild(name);
      const lv = el('select');
      [1, 2, 3, 4].forEach((n) => lv.appendChild(new Option(String(n), String(n))));
      lv.value = String(s.level);
      lv.addEventListener('change', async () => {
        try {
          await api(`/api/users/${u.id}/skills/${idx}`, { method: 'PUT', body: { level: Number(lv.value) } });
          await refresh();
        } catch (e) { toast(e.message, 'error'); }
      });
      const del = el('button', 'small danger', 'x');
      del.addEventListener('click', async () => {
        await api(`/api/users/${u.id}/skills/${idx}`, { method: 'DELETE' });
        await refresh();
      });
      row.appendChild(lv);
      row.appendChild(del);
      list.appendChild(row);
    });
    if (u.skills.length === 0) list.appendChild(el('i', null, 'нет навыков'));
    box.appendChild(list);

    // add form (dropdown from registry)
    const add = el('div', 'skill-row');
    const nameSel = el('select');
    nameSel.appendChild(new Option('Выберите навык', ''));
    state.data.skillRegistry.forEach((r) => nameSel.appendChild(new Option(r.skill, String(r.id))));
    const lv = el('select');
    [1, 2, 3, 4].forEach((n) => lv.appendChild(new Option(String(n), String(n))));
    const btn = el('button', 'small primary', 'Добавить');
    btn.addEventListener('click', async () => {
      if (!nameSel.value) return toast('Выберите навык из реестра', 'error');
      try {
        await api(`/api/users/${u.id}/skills`, { method: 'POST', body: { skillId: Number(nameSel.value), level: Number(lv.value) } });
        nameSel.value = '';
        await refresh();
      } catch (e) { toast(e.message, 'error'); }
    });
    add.appendChild(nameSel);
    add.appendChild(lv);
    add.appendChild(btn);
    box.appendChild(add);
    return box;
  }

  function openSkillInfo(user, userSkill) {
    const reg = registryById(userSkill.skillId);
    const cur = Number(userSkill.level);
    if (!reg) return toast('Описание навыка отсутствует в реестре', 'error');

    const modal = el('div', 'modal');
    const header = el('div', 'modal-header');
    header.appendChild(el('h2', null, reg.skill));
    modal.appendChild(header);

    const body = el('div', 'modal-body');
    body.appendChild(el('div', 'meta', `Текущий уровень: ${cur}`));
    body.appendChild(el('div', 'section-title', `Уровень ${cur}`));
    body.appendChild(el('p', 'level-desc', reg.levels[cur] || 'Описание отсутствует.'));
    if (cur < 4) {
      body.appendChild(el('div', 'section-title', `Следующий уровень (${cur + 1})`));
      body.appendChild(el('p', 'level-desc next', reg.levels[cur + 1] || 'Описание отсутствует.'));
    } else {
      body.appendChild(el('p', 'level-desc next', 'Достигнут максимальный уровень (4).'));
    }
    modal.appendChild(body);

    const footer = el('div', 'modal-footer');
    const ok = el('button', 'primary', 'Закрыть');
    ok.addEventListener('click', closeModal);
    footer.appendChild(ok);
    modal.appendChild(footer);

    openModal(modal, { stacked: true });
  }

  function ganttTasks(u) {
    return u.assignments.map((a) => ({
      id: String(a.id),
      name: projectName(a.projectId),
      start: new Date(a.start),
      end: new Date(a.end),
      progress: Math.max(0, Math.min(100, Number(a.percent) || 0)) / 100,
    }));
  }

  function renderGantt(u) {
    const box = el('div');
    box.appendChild(el('div', 'section-title', 'Календарь занятости'));
    const holder = el('div');
    holder.id = 'gantt-' + uid();
    box.appendChild(holder);
    // render after insertion into DOM
    requestAnimationFrame(() => {
      renderGanttInto(holder, u);
    });
    return box;
  }

  function renderGanttInto(container, u) {
    container.innerHTML = '';
    if (u.assignments.length === 0) {
      container.appendChild(el('i', null, 'нет назначений'));
      return;
    }
    const iso = (d) => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);

    const saveAssign = async (task, patch) => {
      const aid = Number(task.id);
      const assignment = u.assignments.find((a) => a.id === aid);
      const body = {
        projectId: assignment.projectId,
        start: assignment.start,
        end: assignment.end,
        percent: assignment.percent,
        ...patch,
      };
      try {
        await api(`/api/users/${u.id}/assignments/${aid}`, { method: 'PUT', body });
        await refresh();
      } catch (e) {
        toast('Не сохранено: ' + e.message, 'error');
        if (e.conflicts) msgConflict(e);
        await refresh();
      }
    };

    try {
      new Gantt('#' + container.id, ganttTasks(u), {
        view_mode: 'Month',
        date_format: 'YYYY-MM-DD',
        bar_height: 24,
        padding: 18,
        auto_schedule: false,
        on_date_change: async (task, start, end) => {
          await saveAssign(task, { start: iso(start), end: iso(end) });
        },
        on_progress_change: async (task, pct) => {
          const clamped = Math.max(1, Math.min(100, Math.round(pct)));
          await saveAssign(task, { percent: clamped });
        },
      });
    } catch (e) {
      container.appendChild(el('i', null, 'Gantt недоступен'));
    }
  }

  function renderAssignments(u) {
    const box = el('div');
    box.appendChild(el('div', 'section-title', 'Назначения'));

    const table = el('table', 'assign-table');
    const thead = el('thead');
    const hr = el('tr');
    ['Проект', 'Менеджер проекта', 'Начало', 'Окончание', '%', ''].forEach((t) => hr.appendChild(el('th', null, t)));
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el('tbody');
    u.assignments.forEach((a) => {
      const tr = el('tr');

      const projectCell = el('div', 'proj-cell', projectName(a.projectId));
      const mgrName = assignmentManager(u, a);
      const managerCell = el('div', (mgrName ? '' : 'muted ') + 'proj-cell', mgrName || '—');

      const start = dateInput(a.start);
      const end = dateInput(a.end);
      const percent = el('input');
      percent.type = 'number';
      percent.min = 1;
      percent.max = 100;
      percent.value = a.percent;

      const save = async () => {
        const pct = validPercent(percent.value);
        if (pct == null) {
          toast('Занятость должна быть в диапазоне 1–100%', 'error');
          percent.value = a.percent;
          return;
        }
        const candidate = {
          id: a.id,
          projectId: a.projectId,
          start: start.value || a.start,
          end: end.value || a.end,
          percent: pct,
        };
        const conflicts = overloadConflicts(u, candidate);
        if (conflicts) {
          msgConflict({ conflicts });
          return;
        }
        try {
          await api(`/api/users/${u.id}/assignments/${a.id}`, { method: 'PUT', body: candidate });
          await refresh();
        } catch (e) {
          toast('Не сохранено: ' + e.message, 'error');
          if (e.conflicts) msgConflict(e);
        }
      };

      start.addEventListener('change', save);
      end.addEventListener('change', save);
      percent.addEventListener('change', save);

      const del = el('button', 'small danger', 'Удалить');
      del.addEventListener('click', async () => {
        await api(`/api/users/${u.id}/assignments/${a.id}`, { method: 'DELETE' });
        await refresh();
      });

      const td = (cell) => { const c = el('td'); c.appendChild(cell); return c; };
      tr.appendChild(td(projectCell));
      tr.appendChild(td(managerCell));
      tr.appendChild(td(start));
      tr.appendChild(td(end));
      tr.appendChild(td(percent));
      tr.appendChild(td(del));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    box.appendChild(table);

    // add assignment
    box.appendChild(el('div', 'section-title', 'Добавить назначение'));
    const add = el('div', 'assign-add');
    const afPick = searchableSelect({
      placeholder: 'Выберите проект',
      options: state.data.projects.map((p) => ({ value: p.id, label: p.name + (p.abbreviation ? ` (${p.abbreviation})` : '') })),
    });
    const af = afPick.root;
    const as = dateInput(todayISO());
    const ae = dateInput(todayISO());
    const ap = el('input');
    ap.type = 'number'; ap.min = 1; ap.max = 100; ap.value = 50;
    const ab = el('button', 'small primary', 'Добавить');
    ab.addEventListener('click', async () => {
      const projectId = afPick.getValue();
      if (!projectId) return toast('Выберите проект', 'error');
      const pct = validPercent(ap.value);
      if (pct == null) return toast('Занятость должна быть в диапазоне 1–100%', 'error');
      const candidate = { id: 0, projectId: Number(projectId), start: as.value, end: ae.value, percent: pct };
      const conflicts = overloadConflicts(u, candidate);
      if (conflicts) return msgConflict({ conflicts });
      try {
        await api(`/api/users/${u.id}/assignments`, {
          method: 'POST',
          body: candidate,
        });
        await refresh();
      } catch (e) {
        toast('Не добавлено: ' + e.message, 'error');
        if (e.conflicts) msgConflict(e);
      }
    });
    const td = (cell) => { const c = el('div'); c.appendChild(cell); return c; };
    add.appendChild(td(af));
    add.appendChild(td(as));
    add.appendChild(td(ae));
    add.appendChild(td(ap));
    add.appendChild(td(ab));

    box.appendChild(add);

    return box;
  }

  function msgConflict(e) {
    e.conflicts.forEach((c) => {
      toast(`Пересечение с «${projectName(c.assignment.projectId)}» — ${c.day}, сумма занятости ${c.total}%`, 'error');
    });
  }

  function dateInput(iso) {
    const i = el('input');
    i.type = 'date';
    i.value = iso;
    return i;
  }

  /* ---------------- modal plumbing ---------------- */

  function openModal(content, opts) {
    const mask = el('div', 'modal-mask' + (opts && opts.stacked ? ' nested' : ''));
    mask.appendChild(content);
    mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });
    $('#modal-root').appendChild(mask);
    modalStack.push(mask);
  }

  function closeModal() {
    if (modalStack.length) {
      modalStack.pop().remove();
    }
    if (modalStack.length === 0) {
      state.currentUserId = null;
      state.gantt = null;
      state.modalHeader = null;
      state.modalBody = null;
    }
  }

  /* ---------------- shared controls: searchable select + helpers ---------------- */

  function searchableSelect({ placeholder, options, onChange }) {
    const root = el('div', 'searchable-select');
    const toggle = el('button', 'dd-toggle searchable-toggle'); toggle.type = 'button'; toggle.textContent = placeholder;
    const panel = el('div', 'dd-panel hidden');
    const search = el('input', 'dd-search'); search.placeholder = 'Поиск…';
    const list = el('div', 'dd-list');
    panel.appendChild(search);
    panel.appendChild(list);
    root.appendChild(toggle);
    root.appendChild(panel);
    let selected = null;

    function renderList(q) {
      list.innerHTML = '';
      const items = q ? options.filter((o) => String(o.label).toLowerCase().includes(q)) : options;
      if (!items.length) { list.appendChild(el('div', 'dd-empty', 'Ничего не найдено.')); return; }
      items.forEach((o) => {
        const row = el('div', 'check-item' + (selected && String(selected.value) === String(o.value) ? ' selected' : ''));
        row.appendChild(el('span', null, o.label));
        if (selected && String(selected.value) === String(o.value)) row.appendChild(el('span', 'check-mark', '\u2713'));
        row.addEventListener('click', () => { selected = o; toggle.textContent = o.label; toggle.title = o.label; hide(); if (typeof onChange === 'function') onChange(selected.value); });
        list.appendChild(row);
      });
    }
    function hide() { panel.classList.add('hidden'); }
    function show() {
      document.querySelectorAll('.searchable-select .dd-panel').forEach((p) => { if (p !== panel) p.classList.add('hidden'); });
      panel.classList.remove('hidden');
      renderList(search.value.trim().toLowerCase());
      search.focus();
    }
    toggle.addEventListener('click', (e) => { e.stopPropagation(); panel.classList.contains('hidden') ? show() : hide(); });
    search.addEventListener('input', () => renderList(search.value.trim().toLowerCase()));
    document.addEventListener('click', (e) => { if (!root.contains(e.target)) hide(); });

    return {
      root,
      getValue: () => (selected ? selected.value : null),
      setValue: (v) => {
        selected = options.find((o) => String(o.value) === String(v)) || null;
        toggle.textContent = selected ? selected.label : placeholder;
        toggle.title = selected ? selected.label : '';
      },
    };
  }

  async function searchJiraUsers(q) {
    const query = String(q || '').trim();
    if (!query) return [];
    try {
      return (await api('/api/jira/users?q=' + encodeURIComponent(query))) || [];
    } catch (e) { return []; }
  }

  function findPortalUser(name, email) {
    const normName = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const normEmail = String(email || '').trim().toLowerCase();
    return state.data.users.find((u) => {
      const un = String(u.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const ue = String(u.email || '').trim().toLowerCase();
      return (normEmail && ue && normEmail === ue) || (normName && un && normName === un);
    });
  }

  /* ---------------- requests tab ---------------- */

  function renderRequests() {
    const status = $('#req-filter-status').value;
    const projectId = $('#req-filter-project').value;
    const grade = $('#req-filter-grade').value;

    const list = state.data.requests.filter((r) => {
      if (status && r.status !== status) return false;
      if (projectId && String(r.projectId) !== projectId) return false;
      if (grade && r.grade !== grade) return false;
      return true;
    });

    const host = $('#request-list');
    host.innerHTML = '';
    if (list.length === 0) {
      host.appendChild(el('p', 'empty', 'Заявок нет. Нажмите «Потребность», чтобы создать новую.'));
      return;
    }
    list.forEach((r) => {
      host.appendChild(requestCard(r));
    });
  }

  function requestCard(r) {
    const card = el('div', 'card');
    const h3 = el('h3');
    h3.appendChild(el('span', null, projectName(r.projectId)));
    h3.appendChild(el('span', `badge ${REQUEST_STATUS_CLASS[r.status]}`, r.status));
    card.appendChild(h3);

    const meta = el('div');
    meta.appendChild(el('div', 'meta', `Грейд: ${r.grade}`));
    meta.appendChild(el('div', 'meta', `Период: ${fmtDate(r.start)} — ${fmtDate(r.end)}`));
    meta.appendChild(el('div', 'meta', `Занятость: ${r.percent}%`));
    meta.appendChild(el('div', 'meta', `Менеджер проекта: ${r.managerId != null ? managerName(r.managerId) : '—'}`));
    const assignedUser = r.assignedUserId != null ? state.data.users.find((u) => u.id === r.assignedUserId) : null;
    meta.appendChild(el('div', 'meta', `Назначен: ${assignedUser ? assignedUser.name : '—'}`));
    if (r.comment) meta.appendChild(el('div', 'comment', `«${r.comment}»`));
    card.appendChild(meta);

    const actions = el('div', 'row-actions');

    if (r.status === 'Новая') {
      const as = el('select');
      as.appendChild(new Option('Назначить...', ''));
      state.data.users.forEach((u) => as.appendChild(new Option(u.name, String(u.id))));
      as.addEventListener('change', async () => {
        if (!as.value) return;
        try {
          await api(`/api/requests/${r.id}/assign`, { method: 'POST', body: { userId: Number(as.value) } });
          await loadData();
        } catch (e) {
          toast('Не назначено: ' + e.message, 'error');
          if (e.conflicts) msgConflict(e);
          as.value = '';
        }
      });
      actions.appendChild(as);
    }

    const st = el('select');
    REQUEST_STATUSES.forEach((s) => st.appendChild(new Option(s, s)));
    st.value = r.status;
    st.addEventListener('change', async () => {
      try {
        await api(`/api/requests/${r.id}`, { method: 'PUT', body: { status: st.value } });
        await loadData();
      } catch (e) { toast(e.message, 'error'); }
    });
    actions.appendChild(st);

    const del = el('button', 'small danger', 'Удалить');
    del.addEventListener('click', async () => {
      if (!confirm('Удалить заявку?')) return;
      await api(`/api/requests/${r.id}`, { method: 'DELETE' });
      await loadData();
    });
    actions.appendChild(del);

    card.appendChild(actions);
    return card;
  }

  /* ---------------- request form modal ---------------- */

  function openRequestForm() {
    const modal = el('div', 'modal');
    const header = el('div', 'modal-header');
    header.appendChild(el('h2', null, 'Новая потребность'));
    modal.appendChild(header);

    const body = el('div', 'modal-body');
    const msg = el('div', 'form-msg');

    const fieldWrap = (labelText, input) => {
      const f = el('div', 'field');
      f.appendChild(el('label', null, labelText));
      f.appendChild(input);
      return f;
    };

    const projectPick = searchableSelect({
      placeholder: 'Выберите проект',
      options: state.data.projects.map((p) => ({ value: p.id, label: p.name + (p.abbreviation ? ` (${p.abbreviation})` : '') })),
      onChange: (value) => {
        const proj = projectById(value);
        if (proj && proj.managerId != null) managerSel.value = String(proj.managerId);
      },
    });
    const projectSel = projectPick.root;

    const gradeSel = el('select');
    GRADES.forEach((g) => gradeSel.appendChild(new Option(g, g)));

    const start = el('input'); start.type = 'date';
    const end = el('input'); end.type = 'date';
    const percent = el('input'); percent.type = 'number'; percent.min = 1; percent.max = 100; percent.value = 50;
    const comment = el('textarea'); comment.rows = 2; comment.placeholder = 'Обязательно';

    const managerSel = el('select');
    managerSel.appendChild(new Option('Выберите менеджера', ''));
    state.data.managers.forEach((m) => managerSel.appendChild(new Option(m.name, String(m.id))));

    const row1 = el('div', 'form-row');
    row1.appendChild(fieldWrap('Проект', projectSel));
    row1.appendChild(fieldWrap('Желаемый грейд', gradeSel));
    const row2 = el('div', 'form-row');
    row2.appendChild(fieldWrap('Начало', start));
    row2.appendChild(fieldWrap('Окончание', end));
    row2.appendChild(fieldWrap('Занятость %', percent));
    body.appendChild(row1);
    body.appendChild(row2);
    body.appendChild(fieldWrap('Менеджер проекта', managerSel));
    body.appendChild(fieldWrap('Комментарий', comment));
    body.appendChild(msg);
    modal.appendChild(body);

    const footer = el('div', 'modal-footer');
    const cancel = el('button', null, 'Отмена');
    cancel.addEventListener('click', closeModal);
    const submit = el('button', 'primary', 'Отправить');
    submit.addEventListener('click', async () => {
      const projectId = projectPick.getValue();
      if (!projectId) return fail('Выберите проект');
      if (!gradeSel.value) return fail('Укажите грейд');
      if (!start.value || !end.value) return fail('Укажите период');
      if (dayNum(start.value) > dayNum(end.value)) return fail('Начало позже окончания');
      if (validPercent(percent.value) == null) return fail('Занятость должна быть в диапазоне 1–100%');
      if (!managerSel.value) return fail('Выберите менеджера проекта');
      if (!comment.value.trim()) return fail('Заполните комментарий');
      try {
        await api('/api/requests', {
          method: 'POST',
          body: {
            projectId: Number(projectId),
            grade: gradeSel.value,
            start: start.value,
            end: end.value,
            percent: validPercent(percent.value),
            comment: comment.value.trim(),
            managerId: Number(managerSel.value),
          },
        });
        closeModal();
        await loadData();
        $('#requests').classList.remove('hidden');
        switchTab('requests');
      } catch (e) { fail(e.message); }
    });
    function fail(m) { msg.textContent = m; msg.className = 'form-msg error'; }
    footer.appendChild(cancel);
    footer.appendChild(submit);
    modal.appendChild(footer);

    openModal(modal);
  }

  /* ---------------- projects / managers registry ---------------- */

  let projectsSub = 'proj';

  function bindProjectsTabs() {
    document.querySelectorAll('.sub-tab').forEach((t) => {
      t.addEventListener('click', () => {
        projectsSub = t.dataset.sub;
        switchProjectsSub(projectsSub);
      });
    });
  }

  function switchProjectsSub(name) {
    document.querySelectorAll('.sub-tab').forEach((t) => t.classList.toggle('active', t.dataset.sub === name));
    $('#sub-proj').classList.toggle('hidden', name !== 'proj');
    $('#sub-mgr').classList.toggle('hidden', name !== 'mgr');
    if (name === 'proj') renderProjects();
    else renderManagers();
  }

  function renderProjectOptions() {
    const fill = (selId, vals) => {
      const sel = $(selId);
      const current = sel.value;
      const uniq = [...new Set(vals.filter((v) => v != null && v !== '').map((v) => String(v)))].sort();
      sel.innerHTML = '';
      sel.appendChild(new Option('Все', ''));
      uniq.forEach((v) => sel.appendChild(new Option(v, v)));
      sel.value = uniq.includes(current) ? current : '';
    };
    fill('#proj-filter-name', state.data.projects.map((p) => p.name));
    fill('#proj-filter-abbr', state.data.projects.map((p) => p.abbreviation));
    fill('#proj-filter-contract', state.data.projects.map((p) => p.contractNumber));
  }

  function renderProjects() {
    const q = String($('#proj-search').value || '').trim().toLowerCase();
    const nameF = $('#proj-filter-name').value;
    const abbrF = $('#proj-filter-abbr').value;
    const contractF = $('#proj-filter-contract').value;

    const list = state.data.projects.filter((p) => {
      if (nameF && p.name !== nameF) return false;
      if (abbrF && p.abbreviation !== abbrF) return false;
      if (contractF && (p.contractNumber || '') !== contractF) return false;
      if (q) {
        const hay = (p.name + ' ' + (p.abbreviation || '')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const tbody = $('#proj-rows');
    tbody.innerHTML = '';
    $('#proj-empty').classList.toggle('hidden', list.length > 0);

    list.forEach((p) => {
      const tr = el('tr');
      const nameTd = el('td');
      nameTd.appendChild(el('span', 'link', p.name));
      nameTd.addEventListener('click', () => openProjectCard(p.id));
      tr.appendChild(nameTd);
      tr.appendChild(el('td', null, p.abbreviation || '—'));
      tr.appendChild(el('td', null, p.contractNumber || '—'));
      tr.appendChild(el('td', null, p.managerId != null ? managerName(p.managerId) : '—'));

      const act = el('td');
      const edit = el('button', 'small', 'Редактировать');
      edit.addEventListener('click', () => openProjectCard(p.id));
      const del = el('button', 'small danger', 'Удалить');
      del.addEventListener('click', async () => {
        if (!confirm(`Удалить проект «${p.name}»?`)) return;
        try {
          await api(`/api/projects/${p.id}`, { method: 'DELETE' });
          await loadData();
        } catch (e) { toast(e.message, 'error'); }
      });
      act.appendChild(edit);
      act.appendChild(del);
      tr.appendChild(act);
      tbody.appendChild(tr);
    });
  }

  function openProjectCard(id) {
    const editing = id != null;
    const src = editing ? projectById(id) : null;

    const modal = el('div', 'modal');
    const header = el('div', 'modal-header');
    header.appendChild(el('h2', null, editing ? 'Редактировать проект' : 'Новый проект'));
    modal.appendChild(header);

    const body = el('div', 'modal-body');
    const msg = el('div', 'form-msg');
    const fieldWrap = (labelText, input) => {
      const f = el('div', 'field');
      f.appendChild(el('label', null, labelText));
      f.appendChild(input);
      return f;
    };

    let pendingJiraKey = editing ? (src.jiraKey || null) : null;
    let jiraProjectsCache = [];
    let nameMode = pendingJiraKey || (editing && !pendingJiraKey ? '__custom__' : '');
    const jiraNames = {};

    const nameCustom = el('input');
    nameCustom.type = 'text';
    nameCustom.value = editing && !src.jiraKey ? src.name : '';
    nameCustom.placeholder = 'Название проекта вручную';
    nameCustom.style.display = nameMode === '__custom__' ? 'block' : 'none';

    const jiraKeyInfo = el('div', 'field-hint', pendingJiraKey ? `Связан с Jira: ${pendingJiraKey}` : '');

    const nameWrap = el('div', 'searchable-select');
    const nameBtn = el('button', 'dd-toggle'); nameBtn.type = 'button'; nameBtn.textContent = 'Выберите проект (поиск по Jira)';
    const namePanel = el('div', 'dd-panel hidden');
    const nameSearch = el('input', 'dd-search'); nameSearch.placeholder = 'Поиск по Jira…';
    const nameList = el('div', 'dd-list');
    namePanel.appendChild(nameSearch);
    namePanel.appendChild(nameList);
    nameWrap.appendChild(nameBtn);
    nameWrap.appendChild(namePanel);

    const nameLabelOf = (p) => `${p.key} — ${p.name}`;

    function renderNameList(q) {
      nameList.innerHTML = '';
      const ql = String(q || '').toLowerCase();

      const manualRow = el('div', 'check-item' + (nameMode === '__custom__' ? ' selected' : ''));
      manualRow.appendChild(el('span', null, '— ввести вручную —'));
      if (nameMode === '__custom__') manualRow.appendChild(el('span', 'check-mark', '\u2713'));
      manualRow.addEventListener('click', () => selectName('__custom__'));
      nameList.appendChild(manualRow);

      const items = ql ? jiraProjectsCache.filter((p) => (p.key + ' ' + p.name).toLowerCase().includes(ql)) : jiraProjectsCache;
      if (!items.length && !ql) nameList.appendChild(el('div', 'dd-empty', 'Проекты Jira не загружены.'));
      items.forEach((p) => {
        const row = el('div', 'check-item' + (nameMode === p.key ? ' selected' : ''));
        row.appendChild(el('span', null, nameLabelOf(p)));
        if (nameMode === p.key) row.appendChild(el('span', 'check-mark', '\u2713'));
        row.addEventListener('click', () => selectName(p.key));
        nameList.appendChild(row);
      });
    }

    function selectName(mode) {
      nameMode = mode;
      if (mode === '__custom__') {
        pendingJiraKey = null;
        nameCustom.style.display = 'block';
        nameBtn.textContent = '— ввести вручную —';
        jiraKeyInfo.textContent = 'Связь с Jira не задана (вводится вручную).';
      } else if (mode) {
        pendingJiraKey = mode;
        nameCustom.style.display = 'none';
        const p = jiraProjectsCache.find((x) => x.key === mode);
        nameBtn.textContent = p ? nameLabelOf(p) : mode;
        jiraKeyInfo.textContent = `Связан с Jira: ${mode}${p ? ` — «${p.name}»` : ''}`;
      } else {
        pendingJiraKey = null;
        nameCustom.style.display = 'none';
        nameBtn.textContent = 'Выберите проект (поиск по Jira)';
        jiraKeyInfo.textContent = 'Выберите проект из Jira либо введите вручную.';
      }
      namePanel.classList.add('hidden');
      nameSearch.value = '';
    }

    function showName() {
      document.querySelectorAll('.searchable-select .dd-panel').forEach((p) => { if (p !== namePanel) p.classList.add('hidden'); });
      namePanel.classList.remove('hidden');
      renderNameList('');
      nameSearch.focus();
    }
    nameBtn.addEventListener('click', (e) => { e.stopPropagation(); namePanel.classList.contains('hidden') ? showName() : namePanel.classList.add('hidden'); });
    nameSearch.addEventListener('input', () => renderNameList(nameSearch.value.trim().toLowerCase()));
    document.addEventListener('click', (e) => { if (!nameWrap.contains(e.target)) namePanel.classList.add('hidden'); });

    (async () => {
      try {
        jiraProjectsCache = (await api('/api/jira/projects')) || [];
      } catch (e) { /* Jira недоступна — только ручной ввод */ }
      jiraProjectsCache.forEach((p) => { jiraNames[p.key] = p.name; });
      if (nameMode && nameMode !== '__custom__') {
        const p = jiraProjectsCache.find((x) => x.key === nameMode);
        nameBtn.textContent = p ? nameLabelOf(p) : nameMode;
      }
    })();

    const nameField = fieldWrap('Название проекта', nameWrap);
    nameField.appendChild(nameCustom);
    nameField.appendChild(jiraKeyInfo);

    const abbrInput = el('input'); abbrInput.value = editing ? (src.abbreviation || '') : '';

    const contractField = el('div', 'field');
    contractField.appendChild(el('label', null, 'Номер контракта'));
    const contractInput = el('input'); contractInput.value = editing ? (src.contractNumber || '') : '';
    contractField.appendChild(contractInput);

    const managerSel = el('select');
    managerSel.appendChild(new Option('Без менеджера', ''));
    state.data.managers.forEach((m) => managerSel.appendChild(new Option(m.name, String(m.id))));
    managerSel.value = editing && src.managerId != null ? String(src.managerId) : '';

    body.appendChild(nameField);
    body.appendChild(fieldWrap('Аббревиатура', abbrInput));
    body.appendChild(contractField);
    body.appendChild(fieldWrap('Менеджер проекта', managerSel));
    body.appendChild(msg);
    modal.appendChild(body);

    const footer = el('div', 'modal-footer');
    const cancel = el('button', null, 'Отмена');
    cancel.addEventListener('click', closeModal);
    const submit = el('button', 'primary', 'Сохранить');
    submit.addEventListener('click', async () => {
      let name;
      if (!nameMode || nameMode === '__custom__') {
        name = nameCustom.value.trim();
      } else {
        name = jiraNames[nameMode] || nameMode;
      }
      pendingJiraKey = (nameMode && nameMode !== '__custom__') ? nameMode : null;
      const payload = {
        name,
        abbreviation: abbrInput.value.trim(),
        contractNumber: contractInput.value.trim(),
        managerId: managerSel.value || null,
        jiraKey: pendingJiraKey || null,
      };
      try {
        if (editing) await api(`/api/projects/${src.id}`, { method: 'PUT', body: payload });
        else await api('/api/projects', { method: 'POST', body: payload });
        closeModal();
        await loadData();
      } catch (e) { fail(e.message); }
    });
    function fail(m) { msg.textContent = m; msg.className = 'form-msg error'; }
    footer.appendChild(cancel);
    footer.appendChild(submit);
    modal.appendChild(footer);

    openModal(modal);
  }

  function renderManagers() {
    const q = String($('#mgr-search').value || '').trim().toLowerCase();

    const list = (state.data.managers || []).filter((m) => {
      if (q) {
        const hay = (m.name + ' ' + (m.email || '')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const tbody = $('#mgr-rows');
    tbody.innerHTML = '';
    $('#mgr-empty').classList.toggle('hidden', list.length > 0);

    list.forEach((m) => {
      const tr = el('tr');
      const nameTd = el('td');
      nameTd.appendChild(el('span', 'link', m.name));
      nameTd.addEventListener('click', () => openManagerCard(m.id));
      tr.appendChild(nameTd);
      tr.appendChild(el('td', null, m.email || '—'));

      const projectsUnder = state.data.projects.filter((p) => p.managerId === m.id);
      const projTd = el('td');
      if (projectsUnder.length === 0) projTd.appendChild(el('i', null, '—'));
      else projectsUnder.forEach((p) => projTd.appendChild(el('span', 'pill', p.name)));
      tr.appendChild(projTd);

      const act = el('td');
      const edit = el('button', 'small', 'Редактировать');
      edit.addEventListener('click', () => openManagerCard(m.id));
      const del = el('button', 'small danger', 'Удалить');
      del.addEventListener('click', async () => {
        if (!confirm(`Удалить менеджера «${m.name}»?`)) return;
        try {
          await api(`/api/managers/${m.id}`, { method: 'DELETE' });
          await loadData();
        } catch (e) { toast(e.message, 'error'); }
      });
      act.appendChild(edit);
      act.appendChild(del);
      tr.appendChild(act);
      tbody.appendChild(tr);
    });
  }

  function openManagerCard(id) {
    const editing = id != null;
    const src = editing ? managerById(id) : null;

    const modal = el('div', 'modal');
    const header = el('div', 'modal-header');
    header.appendChild(el('h2', null, editing ? 'Редактировать менеджера' : 'Новый менеджер'));
    modal.appendChild(header);

    const body = el('div', 'modal-body');
    const msg = el('div', 'form-msg');
    const fieldWrap = (labelText, input) => {
      const f = el('div', 'field');
      f.appendChild(el('label', null, labelText));
      f.appendChild(input);
      return f;
    };
    const nameInput = el('input'); nameInput.value = editing ? src.name : '';
    const emailInput = el('input'); emailInput.value = editing ? (src.email || '') : '';
    body.appendChild(fieldWrap('ФИО', nameInput));
    body.appendChild(fieldWrap('Email', emailInput));
    body.appendChild(msg);
    modal.appendChild(body);

    const footer = el('div', 'modal-footer');
    const cancel = el('button', null, 'Отмена');
    cancel.addEventListener('click', closeModal);
    const submit = el('button', 'primary', 'Сохранить');
    submit.addEventListener('click', async () => {
      if (!nameInput.value.trim()) { msg.textContent = 'Укажите имя менеджера'; msg.className = 'form-msg error'; return; }
      const payload = { name: nameInput.value.trim(), email: emailInput.value.trim() };
      try {
        if (editing) await api(`/api/managers/${src.id}`, { method: 'PUT', body: payload });
        else await api('/api/managers', { method: 'POST', body: payload });
        closeModal();
        await loadData();
      } catch (e) { fail(e.message); }
    });
    function fail(m) { msg.textContent = m; msg.className = 'form-msg error'; }
    footer.appendChild(cancel);
    footer.appendChild(submit);
    modal.appendChild(footer);

    openModal(modal);
  }

  /* ---------------- skill registry ---------------- */

  function registryById(id) {
    return state.data.skillRegistry.find((s) => s.id === Number(id)) || null;
  }

  function skillName(id) {
    const s = registryById(id);
    return s ? s.skill : `#${id}`;
  }

  function renderRegistryFilters() {
    const sel = $('#reg-cat');
    const current = sel.value;
    sel.innerHTML = '';
    sel.appendChild(new Option('Все', ''));
    state.data.categories.forEach((c) => sel.appendChild(new Option(c.name, c.name)));
    if (current) sel.value = current;
  }

  function renderRegistry() {
    const q = String($('#reg-search').value || '').trim().toLowerCase();
    const cat = $('#reg-cat').value;

    const list = state.data.skillRegistry.filter((s) => {
      if (q && !s.skill.toLowerCase().includes(q)) return false;
      if (cat && s.category !== cat) return false;
      return true;
    });

    const tbody = $('#reg-rows');
    tbody.innerHTML = '';
    $('#reg-empty').classList.toggle('hidden', list.length > 0);

    list.forEach((s) => {
      const tr = el('tr');
      const nameTd = el('td');
      nameTd.appendChild(el('span', 'link', s.skill));
      nameTd.addEventListener('click', () => openSkillCard(s.id));
      tr.appendChild(nameTd);
      tr.appendChild(el('td', null, s.category));

      const act = el('td');
      const edit = el('button', 'small', 'Редактировать');
      edit.addEventListener('click', () => openSkillCard(s.id));
      const del = el('button', 'small danger', 'Удалить');
      del.addEventListener('click', async () => {
        if (!confirm(`Удалить навык «${s.skill}» из реестра? Он также будет удалён из карточек тестировщиков.`)) return;
        try {
          await api(`/api/skills/${s.id}`, { method: 'DELETE' });
          await loadData();
        } catch (e) { toast(e.message, 'error'); }
      });
      act.appendChild(edit);
      act.appendChild(del);
      tr.appendChild(act);
      tbody.appendChild(tr);
    });
  }

  function openSkillCard(id) {
    const editing = id != null;
    const src = editing ? registryById(id) : null;

    const modal = el('div', 'modal');
    const header = el('div', 'modal-header');
    header.appendChild(el('h2', null, editing ? 'Редактировать навык' : 'Новый навык'));
    modal.appendChild(header);

    const body = el('div', 'modal-body');
    const msg = el('div', 'form-msg');

    const fieldWrap = (labelText, input) => {
      const f = el('div', 'field');
      f.appendChild(el('label', null, labelText));
      f.appendChild(input);
      return f;
    };

    const nameInput = el('input');
    nameInput.value = editing ? src.skill : '';

    const catSel = el('select');
    state.data.categories.forEach((c) => catSel.appendChild(new Option(c.name, c.name)));
    if (editing) catSel.value = src.category;
    else if (state.data.categories[0]) catSel.value = state.data.categories[0].name;

    // inline add category
    const catAdd = el('div', 'cat-inline');
    const catInput = el('input');
    catInput.placeholder = 'Новая категория...';
    const catBtn = el('button', 'small primary', '＋');
    catBtn.addEventListener('click', async () => {
      const name = catInput.value.trim();
      if (!name) return;
      try {
        const c = await api('/api/categories', { method: 'POST', body: { name } });
        catInput.value = '';
        await loadData();
        renderRegistryFilters();
        catSel.appendChild(new Option(c.name, c.name));
        catSel.value = c.name;
      } catch (e) { toast(e.message, 'error'); }
    });
    catAdd.appendChild(catInput);
    catAdd.appendChild(catBtn);

    const catField = el('div', 'field');
    catField.appendChild(el('label', null, 'Категория'));
    catField.appendChild(catSel);
    catField.appendChild(catAdd);

    const levelFields = {};
    const levelWrap = el('div', 'level-grid');
    ['1', '2', '3', '4'].forEach((lv) => {
      const f = el('div', 'field');
      f.appendChild(el('label', null, `Уровень ${lv}`));
      const ta = el('textarea');
      ta.rows = 3;
      ta.value = (editing && src.levels[lv]) || '';
      levelFields[lv] = ta;
      f.appendChild(ta);
      levelWrap.appendChild(f);
    });

    body.appendChild(fieldWrap('Название навыка', nameInput));
    body.appendChild(catField);
    body.appendChild(levelWrap);
    body.appendChild(msg);
    modal.appendChild(body);

    const footer = el('div', 'modal-footer');
    const cancel = el('button', null, 'Отмена');
    cancel.addEventListener('click', closeModal);
    const submit = el('button', 'primary', 'Сохранить');
    submit.addEventListener('click', async () => {
      if (!nameInput.value.trim()) return fail('Укажите название навыка');
      const levels = {};
      let incomplete = false;
      ['1', '2', '3', '4'].forEach((lv) => {
        const v = levelFields[lv].value.trim();
        if (!v) incomplete = true;
        levels[lv] = v;
      });
      if (incomplete) return fail('Заполните описания всех уровней 1–4.');
      const payload = { skill: nameInput.value.trim(), category: catSel.value, levels };
      try {
        if (editing) await api(`/api/skills/${src.id}`, { method: 'PUT', body: payload });
        else await api('/api/skills', { method: 'POST', body: payload });
        closeModal();
        await loadData();
      } catch (e) { fail(e.message); }
    });
    function fail(m) { msg.textContent = m; msg.className = 'form-msg error'; }
    footer.appendChild(cancel);
    footer.appendChild(submit);
    modal.appendChild(footer);

    openModal(modal);
  }

  /* ---------------- assessment tab ---------------- */

  let asPendingFile = null;

  const escHtml = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const nameKey = (n) => String(n).trim().replace(/\s+/g, ' ').toLowerCase();
  const stampTime = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };
  const asFileBase = (n) => String(n).trim().replace(/[^\w\u0400-\u04FF-]+/g, '_').replace(/_+/g, '_');
  const asMismatch = (sk) => sk.leadLevel != null && Number(sk.leadLevel) !== Number(sk.selfLevel);

  function asAssessments(u) {
    return (state.data.assessments || []).filter((a) => {
      if (u.id != null && a.userId != null) return a.userId === u.id;
      return nameKey(a.name) === nameKey(u.name);
    });
  }

  function asLatest(u) {
    const list = asAssessments(u);
    if (!list.length) return null;
    return list.reduce((best, a) => {
      if (a.assessmentDate > best.assessmentDate) return a;
      if (a.assessmentDate === best.assessmentDate && a.id > best.id) return a;
      return best;
    });
  }

  function asAvg(a) {
    if (!a || !a.skills.length) return '—';
    const sum = a.skills.reduce((s, x) => s + Number(x.selfLevel), 0);
    return (sum / a.skills.length).toFixed(1);
  }

  function asInRange(dateStr, period) {
    if (period === 'all') return true;
    const now = new Date();
    const limit = new Date(now);
    if (period === 'month') limit.setMonth(limit.getMonth() - 1);
    else if (period === 'quarter') limit.setMonth(limit.getMonth() - 3);
    else limit.setFullYear(limit.getFullYear() - 1);
    const d = new Date(dateStr);
    return d >= limit && d <= now;
  }

  /* ---------- assessment history helpers ---------- */

  function asSortedSnapshots(u) {
    return asAssessments(u).slice().sort((a, b) =>
      a.assessmentDate < b.assessmentDate ? -1 : a.assessmentDate > b.assessmentDate ? 1 : a.id - b.id
    );
  }

  function skillInSnapshot(snapshot, skillId) {
    if (!snapshot) return null;
    return (snapshot.skills || []).find((sk) => Number(sk.skillId) === Number(skillId)) || null;
  }

  const fmtShort = (iso) => {
    const d = new Date(iso);
    return `${d.getDate()}.${d.getMonth() + 1}`;
  };
  const fmtLevel = (v) => (v == null ? '—' : String(v));
  const changeStr = (from, to) => {
    if (from == null && to == null) return null;
    if (from !== to) return `${fmtLevel(from)} → ${fmtLevel(to)}`;
    return null;
  };

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function renderAssessment() {
    const grade = $('#as-grade').value;
    const period = $('#as-period').value;
    const status = $('#as-status').value;
    const q = String($('#as-search').value || '').trim().toLowerCase();

    const rows = [];
    state.data.users.forEach((u) => {
      if (grade && u.grade !== grade) return;
      if (q && !u.name.toLowerCase().includes(q)) return;
      const latest = asLatest(u);
      if (period !== 'all' && !(latest && asInRange(latest.assessmentDate, period))) return;
      if (status === 'has' && !latest) return;
      if (status === 'none' && latest) return;
      rows.push({ u, latest });
    });

    const tbody = $('#as-rows');
    tbody.innerHTML = '';
    $('#as-empty').classList.toggle('hidden', rows.length > 0);

    rows.forEach(({ u, latest }) => {
      const tr = el('tr');

      const nameTd = el('td');
      nameTd.appendChild(el('b', null, u.name));
      tr.appendChild(nameTd);
      tr.appendChild(el('td', null, u.grade));
      tr.appendChild(el('td', null, latest ? fmtDate(latest.assessmentDate) : '—'));
      tr.appendChild(el('td', null, latest ? String(latest.skills.length) : '—'));
      tr.appendChild(el('td', null, latest ? asAvg(latest) : '—'));

      const stTd = el('td');
      stTd.appendChild(el('span', 'badge ' + (latest ? 'free' : 'partial'), latest ? 'есть оценка' : 'нет оценки'));
      tr.appendChild(stTd);

      const act = el('td');
      const view = el('button', 'small', 'Просмотр');
      view.addEventListener('click', () => openAssessmentCard(u));
      act.appendChild(view);
      if (latest) {
        const del = el('button', 'small danger', 'Удалить');
        del.addEventListener('click', async () => {
          if (!confirm(`Удалить запись оценки от ${fmtDate(latest.assessmentDate)}? Сотрудник останется в реестре.`)) return;
          try {
            await api(`/api/assessments/${latest.id}`, { method: 'DELETE' });
            await loadData();
          } catch (e) { toast(e.message, 'error'); }
        });
        act.appendChild(del);
      }
      tr.appendChild(act);
      tbody.appendChild(tr);
    });
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openAssessmentCard(u) {
    const latest = asLatest(u);
    const snapshots = asSortedSnapshots(u);
    if (!latest) return toast('У сотрудника нет оценки', 'error');

    const modal = el('div', 'modal');
    const header = el('div', 'modal-header');
    header.appendChild(el('h2', null, u.name));
    header.appendChild(el('div', 'meta', `Грейд: ${latest.grade} · Оценок: ${snapshots.length} · Последняя: ${fmtDate(latest.assessmentDate)}`));
    modal.appendChild(header);

    const tabs = el('div', 'card-sub-tabs');
    const tabDefs = [
      ['profile', 'Профиль'],
      ['compare', 'Сравнение'],
      ['history', 'История'],
      ['progress', 'Прогресс'],
    ];
    const tabBtns = {};
    let activeTab = 'profile';
    tabDefs.forEach(([key, label]) => {
      const b = el('button', 'card-sub-tab' + (key === 'profile' ? ' active' : ''), label);
      b.addEventListener('click', () => switchCardTab(key));
      tabs.appendChild(b);
      tabBtns[key] = b;
    });
    modal.appendChild(tabs);

    const body = el('div', 'modal-body card-body');
    let leadItems = [];
    let profileMsg = null;

    function renderProfile() {
      body.innerHTML = '';
      leadItems = [];
      const msg = el('div', 'form-msg');
      profileMsg = msg;
      latest.skills.forEach((sk, idx) => {
        const reg = registryById(sk.skillId);
        const cur = Number(sk.selfLevel);
        const mism = asMismatch(sk);

        const box = el('div', 'skill-card' + (mism ? ' mismatch' : ''));
        const head = el('div', 'skill-head');
        head.appendChild(el('b', null, sk.skill));
        if (mism) head.appendChild(el('span', 'badge partial', 'расхождение'));
        box.appendChild(head);

        const grid = el('div', 'skill-grid');
        const selfCell = el('div', 'cell');
        selfCell.appendChild(el('div', 'cell-label', 'Самооценка'));
        const selfSel = el('select'); selfSel.disabled = true;
        [1, 2, 3, 4].forEach((n) => selfSel.appendChild(new Option(String(n), String(n))));
        selfSel.value = String(cur);
        selfCell.appendChild(selfSel);
        grid.appendChild(selfCell);

        const leadCell = el('div', 'cell');
        leadCell.appendChild(el('div', 'cell-label', 'Оценка лида'));
        const leadSel = el('select');
        leadSel.appendChild(new Option('—', ''));
        [1, 2, 3, 4].forEach((n) => leadSel.appendChild(new Option(String(n), String(n))));
        leadSel.value = sk.leadLevel == null ? '' : String(sk.leadLevel);
        leadCell.appendChild(leadSel);
        grid.appendChild(leadCell);
        box.appendChild(grid);

        const cmt = el('div', 'skill-cmt');
        const sc = el('div', 'field');
        sc.appendChild(el('label', null, 'Комментарий сотрудника'));
        const scTa = el('textarea'); scTa.rows = 2; scTa.disabled = true; scTa.value = sk.selfComment || '';
        sc.appendChild(scTa); cmt.appendChild(sc);
        const lc = el('div', 'field');
        lc.appendChild(el('label', null, 'Комментарий лида'));
        const lcTa = el('textarea'); lcTa.rows = 2; lcTa.value = sk.leadComment || '';
        lc.appendChild(lcTa); cmt.appendChild(lc);
        box.appendChild(cmt);

        if (reg) {
          const descs = el('div', 'skill-desc');
          descs.appendChild(el('div', 'small-title', `Уровень ${cur}:`));
          descs.appendChild(el('p', 'level-desc', reg.levels[cur] || 'Описание отсутствует.'));
          descs.appendChild(el('div', 'small-title', cur < 4 ? `Следующий (${cur + 1}):` : 'Достигнут максимум'));
          descs.appendChild(el('p', 'level-desc next', cur < 4 ? (reg.levels[cur + 1] || 'Описание отсутствует.') : 'Достигнут максимальный уровень (4).'));
          box.appendChild(descs);
        }

        leadItems.push({ idx, sel: leadSel, ta: lcTa, origLeadLevel: sk.leadLevel, origLeadComment: sk.leadComment || '' });
        body.appendChild(box);
      });
      body.appendChild(msg);
    }

    function renderActive() {
      body.innerHTML = '';
      if (activeTab === 'compare') buildCompareTab(body, snapshots);
      else if (activeTab === 'history') buildHistoryTab(body, snapshots);
      else if (activeTab === 'progress') buildProgressTab(body, snapshots);
      else renderProfile();
      saveBtn.classList.toggle('hidden', activeTab !== 'profile');
    }

    function switchCardTab(key) {
      activeTab = key;
      Object.keys(tabBtns).forEach((k) => tabBtns[k].classList.toggle('active', k === key));
      renderActive();
    }

    modal.appendChild(body);

    const footer = el('div', 'modal-footer');
    const cancel = el('button', null, 'Закрыть');
    cancel.addEventListener('click', closeModal);
    const expJson = el('button', 'ghost', 'Экспорт JSON');
    expJson.addEventListener('click', () => asExportCardJSON(u, latest));
    const expHtml = el('button', 'ghost', 'Экспорт HTML');
    expHtml.addEventListener('click', () => asExportCardHTML(u, latest));
    const saveBtn = el('button', 'primary', 'Сохранить изменения');
    saveBtn.addEventListener('click', async () => {
      try {
        let changed = false;
        for (const item of leadItems) {
          const leadLevel = item.sel.value === '' ? null : Number(item.sel.value);
          const leadComment = item.ta.value;
          if (leadLevel === item.origLeadLevel && leadComment === item.origLeadComment) continue;
          changed = true;
          await api(`/api/assessments/${latest.id}/skills/${item.idx}`, {
            method: 'PUT',
            body: { leadLevel, leadComment },
          });
        }
        toast(changed ? 'Изменения сохранены' : 'Изменений не было');
        closeModal();
        await loadData();
      } catch (e) {
        if (profileMsg) { profileMsg.textContent = e.message; profileMsg.className = 'form-msg error'; }
        else toast(e.message, 'error');
      }
    });
    footer.appendChild(cancel);
    footer.appendChild(expJson);
    footer.appendChild(expHtml);
    footer.appendChild(saveBtn);
    modal.appendChild(footer);

    renderProfile();
    openModal(modal);
  }

  /* ---------- assessment history sub-tabs ---------- */

  function buildCompareTab(body, snapshots) {
    body.appendChild(el('p', 'hint', 'Сравнение оценок за выбранный период: показываются все оценки в диапазоне дат, изменившееся — подсвечивается.'));
    if (snapshots.length < 2) {
      body.appendChild(el('div', 'empty', 'Нужно не менее двух оценок для сравнения.'));
      return;
    }
    const dates = snapshots.map((s) => s.assessmentDate).slice().sort();

    const wrap = el('div');
    const ctl = el('div', 'cmp-controls');
    ctl.appendChild(el('span', 'cmp-label', 'Период:'));
    const selFrom = dateInput(dates[0]);
    const selTo = dateInput(dates[dates.length - 1]);
    ctl.appendChild(el('span', 'cmp-and', 'с'));
    ctl.appendChild(selFrom);
    ctl.appendChild(el('span', 'cmp-and', 'по'));
    ctl.appendChild(selTo);
    wrap.appendChild(ctl);

    const tableWrap = el('div');
    wrap.appendChild(tableWrap);
    body.appendChild(wrap);

    function snapshotsInRange(from, to) {
      const [a, b] = [from, to].sort();
      return snapshots
        .filter((s) => s.assessmentDate >= a && s.assessmentDate <= b)
        .sort((x, y) => (x.assessmentDate < y.assessmentDate ? -1 : x.assessmentDate > y.assessmentDate ? 1 : x.id - y.id));
    }

    // Для каждой даты берём последний снимок (по id) — одна колонка на дату оценки.
    function distinctByDate(inRange) {
      const map = new Map();
      inRange.forEach((s) => {
        const ex = map.get(s.assessmentDate);
        if (!ex || s.id > ex.id) map.set(s.assessmentDate, s);
      });
      return Array.from(map.values()).sort((a, b) =>
        a.assessmentDate < b.assessmentDate ? -1 : a.assessmentDate > b.assessmentDate ? 1 : a.id - b.id);
    }

    function render() {
      tableWrap.innerHTML = '';
      const from = selFrom.value;
      const to = selTo.value;
      if (!from || !to) {
        tableWrap.appendChild(el('div', 'empty', 'Укажите диапазон дат.'));
        return;
      }
      const inRange = snapshotsInRange(from, to);
      if (!inRange.length) {
        tableWrap.appendChild(el('div', 'empty', 'Нет оценок за выбранный период.'));
        return;
      }
      const selSnaps = distinctByDate(inRange);

      const byId = new Map();
      selSnaps.forEach((snap) => (snap.skills || []).forEach((sk) => {
        if (!byId.has(sk.skillId)) {
          byId.set(sk.skillId, { id: sk.skillId, name: sk.skill, reg: registryById(sk.skillId) });
        }
      }));

      tableWrap.appendChild(el('div', 'meta', `Оценок в периоде: ${inRange.length} · даты: ${selSnaps.map((s) => fmtShort(s.assessmentDate)).join(', ')}`));

      const tbl = el('table', 'grid');
      const thead = el('thead');
      const hr = el('tr');
      hr.appendChild(el('th', null, 'Навык'));
      selSnaps.forEach((s) => hr.appendChild(el('th', null, `Уровень (самооценка/лид), ${fmtShort(s.assessmentDate)}`)));
      hr.appendChild(el('th', null, 'Изменение за период'));
      thead.appendChild(hr);
      tbl.appendChild(thead);
      const tbodyEl = el('tbody');

      byId.forEach((skill) => {
        const tr = el('tr');
        const nameTd = el('td');
        nameTd.appendChild(el('b', null, skill.name));
        tr.appendChild(nameTd);

        let prevSelf = null;
        let prevLead = null;
        let hadSelf = false;
        let hadLead = false;
        selSnaps.forEach((snap) => {
          const sk = skillInSnapshot(snap, skill.id);
          const self = sk ? sk.selfLevel : null;
          const lead = sk ? sk.leadLevel : null;
          const changed = (hadSelf && self != null && self !== prevSelf) || (hadLead && lead != null && lead !== prevLead);
          const cell = el('td', changed ? 'changed' : null);
          cell.appendChild(el('span', null, `${fmtLevel(self)}/${fmtLevel(lead)}`));
          tr.appendChild(cell);

          prevSelf = self;
          prevLead = lead;
          hadSelf = sk != null;
          hadLead = sk != null && lead != null;
        });

        const first = selSnaps[0];
        const last = selSnaps[selSnaps.length - 1];
        const s1 = skillInSnapshot(first, skill.id);
        const s2 = skillInSnapshot(last, skill.id);
        const selfCh = changeStr(s1 ? s1.selfLevel : null, s2 ? s2.selfLevel : null);
        const leadCh = changeStr(s1 ? s1.leadLevel : null, s2 ? s2.leadLevel : null);
        const chText = [selfCh && 'самооценка: ' + selfCh, leadCh && 'лид: ' + leadCh].filter(Boolean).join(' · ') || '—';
        const stTd = el('td');
        stTd.appendChild(el('span', 'badge ' + (selfCh || leadCh ? 'partial' : 'free'), selfCh || leadCh ? 'изменился' : 'без изменений'));
        stTd.appendChild(el('div', 'cmp-change-detail', chText));
        tr.appendChild(stTd);

        tbodyEl.appendChild(tr);
      });

      tbl.appendChild(tbodyEl);
      tableWrap.appendChild(tbl);
    }

    render();
    selFrom.addEventListener('change', render);
    selTo.addEventListener('change', render);
  }

  function buildHistoryTab(body, snapshots) {
    body.appendChild(el('p', 'hint', 'Все записи по сотруднику, сгруппированные по навыкам, в хронологии.'));
    if (snapshots.length === 0) {
      body.appendChild(el('div', 'empty', 'Нет ни одной оценки.'));
      return;
    }

    const byId = new Map();
    snapshots.forEach((s) => (s.skills || []).forEach((sk) => {
      if (!byId.has(sk.skillId)) {
        byId.set(sk.skillId, { id: sk.skillId, name: sk.skill, reg: registryById(sk.skillId), rows: [] });
      }
      byId.get(sk.skillId).rows.push({ date: s.assessmentDate, sk });
    }));

    const lastSnap = snapshots[snapshots.length - 1];
    const ordered = Array.from(byId.values())
      .map((g) => {
        const li = (lastSnap.skills || []).findIndex((sk) => Number(sk.skillId) === Number(g.id));
        return { g, li: li === -1 ? Infinity : li };
      })
      .sort((a, b) => a.li - b.li);

    ordered.forEach(({ g }) => {
      const box = el('div', 'skill-card hist-card');
      box.appendChild(el('div', 'skill-head', g.name));

      const tbl = el('table', 'grid');
      const thead = el('thead');
      const hr = el('tr');
      ['Дата', 'Самооценка', 'Оценка лида', 'Изменение', 'Комментарий сотрудника'].forEach((t) => hr.appendChild(el('th', null, t)));
      thead.appendChild(hr);
      tbl.appendChild(thead);
      const tbodyEl = el('tbody');

      let prevSelf = null;
      let prevLead = null;
      let hadSelf = false;
      let hadLead = false;
      g.rows.forEach(({ date, sk }) => {
        const selfCh = hadSelf ? changeStr(prevSelf, sk.selfLevel) : null;
        const leadCh = hadLead ? changeStr(prevLead, sk.leadLevel) : null;
        const chText = [selfCh, leadCh].filter(Boolean).join(' · ') || '—';

        const tr = el('tr');
        tr.appendChild(el('td', null, fmtDate(date)));
        tr.appendChild(el('td', null, fmtLevel(sk.selfLevel)));
        tr.appendChild(el('td', null, fmtLevel(sk.leadLevel)));
        tr.appendChild(el('td', null, chText));
        tr.appendChild(el('td', null, sk.selfComment || ''));
        tbodyEl.appendChild(tr);

        prevSelf = sk.selfLevel;
        prevLead = sk.leadLevel;
        hadSelf = sk.selfLevel != null;
        hadLead = sk.leadLevel != null;
      });

      tbl.appendChild(tbodyEl);
      box.appendChild(tbl);
      body.appendChild(box);
    });
  }

  function buildProgressTab(body, snapshots) {
    body.appendChild(el('p', 'hint', 'Изменение уровня по датам оценок: синяя линия — самооценка, жёлтая — оценка лида.'));
    if (snapshots.length === 0) {
      body.appendChild(el('div', 'empty', 'Нет ни одной оценки.'));
      return;
    }
    const skills = [];
    const seen = new Set();
    [...snapshots].reverse().forEach((s) => (s.skills || []).forEach((sk) => {
      if (!seen.has(sk.skillId)) {
        seen.add(sk.skillId);
        skills.push({ id: sk.skillId, name: sk.skill, reg: registryById(sk.skillId) });
      }
    }));
    if (skills.length === 0) {
      body.appendChild(el('div', 'empty', 'Нет навыков для отображения.'));
      return;
    }

    const ctl = el('div', 'cmp-controls');
    ctl.appendChild(el('span', 'cmp-label', 'Навык:'));
    const sel = el('select');
    skills.forEach((sk) => sel.appendChild(new Option(sk.name, String(sk.id))));
    ctl.appendChild(sel);
    body.appendChild(ctl);

    const legend = el('div', 'chart-legend');
    legend.appendChild(el('span', 'lg-self', '▪ Самооценка'));
    legend.appendChild(el('span', 'lg-lead', '▪ Оценка лида'));
    body.appendChild(legend);

    const chartWrap = el('div', 'progress-chart');
    body.appendChild(chartWrap);

    function draw() {
      chartWrap.innerHTML = '';
      renderChart(chartWrap, snapshots, Number(sel.value));
    }
    draw();
    sel.addEventListener('change', draw);
  }

  function renderChart(wrap, snapshots, skillId) {
    const W = 720;
    const H = 240;
    const PL = 32;
    const PR = 20;
    const PT = 16;
    const PB = 30;
    const n = snapshots.length;
    const plotW = W - PL - PR;
    const plotH = H - PT - PB;
    const x = (i) => (n === 1 ? PL + plotW / 2 : PL + (plotW * i) / (n - 1));
    const y = (lv) => PT + plotH - ((lv - 1) / 3) * plotH;

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'progress-svg' });

    for (let lv = 1; lv <= 4; lv += 1) {
      const gy = y(lv);
      svg.appendChild(svgEl('line', { x1: PL, y1: gy, x2: PL + plotW, y2: gy, class: 'chart-grid', stroke: '#e2e6ec' }));
      const lbl = svgEl('text', { x: PL - 6, y: gy + 4, class: 'chart-axis-lbl', 'text-anchor': 'end' });
      lbl.textContent = String(lv);
      svg.appendChild(lbl);
    }
    snapshots.forEach((s, i) => {
      const lbl = svgEl('text', { x: x(i), y: H - 8, class: 'chart-axis-x', 'text-anchor': 'middle' });
      lbl.textContent = fmtShort(s.assessmentDate);
      svg.appendChild(lbl);
    });

    drawSeries('#0052cc', (s) => { const sk = skillInSnapshot(s, skillId); return sk ? sk.selfLevel : null; });
    drawSeries('#e08e00', (s) => { const sk = skillInSnapshot(s, skillId); return sk ? sk.leadLevel : null; });

    wrap.appendChild(svg);

    function drawSeries(color, valueOf) {
      const segs = [];
      let cur = [];
      snapshots.forEach((s, i) => {
        const v = valueOf(s);
        if (v == null) {
          if (cur.length) { segs.push(cur); cur = []; }
          return;
        }
        cur.push({ x: x(i), y: y(v), v, i });
      });
      if (cur.length) segs.push(cur);

      segs.forEach((seg) => {
        const d = seg.map((p, k) => (k === 0 ? 'M' : 'L') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
        svg.appendChild(svgEl('path', { d, fill: 'none', class: 'chart-line', style: 'stroke:' + color }));
      });
      snapshots.forEach((s, i) => {
        const v = valueOf(s);
        if (v == null) return;
        svg.appendChild(svgEl('circle', { cx: x(i), cy: y(v), r: 4, fill: color, class: 'chart-dot' }));
        const lbl = svgEl('text', { x: x(i), y: y(v) - 6, class: 'chart-val', 'text-anchor': 'middle', style: 'fill:' + color });
        lbl.textContent = String(v);
        svg.appendChild(lbl);
      });
    }
  }

  function asCardPayload(u, latest) {
    return {
      employee: { name: u.name, grade: latest.grade, assessmentDate: latest.assessmentDate },
      skills: latest.skills.map((sk) => ({
        skill: sk.skill, level: sk.selfLevel, comment: sk.selfComment || '',
        leadLevel: sk.leadLevel, leadComment: sk.leadComment || '',
      })),
    };
  }

  function asExportCardJSON(u, latest) {
    const file = `assessment_${asFileBase(u.name)}_${latest.assessmentDate.replace(/-/g, '')}.json`;
    download(file, JSON.stringify(asCardPayload(u, latest), null, 2), 'application/json');
  }

  function asExportCardHTML(u, latest) {
    const rows = latest.skills.map((sk) => {
      const reg = registryById(sk.skillId);
      const cur = Number(sk.selfLevel);
      const next = cur < 4 ? (reg ? reg.levels[cur + 1] : '') : '—';
      const curDesc = reg ? reg.levels[cur] : '';
      const lead = sk.leadLevel == null ? '—' : String(sk.leadLevel);
      const mism = asMismatch(sk);
      return `<tr>
        <td><b>${escHtml(sk.skill)}</b><div class="desc">${escHtml(curDesc)}</div></td>
        <td class="c">${escHtml(cur)}</td>
        <td class="c ${mism ? 'diff' : ''}" title="${mism ? 'Расходится с самооценкой' : ''}">${escHtml(lead)}</td>
        <td>${escHtml(sk.selfComment || '')}</td>
        <td>${escHtml(sk.leadComment || '')}</td>
        <td class="next">${escHtml(next)}</td>
      </tr>`;
    }).join('');
    const css = `body{font-family:Segoe UI,Arial,sans-serif;margin:24px;color:#222}
h2{margin:0 0 4px} .meta{color:#666;margin-bottom:16px}
table{border-collapse:collapse;width:100%;margin-top:8px}
th,td{border:1px solid #d0d7de;padding:8px 10px;font-size:13px;vertical-align:top;text-align:left}
th{background:#f6f8fa}.c{text-align:center;width:60px}.next{color:#0a7}.desc{color:#666;margin-top:4px;font-size:12px}
td.diff{outline:2px solid #f5c518;outline-offset:-2px;background:#fff8e6}
.pill{display:inline-block;background:#d4a72c;color:#333;border-radius:10px;padding:1px 8px;font-size:12px;margin-bottom:8px}`;
    const html = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>Оценка — ${escHtml(u.name)}</title><style>${css}</style></head>
<body>
  <h2>${escHtml(u.name)}</h2>
  <div class="meta">Грейд: ${escHtml(latest.grade)} · Дата оценки: ${escHtml(latest.assessmentDate)}</div>
  <span class="pill">Средний уровень (самооценка): ${asAvg(latest)}</span>
  <table>
    <thead><tr><th>Навык</th><th>Самооценка</th><th>Оценка лида</th><th>Комментарий сотрудника</th><th>Комментарий лида</th><th>Следующий уровень</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body></html>`;
    const file = `assessment_${asFileBase(u.name)}_${latest.assessmentDate.replace(/-/g, '')}.html`;
    download(file, html, 'text/html;charset=utf-8');
  }

  function asExportAll() {
    const employees = state.data.users
      .map((u) => { const latest = asLatest(u); return latest ? asCardPayload(u, latest) : null; })
      .filter(Boolean);
    download(`assessments_export_${stampTime()}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), assessments: employees }, null, 2), 'application/json');
  }

  function asExportCsv() {
    const header = ['ФИО', 'Грейд', 'Дата оценки', 'Навык', 'Самооценка', 'Оценка лида', 'Расхождение', 'Комментарий сотрудника', 'Комментарий лида'];
    const esc = (v) => { v = String(v == null ? '' : v); if (/[";\r\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"'; return v; };
    const rows = [];
    state.data.users.forEach((u) => {
      const latest = asLatest(u);
      if (!latest) return;
      latest.skills.forEach((sk) => {
        const diff = sk.leadLevel == null ? '' : String(Number(sk.leadLevel) - Number(sk.selfLevel));
        rows.push([u.name, latest.grade, latest.assessmentDate, sk.skill, sk.selfLevel,
          sk.leadLevel == null ? '' : String(sk.leadLevel), diff, sk.selfComment || '', sk.leadComment || '']);
      });
    });
    const csv = '\uFEFF' + [header, ...rows.map((r) => r.map(esc).join(';'))].join('\r\n');
    download(`assessments_${stampTime()}.csv`, csv, 'text/csv;charset=utf-8');
  }

  function asResetImport() {
    asPendingFile = null;
    $('#as-file').value = '';
    $('#as-preview').innerHTML = '';
    $('#as-preview').classList.add('hidden');
    $('#as-import').classList.add('hidden');
    $('#as-cancel').classList.add('hidden');
  }

  async function onAsFileSelected() {
    const file = $('#as-file').files[0];
    if (!file) return asResetImport();
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (e) {
      toast('Не удалось прочитать JSON: ' + e.message, 'error');
      return asResetImport();
    }
    asPendingFile = parsed;
    const emp = parsed.employee || {};
    const skills = Array.isArray(parsed.skills) ? parsed.skills : [];
    const preview = $('#as-preview');
    preview.innerHTML = '';
    preview.appendChild(el('div', 'pv-line', 'ФИО: ' + (emp.name || '—')));
    preview.appendChild(el('div', 'pv-line', 'Грейд: ' + (emp.grade || '—')));
    preview.appendChild(el('div', 'pv-line', 'Дата оценки: ' + (emp.assessmentDate || '—')));
    preview.appendChild(el('div', 'pv-line', 'Навыков: ' + skills.length));
    preview.classList.remove('hidden');
    $('#as-import').classList.remove('hidden');
    $('#as-cancel').classList.remove('hidden');
  }

  async function importAssessment() {
    if (!asPendingFile) return;
    const btn = $('#as-import');
    btn.disabled = true;
    try {
      const a = await api('/api/assessments/import', { method: 'POST', body: asPendingFile });
      toast(`Оценка сотрудника ${a.name} успешно загружена`);
      asResetImport();
      await loadData();
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
    }
  }

  /* ---------------- jira integration ---------------- */

  let jiraConfig = { configured: false, url: null };
  let jiraIssues = [];
  let jiraSprints = {};
  let selectedJiraProjects = [];
  let selectedJiraAssignees = [];
  let jiraTblStatus = '';
  let jiraTblPriority = '';
  let jiraTblProject = '';

  function fmtSec(sec) {
    if (sec == null || sec === '') return '—';
    const t = Number(sec) || 0;
    const d = Math.floor(t / 86400);
    const h = Math.floor((t % 86400) / 3600);
    const m = Math.round((t % 3600) / 60);
    const parts = [];
    if (d) parts.push(d + 'д');
    if (h) parts.push(h + 'ч');
    if (m) parts.push(m + 'м');
    return parts.length ? parts.join(' ') : '0м';
  }

  function jiraStatus(msg, isError) {
    const box = $('#jira-status');
    box.textContent = msg;
    box.className = 'jira-status' + (isError ? ' error' : '') + (msg ? '' : ' hidden');
  }

  function projectKeyOfIssue(key) {
    return String(key || '').split('-')[0];
  }

  // ---------- checkbox dropdown (projects / assignees) ----------

  function renderDdList(listEl, items, isChecked, onToggle, emptyText, labelOf, fav) {
    listEl.innerHTML = '';
    if (!items.length && !(fav && fav.favs && fav.favs.length)) {
      listEl.appendChild(el('div', 'dd-empty', emptyText));
      return;
    }
    const renderRow = (it) => {
      const row = el('div', 'check-item' + (isChecked(it) ? ' selected' : ''));
      row.appendChild(el('span', null, labelOf(it)));
      if (isChecked(it)) row.appendChild(el('span', 'check-mark', '\u2713'));
      if (fav) {
        const faved = fav.favs.includes(fav.favKeyOf(it));
        const s = el('span', 'fav-star' + (faved ? ' active' : ''), faved ? '\u2605' : '\u2606');
        s.title = faved ? 'Убрать из избранного' : 'В избранное';
        s.addEventListener('click', (e) => {
          e.stopPropagation();
          fav.toggle(it);
          if (fav.render) fav.render(); else { fav.favs = fav.favs.slice(); renderDdList(listEl, items, isChecked, onToggle, emptyText, labelOf, fav); }
        });
        row.appendChild(s);
      }
      row.addEventListener('click', () => onToggle(it, !isChecked(it)));
      listEl.appendChild(row);
    };
    if (fav && fav.favs && fav.favs.length && fav.separate) {
      const pool = fav.fullItems || items;
      const favItems = pool.filter((it) => fav.favs.includes(fav.favKeyOf(it)));
      if (favItems.length) {
        listEl.appendChild(el('div', 'dd-grp-label', 'Избранное'));
        favItems.forEach(renderRow);
      }
      const rest = items.filter((it) => !fav.favs.includes(fav.favKeyOf(it)));
      if (rest.length) {
        listEl.appendChild(el('div', 'dd-grp-label', 'Все'));
        rest.forEach(renderRow);
      }
    } else if (fav && fav.favs && fav.favs.length && !fav.separate) {
      const pool = fav.fullItems || items;
      const sorted = pool.slice().sort((a, b) => (fav.favs.includes(fav.favKeyOf(b)) ? 1 : 0) - (fav.favs.includes(fav.favKeyOf(a)) ? 1 : 0));
      sorted.forEach(renderRow);
    } else {
      items.forEach(renderRow);
    }
  }

  function bindDdToggle(btnId, panelId) {
    const btn = $(btnId);
    const panel = $(panelId);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.dd-panel').forEach((p) => { if (p !== panel) p.classList.add('hidden'); });
      panel.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!panel.classList.contains('hidden') && !panel.contains(e.target) && !btn.contains(e.target)) panel.classList.add('hidden');
    });
  }

  // ---------- favourites (starred projects / assignees) ----------

  const FAV_PROJECTS_KEY = 'jukiria.fav.projects';
  const FAV_ASSIGNEES_KEY = 'jukiria.fav.assignees';
  let favProjects = loadFav(FAV_PROJECTS_KEY);      // array of project keys (lowercased)
  let favAssignees = loadFav(FAV_ASSIGNEES_KEY);    // array of stable assignee keys

  function loadFav(key) {
    try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }

  function saveFav(key, arr) {
    try { localStorage.setItem(key, JSON.stringify(arr)); } catch (e) { /* нет доступа к localStorage */ }
  }

  function projectFavKey(p) { return String(p && (p.key || p.name) || '').trim().toLowerCase(); }

  function assigneeFavKey(a) {
    return String(a && (a.accountId || a.email || a.key || a.name || a.displayName) || '').trim().toLowerCase();
  }

  function isFavProject(item) { return favProjects.includes(projectFavKey(item)); }
  function isFavAssignee(item) { return favAssignees.includes(assigneeFavKey(item)); }

  function toggleFavProject(item) {
    const k = projectFavKey(item);
    if (!k) return;
    favProjects = favProjects.includes(k) ? favProjects.filter((x) => x !== k) : favProjects.concat(k);
    saveFav(FAV_PROJECTS_KEY, favProjects);
  }

  function toggleFavAssignee(item) {
    const k = assigneeFavKey(item);
    if (!k) return;
    favAssignees = favAssignees.includes(k) ? favAssignees.filter((x) => x !== k) : favAssignees.concat(k);
    saveFav(FAV_ASSIGNEES_KEY, favAssignees);
  }

  // ---------- projects ----------

  let jiraProjectsCache = [];
  let jiraProjectSearch = '';

  function projectToggleLabel() {
    if (!selectedJiraProjects.length) return '— выберите проекты —';
    return selectedJiraProjects.length + ' · ' + selectedJiraProjects.map((p) => p.key).join(', ');
  }

  function refreshProjectToggle() {
    $('#jira-project-dd').textContent = projectToggleLabel();
    renderProjectChips();
  }

  function renderProjectChips() {
    const host = $('#jira-project-chips');
    host.innerHTML = '';
    selectedJiraProjects.forEach((p) => {
      const chip = el('span', 'dd-chip');
      chip.appendChild(el('span', null, p.key || p.name));
      const x = el('span', 'dd-chip-x', '×');
      x.title = 'Удалить';
      x.addEventListener('click', (e) => { e.stopPropagation(); onProjectToggle({ key: p.key, name: p.name }, false); });
      chip.appendChild(x);
      host.appendChild(chip);
    });
  }

  function renderProjectList() {
    const q = jiraProjectSearch.trim().toLowerCase();
    const items = q
      ? jiraProjectsCache.filter((p) => (p.key || '').toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q))
      : jiraProjectsCache;
    renderDdList($('#jira-project-list'), items,
      (it) => selectedJiraProjects.some((p) => p.key === it.key),
      onProjectToggle,
      'Проекты не загружены.',
      (it) => `${it.key} — ${it.name}`,
      {
        favs: favProjects,
        favKeyOf: projectFavKey,
        toggle: toggleFavProject,
        fullItems: jiraProjectsCache,
        separate: true,
        render: renderProjectList,
      });
  }

  async function loadJiraProjects() {
    try {
      jiraProjectsCache = (await api('/api/jira/projects')) || [];
    } catch (e) { jiraProjectsCache = []; }
    renderProjectList();
    refreshProjectToggle();
  }

  function onProjectToggle(it, checked) {
    if (checked) {
      if (!selectedJiraProjects.some((p) => p.key === it.key)) selectedJiraProjects.push({ key: it.key, name: it.name });
    } else {
      selectedJiraProjects = selectedJiraProjects.filter((p) => p.key !== it.key);
    }
    refreshProjectToggle();
    loadAssigneesForProjects();
    renderProjectList();
    if (jiraIssues.length) renderJira();
  }

  // ---------- assignees (scoped to selected projects) ----------

  let jiraAssigneePool = [];
  let jiraAssigneeSearch = '';

  function assigneeToggleLabel() {
    if (!selectedJiraAssignees.length) return '— выберите исполнителей —';
    return selectedJiraAssignees.length + ' · ' + selectedJiraAssignees.map((a) => a.displayName).join(', ');
  }

  function refreshAssigneeToggle() {
    $('#jira-assignee-dd').textContent = assigneeToggleLabel();
    renderAssigneeChips();
  }

  function renderAssigneeChips() {
    const host = $('#jira-assignee-chips');
    host.innerHTML = '';
    selectedJiraAssignees.forEach((a) => {
      const chip = el('span', 'dd-chip');
      chip.appendChild(el('span', null, a.displayName || a.name || a.key || '?'));
      const x = el('span', 'dd-chip-x', '×');
      x.title = 'Удалить';
      x.addEventListener('click', (e) => { e.stopPropagation(); onAssigneeToggle(a, false); });
      chip.appendChild(x);
      host.appendChild(chip);
    });
  }

  function renderAssigneeList() {
    const q = jiraAssigneeSearch.trim().toLowerCase();
    const items = q
      ? jiraAssigneePool.filter((it) => (it.displayName || '').toLowerCase().includes(q) || (it.email || '').toLowerCase().includes(q))
      : jiraAssigneePool;
    renderDdList($('#jira-assignee-list'), items,
      (it) => selectedJiraAssignees.some((x) => sameIdentity(x, it)),
      onAssigneeToggle,
      selectedJiraProjects.length ? 'Нет исполнителей для выбранных проектов.' : 'Сначала выберите проект, чтобы увидеть исполнителей.',
      (it) => it.displayName + (it.kind === 'portal' ? ' (портал)' : ''),
      {
        favs: favAssignees,
        favKeyOf: assigneeFavKey,
        toggle: toggleFavAssignee,
        fullItems: jiraAssigneePool,
        separate: true,
        render: renderAssigneeList,
      });
    refreshAssigneeToggle();
  }

  async function loadAssigneesForProjects() {
    const items = [];
    if (selectedJiraProjects.length) {
      try {
        const assignables = (await api('/api/jira/assignables', { method: 'POST', body: { projectKeys: selectedJiraProjects.map((p) => p.key) } })) || [];
        assignables.forEach((u) => items.push({ kind: 'jira', key: u.key, name: u.name, displayName: u.displayName, email: u.emailAddress || null, accountId: u.accountId || null }));
      } catch (e) { /* участники недоступны */ }
      state.data.users.forEach((u) => items.push({ kind: 'portal', key: null, name: u.name, displayName: u.name, email: u.email || null, accountId: null }));
    }
    const seen = new Set();
    const unique = [];
    items.forEach((it) => {
      const ekey = (it.email || '').toString().trim().toLowerCase();
      const nkey = (it.displayName || '').toString().trim().toLowerCase();
      if (ekey && seen.has('e:' + ekey)) return;
      if (ekey) seen.add('e:' + ekey);
      if (nkey && seen.has('n:' + nkey)) return;
      if (nkey) seen.add('n:' + nkey);
      unique.push(it);
    });
    unique.sort((a, b) => ((a.kind === 'portal' ? 0 : 1) - (b.kind === 'portal' ? 0 : 1)) || (a.displayName || '').localeCompare(b.displayName || '', 'ru'));
    selectedJiraAssignees.forEach((sel) => {
      if (!unique.some((it) => sameIdentity(it, sel))) unique.push(sel);
    });
    jiraAssigneePool = unique;
    renderAssigneeList();
  }

  function onAssigneeToggle(it, checked) {
    if (checked) {
      if (!selectedJiraAssignees.some((x) => sameIdentity(x, it))) selectedJiraAssignees.push(it);
    } else {
      selectedJiraAssignees = selectedJiraAssignees.filter((x) => !sameIdentity(x, it));
    }
    refreshAssigneeToggle();
    renderAssigneeList();
    if (jiraIssues.length) renderJira();
  }

  function assigneeJqlOperands() {
    return selectedJiraAssignees
      .filter((id) => id.name || id.key || id.accountId)
      .map((id) => `"${((id.name || id.key || id.accountId) + '').replace(/"/g, '\\"')}"`);
  }

  function sameIdentity(a, b) {
    if (a.email && b.email && String(a.email).trim().toLowerCase() === String(b.email).trim().toLowerCase()) return true;
    if (a.key && b.key && String(a.key) === String(b.key)) return true;
    if (a.accountId && b.accountId && String(a.accountId) === String(b.accountId)) return true;
    if (a.displayName && b.displayName && String(a.displayName).trim().toLowerCase() === String(b.displayName).trim().toLowerCase()) return true;
    return false;
  }

  function assigneeMatchesTask(id, assignee) {
    if (!assignee) return false;
    if (id.email && assignee.emailAddress) {
      if (String(id.email).trim().toLowerCase() === String(assignee.emailAddress).trim().toLowerCase()) return true;
    }
    if (id.name && (assignee.name || assignee.key)) {
      if (String(id.name).trim().toLowerCase() === String(assignee.name || assignee.key).trim().toLowerCase()) return true;
    }
    if (id.key && (assignee.key || assignee.name)) {
      if (String(id.key) === String(assignee.key || assignee.name)) return true;
    }
    if (id.accountId && assignee.accountId) {
      if (String(id.accountId) === String(assignee.accountId)) return true;
    }
    if (id.displayName && assignee.displayName) {
      const a = String(assignee.displayName).trim().toLowerCase().replace(/\s+/g, ' ');
      const d = String(id.displayName).trim().toLowerCase().replace(/\s+/g, ' ');
      if (a && a === d) return true;
    }
    return false;
  }

  function effectiveIssues() {
    if (!selectedJiraAssignees.length) return jiraIssues;
    return jiraIssues.filter((it) => selectedJiraAssignees.some((id) => assigneeMatchesTask(id, it.fields && it.fields.assignee)));
  }

  function isInCurrentSprint(it) {
    const activeSprint = jiraSprints[projectKeyOfIssue(it.key)];
    if (!activeSprint) return false;
    return (it._sprintNames || []).includes(activeSprint);
  }

  function sprintIssues() {
    return effectiveIssues().filter(isInCurrentSprint);
  }

  function isRequestedTask(it) {
    const t = it.fields && it.fields.issuetype ? it.fields.issuetype.name : '';
    const n = String(t).trim().toLowerCase();
    return ['задача', 'ошибка', 'подзадача', 'подзадача.', 'активность'].includes(n);
  }

  // Только задачи типа «Задача», находящиеся в актуальном (текущем) спринте.
  function taskIssues() {
    return sprintIssues().filter(isRequestedTask);
  }

  function displayIssues(list) {
    return list.filter((it) => {
      const f = it.fields || {};
      if (jiraTblProject && projectKeyOfIssue(it.key) !== jiraTblProject) return false;
      if (jiraTblStatus && (!f.status || f.status.name !== jiraTblStatus)) return false;
      if (jiraTblPriority && (!f.priority || f.priority.name !== jiraTblPriority)) return false;
      return true;
    });
  }

  function fillSelect(sel, values, current) {
    sel.innerHTML = '';
    sel.appendChild(new Option('Все', ''));
    values.forEach((v) => sel.appendChild(new Option(v, v)));
    sel.value = values.indexOf(current) >= 0 ? current : '';
  }

  function fillTableFilters() {
    const projects = [...new Set(jiraIssues.map((it) => projectKeyOfIssue(it.key)).filter(Boolean))].sort();
    const statuses = [...new Set(jiraIssues.map((it) => it.fields && it.fields.status && it.fields.status.name).filter(Boolean))].sort();
    const priorities = [...new Set(jiraIssues.map((it) => it.fields && it.fields.priority && it.fields.priority.name).filter(Boolean))].sort();
    fillSelect($('#jira-tbl-project'), projects, jiraTblProject);
    fillSelect($('#jira-tbl-status'), statuses, jiraTblStatus);
    fillSelect($('#jira-tbl-priority'), priorities, jiraTblPriority);
  }

  async function resolveSprints() {
    try {
      const keys = [...new Set(jiraIssues.map((it) => projectKeyOfIssue(it.key)).filter(Boolean))];
      if (!keys.length) return;
      const res = await api('/api/jira/active-sprints', { method: 'POST', body: { projectKeys: keys } });
      jiraSprints = res || {};
    } catch (e) { /* спринты опциональны */ }
  }

  async function renderJiraTab() {
    if (!jiraConfig.configured) {
      try { jiraConfig = await api('/api/jira/health'); } catch (e) { /* ignore */ }
    }
    loadJiraProjects();
    loadAssigneesForProjects();
    if (!jiraConfig.configured) {
      jiraStatus('Jira не настроена на сервере: укажите JIRA_URL и JIRA_PERSONAL_TOKEN.', true);
      return;
    }
    if (jiraIssues.length) renderJira();
  }

  async function loadJira() {
    jiraStatus('');
    const keys = selectedJiraProjects.map((p) => p.key);
    if (keys.length === 0) return jiraStatus('Выберите проект.', true);
    if (!jiraConfig.configured) {
      try { jiraConfig = await api('/api/jira/health'); } catch (e) { /* ignore */ }
    }
    if (!jiraConfig.configured) return jiraStatus('Jira не настроена.', true);
    const asgPart = selectedJiraAssignees.length ? ' AND assignee in (' + assigneeJqlOperands().join(', ') + ')' : '';
    const gathered = [];
    const seen = new Set();
    let totalIssues = 0;
    const PER_PROJECT = 400;
    const PAGE = 200;
    for (const key of keys) {
      try {
        let startAt = 0;
        for (let page = 0; page < 4; page++) {
          const query = `project = "${key}" AND sprint in openSprints() AND issuetype in ("Задача", "Ошибка", "Подзадача", 10605, "Активность")` + asgPart;
          const res = await api('/api/jira/search', { method: 'POST', body: { projectKey: '', jql: query, maxResults: PAGE, startAt } });
          totalIssues += Number(res.total) || 0;
          const arr = res.issues || [];
          arr.forEach((it) => {
            if (!seen.has(it.key)) { seen.add(it.key); gathered.push(it); }
          });
          if (arr.length < PAGE || gathered.length >= PER_PROJECT) break;
          startAt += arr.length;
        }
      } catch (e) { /* проект недоступен */ }
    }
    jiraIssues = gathered;
    jiraStatus('JQL: ' + partsLabel(keys) + asgPart + ' — только активный спринт — задач: ' + totalIssues);
    await resolveSprints();
    fillTableFilters();
    renderJira();
  }

  function partsLabel(keys) {
    return 'project in (' + keys.map((k) => `"${k}"`).join(', ') + ')';
  }

  function jiraMetrics(list) {
    const m = { total: list.length, done: 0, progress: 0, todo: 0, byStatus: {}, byAssignee: {}, aggSpent: 0, aggEst: 0 };
    list.forEach((it) => {
      const f = it.fields || {};
      const cat = f.status && f.status.statusCategory ? f.status.statusCategory.key : null;
      const stName = f.status && f.status.name ? f.status.name : '—';
      if (cat === 'done') m.done += 1;
      else if (String(stName).trim().toLowerCase() === 'тестирование') m.progress += 1;
      else m.todo += 1;
      m.byStatus[stName] = (m.byStatus[stName] || 0) + 1;
      const aName = f.assignee && f.assignee.displayName ? f.assignee.displayName : 'Не назначен';
      m.byAssignee[aName] = (m.byAssignee[aName] || 0) + 1;
      if (f.aggregatetimespent) m.aggSpent += Number(f.aggregatetimespent) || 0;
      if (f.aggregatetimeestimate) m.aggEst += Number(f.aggregatetimeestimate) || 0;
    });
    m.byStatus = Object.entries(m.byStatus).sort((a, b) => b[1] - a[1]);
    m.byAssignee = Object.entries(m.byAssignee).sort((a, b) => b[1] - a[1]);
    return m;
  }

  function jiraMetricCard(cls, value, label) {
    const c = el('div', 'jira-card ' + cls);
    c.appendChild(el('div', 'jira-card-val', String(value)));
    c.appendChild(el('div', 'jira-card-label', label));
    return c;
  }

  // Занятость исполнителя по выбранным проектам.
  // Текущая загрузка  = задачи в активных статусах («в работе») / Ёмкость × 100%
  // Прогнозная загрузка = («в работе» + «Сделать») / Ёмкость × 100%
  // Ёмкость задаётся вручную на вкладке и хранится в data.json (per assignee+project).
  const ACTIVE_STATUSES = ['тестирование', 'разработка', 'в работе'];
  const TODO_STATUSES = ['сделать'];

  function capacityKeyOf(id) {
    return String(id && (id.accountId || id.email || id.key || id.name || id.displayName || ''))
      .trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function capacityFor(id, projectKey) {
    const k = capacityKeyOf(id);
    const rec = (state.data.capacities || []).find((c) => c.assignee === k && c.projectKey === projectKey);
    return rec && Number.isFinite(rec.capacity) ? rec.capacity : null;
  }

  function statusLabelOf(it) {
    const st = it && it.fields && it.fields.status && it.fields.status.name;
    return String(st || '').trim().toLowerCase();
  }

  function assigneeProjectOccupancy(id) {
    const rows = [];
    selectedJiraProjects.forEach((p) => {
      const mine = jiraIssues.filter((it) =>
        projectKeyOfIssue(it.key) === p.key && assigneeMatchesTask(id, it.fields && it.fields.assignee)
      );
      if (!mine.length) return;
      let inWork = 0;
      let todo = 0;
      mine.forEach((it) => {
        const st = statusLabelOf(it);
        if (ACTIVE_STATUSES.indexOf(st) >= 0) inWork += 1;
        if (TODO_STATUSES.indexOf(st) >= 0) todo += 1;
      });
      const capacity = capacityFor(id, p.key);
      const current = capacity ? (inWork / capacity) * 100 : null;
      const forecast = capacity ? (todo / capacity) * 100 : null;
      rows.push({ key: p.key, name: p.name, capacity, inWork, todo, current, forecast });
    });
    return rows;
  }

  async function saveCapacity(id, projectKey, capacity) {
    const k = capacityKeyOf(id);
    try {
      await api('/api/jira/capacities', {
        method: 'PUT',
        body: { projectKey, assignee: k, capacity },
      });
      state.data.capacities = state.data.capacities || [];
      const rec = state.data.capacities.find((c) => c.assignee === k && c.projectKey === projectKey);
      if (rec) {
        rec.capacity = capacity;
      } else {
        const lastId = state.data.capacities.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0);
        state.data.capacities.push({ id: lastId + 1, assignee: k, projectKey: projectKey, capacity });
      }
      if (jiraIssues.length) renderJira();
    } catch (e) {
      toast('Не удалось сохранить ёмкость', 'error');
    }
  }

  function renderOccupancyBar(label, num, denom, percent) {
    const wrap = el('div', 'occupancy-load');
    const top = el('div', 'occupancy-load-top');
    top.appendChild(el('span', 'occupancy-load-label', label));
    const pctEl = el('span', 'occupancy-pct' + (percent > 100 ? ' over' : ''),
      percent == null ? '—' : (Math.round(percent * 10) / 10) + '%');
    top.appendChild(pctEl);
    wrap.appendChild(top);
    const barOuter = el('div', 'occupancy-bar');
    if (percent != null) {
      const fill = el('div', 'occupancy-fill' + (percent > 100 ? ' over' : ''));
      fill.style.width = Math.min(100, percent) + '%';
      barOuter.appendChild(fill);
    }
    wrap.appendChild(barOuter);
    if (num != null) wrap.appendChild(el('div', 'occupancy-sub', `${num} / ${denom}`));
    return wrap;
  }

  function renderAssigneeOccupancy(id) {
    const rows = assigneeProjectOccupancy(id);
    const box = el('div', 'occupancy-card');
    const nameRow = el('div', 'occupancy-name-row');
    nameRow.appendChild(el('div', 'jira-assignee-name', 'Загрузка по проектам'));
    const infoEl = el('span', 'occupancy-info', 'i');
    infoEl.setAttribute('data-tip',
      'Ёмкость — максимальное количество задач, которое исполнитель может выполнить за период (например, за спринт или неделю) без потери качества.\n\n' +
      'Текущая загрузка — показывает, чем исполнитель занят прямо сейчас.\n\n' +
      'Прогнозная загрузка — показывает, сколько задач ему предстоит выполнить.');
    nameRow.appendChild(infoEl);
    box.appendChild(nameRow);
    if (!rows.length) {
      box.appendChild(el('div', 'occupancy-empty', 'Нет задач по выбранным проектам.'));
      return box;
    }
    rows.forEach((r) => {
      const row = el('div', 'occupancy-row');
      const top = el('div', 'occupancy-top');
      top.appendChild(el('span', 'occupancy-project', r.name));

      const capWrap = el('div', 'occupancy-cap');
      capWrap.appendChild(el('span', 'occupancy-cap-label', 'Ёмкость'));
      const capInput = el('input', 'occupancy-cap-input');
      capInput.type = 'number';
      capInput.min = '0';
      capInput.placeholder = '—';
      capInput.value = r.capacity == null ? '' : String(r.capacity);
      capInput.addEventListener('change', () => {
        const v = Number(capInput.value);
        if (!Number.isFinite(v) || v < 0) return;
        saveCapacity(id, r.key, v);
      });
      capWrap.appendChild(capInput);
      top.appendChild(capWrap);
      row.appendChild(top);

      if (r.capacity == null || r.capacity <= 0) {
        row.appendChild(el('div', 'occupancy-empty', 'Укажите ёмкость, чтобы рассчитать загрузку.'));
      } else {
        row.appendChild(renderOccupancyBar('Текущая загрузка', r.inWork, r.capacity, r.current));
        row.appendChild(renderOccupancyBar('Прогнозная загрузка', r.todo, r.capacity, r.forecast));
      }
      box.appendChild(row);
    });
    return box;
  }

  function renderJiraWarning() {
    const host = $('#jira-warning');
    const list = taskIssues();
    const warnings = [];
    selectedJiraAssignees.forEach((id) => {
      const counts = {};
      list.forEach((it) => {
        const f = it.fields || {};
        if (!assigneeMatchesTask(id, f.assignee)) return;
        const cat = f.status && f.status.statusCategory ? f.status.statusCategory.key : null;
        if (cat === 'done') return;
        const st = (f.status && f.status.name) || '—';
        if (String(st).trim().toLowerCase() === 'сделать') return;
        counts[st] = (counts[st] || 0) + 1;
      });
      Object.entries(counts).forEach(([st, n]) => {
        if (n > 5) warnings.push({ name: id.displayName, st, n });
      });
    });
    if (warnings.length) {
      host.innerHTML = warnings.map((w) => `⚠ ${w.name}: ${w.n} задач в «${w.st}»`).join('<br>');
      host.classList.remove('hidden');
    } else {
      host.classList.add('hidden');
    }
  }

  function renderJira() {
    const eff = taskIssues();
    const host = $('#jira-metrics');
    host.innerHTML = '';
    host.classList.remove('hidden');

    if (!selectedJiraAssignees.length) {
      host.appendChild(el('div', 'jira-hint', 'Выберите исполнителей для статистики.'));
    } else {
      const m = jiraMetrics(eff);
      const byAssignee = el('div', 'jira-chips jira-by-exec');
      byAssignee.appendChild(el('div', 'jira-chips-title', 'По исполнителям'));
      m.byAssignee.slice(0, 20).forEach(([k, n]) => byAssignee.appendChild(el('span', 'chip', `${k}: ${n}`)));
      host.appendChild(byAssignee);

      const statusOrder = [...new Set(eff.map((it) => ((it.fields && it.fields.status && it.fields.status.name) || '—')))].sort((a, b) => a.localeCompare(b, 'ru'));

      selectedJiraAssignees.forEach((id) => {
        const mine = eff.filter((it) => assigneeMatchesTask(id, it.fields && it.fields.assignee));
        if (!mine.length) return;
        const bySt = {};
        mine.forEach((it) => {
          const st = (it.fields && it.fields.status && it.fields.status.name) || '—';
          bySt[st] = (bySt[st] || 0) + 1;
        });
        const card = el('div', 'jira-card jira-assignee-card');
        card.appendChild(el('div', 'jira-assignee-name', `${id.displayName} — всего ${mine.length}`));
        const ul = el('div', 'jira-assignee-statuses');
        statusOrder.forEach((st) => {
          const n = bySt[st] || 0;
          const line = el('div', 'jira-status-line');
          line.appendChild(el('span', null, `${st}: ${n}`));
          const norm = String(st).trim().toLowerCase();
          if (n > 5 && norm !== 'сделать' && norm !== 'закрыто') line.appendChild(el('span', 'jira-status-warn', '\u26A0'));
          ul.appendChild(line);
        });
        card.appendChild(ul);

        // Виджет загрузки по проектам под карточкой исполнителя
        card.appendChild(renderAssigneeOccupancy(id));

        host.appendChild(card);
      });
    }

    renderJiraWarning();

    const list = displayIssues(eff);
    const tbody = $('#jira-rows');
    tbody.innerHTML = '';
    list.forEach((it) => {
      const f = it.fields || {};
      const tr = el('tr');
      tr.addEventListener('click', () => openJiraIssue(it.key));

      const keyTd = el('td', 'nowrap');
      keyTd.appendChild(el('span', 'link', it.key));
      const statusName = (f.status && f.status.name) || '—';
      const stCls = (f.status && f.status.statusCategory && f.status.statusCategory.key === 'done') ? 'free'
        : (f.status && f.status.statusCategory && f.status.statusCategory.key === 'inprogress') ? 'partial' : 'gray';
      const statusTd = el('td');
      statusTd.appendChild(el('span', 'badge ' + stCls, statusName));

      tr.appendChild(el('td', 'proj-cell nowrap', projectKeyOfIssue(it.key)));
      tr.appendChild(keyTd);
      tr.appendChild(el('td', null, f.summary || '—'));
      tr.appendChild(statusTd);
      const assignee = f.assignee && f.assignee.displayName ? f.assignee.displayName : 'Не назначен';
      tr.appendChild(el('td', null, assignee));
      tr.appendChild(el('td', null, (f.priority && f.priority.name) || '—'));
      tr.appendChild(el('td', null, jiraSprints[projectKeyOfIssue(it.key)] || '—'));
      tr.appendChild(el('td', null, fmtDate(f.created)));
      tr.appendChild(el('td', null, fmtDate(f.updated)));
      tr.appendChild(el('td', null, f.duedate ? fmtDate(f.duedate) : '—'));
      tr.appendChild(el('td', null, fmtSec(f.aggregatetimeestimate)));
      tr.appendChild(el('td', null, fmtSec(f.aggregatetimespent)));
      tbody.appendChild(tr);
    });
    $('#jira-empty').classList.toggle('hidden', list.length > 0);
  }

  async function openJiraIssue(key) {
    if (!jiraConfig.configured) return;
    try {
      const it = await api('/api/jira/issue/' + encodeURIComponent(key));
      const f = it.fields || {};

      const modal = el('div', 'modal');
      const header = el('div', 'modal-header');
      header.appendChild(el('h2', null, `${it.key} — ${f.summary || ''}`));
      modal.appendChild(header);

      const body = el('div', 'modal-body');
      const meta = el('div');
      meta.appendChild(el('div', 'meta', `Статус: ${(f.status && f.status.name) || '—'}`));
      meta.appendChild(el('div', 'meta', `Исполнитель: ${(f.assignee && f.assignee.displayName) || 'Не назначен'}`));
      meta.appendChild(el('div', 'meta', `Докладчик: ${(f.reporter && f.reporter.displayName) || '—'}`));
      meta.appendChild(el('div', 'meta', `Приоритет: ${(f.priority && f.priority.name) || '—'}`));
      meta.appendChild(el('div', 'meta', `Дедлайн: ${f.duedate ? fmtDate(f.duedate) : '—'}`));
      meta.appendChild(el('div', 'meta', `Затрачено: ${fmtSec(f.aggregatetimespent)}`));
      body.appendChild(meta);

      if (f.description) {
        body.appendChild(el('div', 'section-title', 'Описание'));
        const p = el('p', 'jira-desc');
        p.textContent = f.description;
        body.appendChild(p);
      }

      if (f.comment && f.comment.comments && f.comment.comments.length) {
        body.appendChild(el('div', 'section-title', `Комментарии (${f.comment.comments.length})`));
        f.comment.comments.forEach((c) => {
          const cb = el('div', 'jira-comment');
          const who = (c.author && c.author.displayName) || '—';
          cb.appendChild(el('div', 'jira-comment-meta', `${who} · ${fmtDate(c.created)}`));
          const text = el('div', 'jira-comment-body');
          text.textContent = c.body || '';
          cb.appendChild(text);
          body.appendChild(cb);
        });
      }

      modal.appendChild(body);

      const footer = el('div', 'modal-footer');
      if (jiraConfig.url) {
        const link = el('a', 'button primary', 'Открыть в Jira');
        link.href = jiraConfig.url + '/browse/' + encodeURIComponent(it.key);
        link.target = '_blank';
        link.rel = 'noopener';
        footer.appendChild(link);
      }
      const close = el('button', null, 'Закрыть');
      close.addEventListener('click', closeModal);
      footer.appendChild(close);
      modal.appendChild(footer);

      openModal(modal);
    } catch (e) {
      toast('Ошибка загрузки задачи: ' + e.message, 'error');
    }
  }

  /* ---------------- filters binding ---------------- */

  function resetJira() {
    selectedJiraProjects = [];
    selectedJiraAssignees = [];
    jiraAssigneeSearch = '';
    jiraProjectSearch = '';
    jiraTblStatus = '';
    jiraTblPriority = '';
    jiraTblProject = '';
    jiraIssues = [];
    jiraSprints = {};
    jiraAssigneePool = [];
    $('#jira-project-search').value = '';
    $('#jira-assignee-search').value = '';
    $('#jira-project-dd').textContent = '— выберите проекты —';
    $('#jira-assignee-dd').textContent = '— выберите исполнителей —';
    $('#jira-project-chips').innerHTML = '';
    $('#jira-assignee-chips').innerHTML = '';
    renderProjectList();
    renderAssigneeList();
    fillTableFilters();
    $('#jira-status').classList.add('hidden');
    const metrics = $('#jira-metrics');
    metrics.classList.add('hidden');
    metrics.innerHTML = '';
    $('#jira-warning').classList.add('hidden');
    $('#jira-rows').innerHTML = '';
    const empty = $('#jira-empty');
    empty.classList.remove('hidden');
    empty.textContent = 'Задач не найдено. Измените выбор проекта или исполнителя.';
  }

  function bindFilters() {
    for (const sel of ['filter-grade', 'filter-project', 'filter-status', 'filter-from', 'filter-to']) {
      $(`#${sel}`).addEventListener('change', renderUsers);
    }
    $('#reset-filters').addEventListener('click', () => {
      $('#filter-grade').value = '';
      $('#filter-project').value = '';
      $('#filter-status').value = '';
      $('#filter-from').value = '';
      $('#filter-to').value = '';
      renderUsers();
    });
    for (const sel of ['req-filter-status', 'req-filter-project', 'req-filter-grade']) {
      $(`#${sel}`).addEventListener('change', renderRequests);
    }
    $('#reset-req-filters').addEventListener('click', () => {
      $('#req-filter-status').value = '';
      $('#req-filter-project').value = '';
      $('#req-filter-grade').value = '';
      renderRequests();
    });
    $('#add-request').addEventListener('click', openRequestForm);
    $('#req-add-request').addEventListener('click', openRequestForm);
    $('#add-tester').addEventListener('click', openTesterForm);
    $('#as-file').addEventListener('change', onAsFileSelected);
    $('#as-import').addEventListener('click', importAssessment);
    $('#as-cancel').addEventListener('click', asResetImport);
    for (const sel of ['as-grade', 'as-period', 'as-status']) $(`#${sel}`).addEventListener('change', renderAssessment);
    $('#as-search').addEventListener('input', renderAssessment);
    $('#reset-as-filters').addEventListener('click', () => {
      $('#as-grade').value = '';
      $('#as-period').value = 'all';
      $('#as-status').value = '';
      $('#as-search').value = '';
      renderAssessment();
    });
    $('#as-export-all').addEventListener('click', asExportAll);
    $('#as-export-csv').addEventListener('click', asExportCsv);
    $('#reg-search').addEventListener('input', renderRegistry);
    $('#reg-cat').addEventListener('change', renderRegistry);
    $('#reset-reg-filters').addEventListener('click', () => {
      $('#reg-search').value = '';
      $('#reg-cat').value = '';
      renderRegistry();
    });
    $('#reg-add').addEventListener('click', () => openSkillCard(null));
    $('#proj-search').addEventListener('input', renderProjects);
    for (const sel of ['proj-filter-name', 'proj-filter-abbr', 'proj-filter-contract']) {
      $(`#${sel}`).addEventListener('change', renderProjects);
    }
    $('#reset-proj-filters').addEventListener('click', () => {
      $('#proj-search').value = '';
      $('#proj-filter-name').value = '';
      $('#proj-filter-abbr').value = '';
      $('#proj-filter-contract').value = '';
      renderProjects();
    });
    $('#proj-add').addEventListener('click', () => openProjectCard(null));
    $('#mgr-search').addEventListener('input', renderManagers);
    $('#reset-mgr-filters').addEventListener('click', () => {
      $('#mgr-search').value = '';
      renderManagers();
    });
    $('#mgr-add').addEventListener('click', () => openManagerCard(null));
    $('#jira-load').addEventListener('click', loadJira);
    $('#jira-refresh').addEventListener('click', loadJira);
    $('#jira-reset').addEventListener('click', resetJira);
    bindDdToggle('#jira-project-dd', '#jira-project-panel');
    bindDdToggle('#jira-assignee-dd', '#jira-assignee-panel');
    $('#jira-project-search').addEventListener('input', (e) => { jiraProjectSearch = e.target.value; renderProjectList(); });
    $('#jira-assignee-search').addEventListener('input', (e) => { jiraAssigneeSearch = e.target.value; renderAssigneeList(); });
    $('#jira-tbl-project').addEventListener('change', (e) => { jiraTblProject = e.target.value; if (jiraIssues.length) renderJira(); });
    $('#jira-tbl-status').addEventListener('change', (e) => { jiraTblStatus = e.target.value; if (jiraIssues.length) renderJira(); });
    $('#jira-tbl-priority').addEventListener('change', (e) => { jiraTblPriority = e.target.value; if (jiraIssues.length) renderJira(); });
  }

  function openTesterForm() {
    const modal = el('div', 'modal');
    const header = el('div', 'modal-header');
    header.appendChild(el('h2', null, 'Новый тестировщик'));
    modal.appendChild(header);

    const body = el('div', 'modal-body');
    const msg = el('div', 'form-msg');
    const fieldWrap = (labelText, input) => {
      const f = el('div', 'field');
      f.appendChild(el('label', null, labelText));
      f.appendChild(input);
      return f;
    };
    const fail = (m) => { msg.textContent = m; msg.className = 'form-msg error'; };

    const emailInput = el('input'); emailInput.placeholder = 'email';
    const gradeSel = el('select');
    GRADES.forEach((g) => gradeSel.appendChild(new Option(g, g)));

    const outstaffField = el('div', 'field');
    const outstaffLabel = el('label', 'check-line');
    const outstaffCheck = el('input');
    outstaffCheck.type = 'checkbox';
    outstaffLabel.appendChild(outstaffCheck);
    outstaffLabel.appendChild(document.createTextNode('Outstaff'));
    outstaffField.appendChild(outstaffLabel);

    const fioWrap = el('div', 'searchable-select tester-search');
    const nameInput = el('input'); nameInput.placeholder = 'ФИО (поиск в Jira)'; nameInput.autocomplete = 'off';
    const panel = el('div', 'dd-panel hidden jira-user-panel');
    const list = el('div', 'dd-list');
    panel.appendChild(list);
    fioWrap.appendChild(nameInput);
    fioWrap.appendChild(panel);

    let pickedJira = null;
    let searchTimer = null;
    nameInput.addEventListener('input', () => {
      pickedJira = null;
      const q = nameInput.value.trim();
      clearTimeout(searchTimer);
      if (!q) { panel.classList.add('hidden'); list.innerHTML = ''; return; }
      searchTimer = setTimeout(async () => {
        const users = await searchJiraUsers(q);
        list.innerHTML = '';
        if (!users.length) {
          list.appendChild(el('div', 'dd-empty', 'В Jira не найдено — можно создать своего.'));
          panel.classList.remove('hidden');
          return;
        }
        users.forEach((u) => {
          const row = el('div', 'check-item');
          const label = u.displayName + (u.emailAddress ? ` · ${u.emailAddress}` : '');
          row.appendChild(el('span', null, label));
          row.addEventListener('click', () => {
            nameInput.value = u.displayName || u.name || '';
            emailInput.value = u.emailAddress || '';
            pickedJira = u;
            panel.classList.add('hidden');
          });
          list.appendChild(row);
        });
        panel.classList.remove('hidden');
      }, 250);
    });
    document.addEventListener('click', (e) => { if (!fioWrap.contains(e.target)) panel.classList.add('hidden'); });

    body.appendChild(fieldWrap('ФИО', fioWrap));
    body.appendChild(fieldWrap('Email', emailInput));
    body.appendChild(fieldWrap('Грейд', gradeSel));
    body.appendChild(outstaffField);
    body.appendChild(msg);
    modal.appendChild(body);

    const footer = el('div', 'modal-footer');
    const cancel = el('button', null, 'Отмена');
    cancel.addEventListener('click', closeModal);
    const submit = el('button', 'primary', 'Создать');
    submit.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) return fail('Укажите ФИО');
      const email = emailInput.value.trim();
      const dup = findPortalUser(name, email);
      if (dup) {
        toast('Уже есть в реестре — открываем карточку.');
        closeModal();
        openUserCard(dup.id);
        return;
      }
      try {
        const u = await api('/api/users', { method: 'POST', body: { name, grade: gradeSel.value, email, isOutstaff: outstaffCheck.checked } });
        closeModal();
        await loadData();
        openUserCard(u.id);
      } catch (e) { fail(e.message); }
    });
    footer.appendChild(cancel);
    footer.appendChild(submit);
    modal.appendChild(footer);

    openModal(modal);
  }

  /* ---------------- init ---------------- */

  (async function init() {
    bindTabs();
    bindProjectsTabs();
    bindFilters();
    await loadData();
  })();
})();