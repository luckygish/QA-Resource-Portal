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
    ['resources', 'requests', 'registry', 'projects'].forEach((id) => {
      $('#' + id).classList.toggle('hidden', id !== name);
    });
    if (name === 'registry') renderRegistry();
    if (name === 'projects') switchProjectsSub(projectsSub);
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
      const skillsText = u.skills.length
        ? u.skills.map((s) => `${skillName(s.skillId)} · у${s.level}`).join(', ')
        : '—';

      const nameTd = el('td');
      nameTd.appendChild(el('b', null, u.name));
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
    h.textContent = `${u.name} · ${u.grade}`;
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
    const af = el('select');
    af.appendChild(new Option('Выберите проект', ''));
    state.data.projects.forEach((p) => af.appendChild(new Option(p.name, String(p.id))));
    const as = dateInput(todayISO());
    const ae = dateInput(todayISO());
    const ap = el('input');
    ap.type = 'number'; ap.min = 1; ap.max = 100; ap.value = 50;
    const ab = el('button', 'small primary', 'Добавить');
    ab.addEventListener('click', async () => {
      if (!af.value) return toast('Выберите проект', 'error');
      const pct = validPercent(ap.value);
      if (pct == null) return toast('Занятость должна быть в диапазоне 1–100%', 'error');
      const candidate = { id: 0, projectId: Number(af.value), start: as.value, end: ae.value, percent: pct };
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

    const projectSel = el('select');
    projectSel.appendChild(new Option('Выберите проект', ''));
    state.data.projects.forEach((p) => projectSel.appendChild(new Option(p.name, String(p.id))));

    const gradeSel = el('select');
    GRADES.forEach((g) => gradeSel.appendChild(new Option(g, g)));

    const start = el('input'); start.type = 'date';
    const end = el('input'); end.type = 'date';
    const percent = el('input'); percent.type = 'number'; percent.min = 1; percent.max = 100; percent.value = 50;
    const comment = el('textarea'); comment.rows = 2; comment.placeholder = 'Обязательно';

    const managerSel = el('select');
    managerSel.appendChild(new Option('Выберите менеджера', ''));
    state.data.managers.forEach((m) => managerSel.appendChild(new Option(m.name, String(m.id))));
    // auto-substitute manager when a project with one is selected
    projectSel.addEventListener('change', () => {
      const proj = projectById(projectSel.value);
      if (proj && proj.managerId != null) managerSel.value = String(proj.managerId);
    });

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
      if (!projectSel.value) return fail('Выберите проект');
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
            projectId: Number(projectSel.value),
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

    const nameInput = el('input'); nameInput.value = editing ? src.name : '';
    const abbrInput = el('input'); abbrInput.value = editing ? (src.abbreviation || '') : '';

    const contractField = el('div', 'field');
    contractField.appendChild(el('label', null, 'Номер контракта'));
    const contractInput = el('input'); contractInput.value = editing ? (src.contractNumber || '') : '';
    contractField.appendChild(contractInput);

    const managerSel = el('select');
    managerSel.appendChild(new Option('Без менеджера', ''));
    state.data.managers.forEach((m) => managerSel.appendChild(new Option(m.name, String(m.id))));
    managerSel.value = editing && src.managerId != null ? String(src.managerId) : '';

    body.appendChild(fieldWrap('Название проекта', nameInput));
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
      const payload = {
        name: nameInput.value.trim(),
        abbreviation: abbrInput.value.trim(),
        contractNumber: contractInput.value.trim(),
        managerId: managerSel.value || null,
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

  /* ---------------- filters binding ---------------- */

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
    const nameInput = el('input'); nameInput.placeholder = 'ФИО';
    const emailInput = el('input'); emailInput.placeholder = 'email';
    const gradeSel = el('select');
    GRADES.forEach((g) => gradeSel.appendChild(new Option(g, g)));
    body.appendChild(fieldWrap('ФИО', nameInput));
    body.appendChild(fieldWrap('Email', emailInput));
    body.appendChild(fieldWrap('Грейд', gradeSel));
    body.appendChild(msg);
    modal.appendChild(body);

    const footer = el('div', 'modal-footer');
    const cancel = el('button', null, 'Отмена');
    cancel.addEventListener('click', closeModal);
    const submit = el('button', 'primary', 'Создать');
    submit.addEventListener('click', async () => {
      if (!nameInput.value.trim()) { msg.textContent = 'Укажите ФИО'; msg.className = 'form-msg error'; return; }
      try {
        const u = await api('/api/users', { method: 'POST', body: { name: nameInput.value.trim(), grade: gradeSel.value, email: emailInput.value.trim() } });
        closeModal();
        await loadData();
        openUserCard(u.id);
      } catch (e) { msg.textContent = e.message; msg.className = 'form-msg error'; }
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