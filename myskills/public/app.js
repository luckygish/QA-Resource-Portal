(function () {
  'use strict';

  var REGISTRY = window.MYSKILLS_REGISTRY || [];
  var state = { name: '', grade: 'Junior', answers: {}, allSkillNames: [] };

  var $ = function (sel) { return document.querySelector(sel); };
  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  function showScreen(id) {
    ['screen-welcome', 'screen-form', 'screen-result'].forEach(function (s) {
      $('#' + s).classList.toggle('hidden', s !== id);
    });
  }

  function skillLookup(name) {
    for (var i = 0; i < REGISTRY.length; i += 1) {
      for (var j = 0; j < REGISTRY[i].skills.length; j += 1) {
        if (REGISTRY[i].skills[j].name === name) return REGISTRY[i].skills[j];
      }
    }
    return null;
  }

  /* welcome */

  function startWelcome() {
    $('#welcome-msg').textContent = '';
    var name = $('#name').value.trim();
    var parts = name.split(/\s+/).filter(Boolean);
    var partOk = parts.every(function (p) { return /^[A-Za-zА-Яа-яЁё-]+$/.test(p); });
    if (!name) {
      $('#welcome-msg').textContent = 'Укажите ФИО, чтобы продолжить.';
      return;
    }
    if (parts.length !== 3 || !partOk) {
      $('#welcome-msg').textContent = 'Введите Фамилию, Имя и Отчество полностью (например, Иванов Иван Иванович).';
      return;
    }
    state.name = parts.join(' ');
    state.grade = $('#grade').value;
    state.answers = {};
    if (state.allSkillNames.length === 0) buildForm();
    renderForm();
    showScreen('screen-form');
  }

  /* form */

  function buildForm() {
    var container = $('#blocks');
    container.innerHTML = '';
    state.allSkillNames = [];
    REGISTRY.forEach(function (block) {
      var sec = el('div', 'block');
      sec.appendChild(el('div', 'block-title', block.category));
      block.skills.forEach(function (sk) {
        state.allSkillNames.push(sk.name);
        sec.appendChild(renderSkillCard(sk));
      });
      container.appendChild(sec);
    });
  }

  function renderSkillCard(sk) {
    var card = el('div', 'skill-card-form');
    card.appendChild(el('div', 'skill-name', sk.name));
    var opts = el('div', 'opts');
    var ans = state.answers[sk.name] || {};

    [1, 2, 3, 4].forEach(function (lv) {
      var row = el('label', 'opt' + (ans.level === lv ? ' selected' : ''));
      var radio = el('input');
      radio.type = 'radio';
      radio.name = 'lv_' + sk.id;
      radio.value = lv;
      if (ans.level === lv) radio.checked = true;
      row.appendChild(radio);
      row.appendChild(el('span', 'lv-num', 'Ур. ' + lv));
      row.appendChild(el('span', 'lv-desc', (sk.levels && sk.levels[String(lv)]) || ''));
      radio.addEventListener('change', function () {
        state.answers[sk.name] = { level: lv, comment: (state.answers[sk.name] && state.answers[sk.name].comment) || '' };
        opts.querySelectorAll('.opt').forEach(function (r, i) { r.classList.toggle('selected', i === lv - 1); });
      });
      opts.appendChild(row);
    });
    card.appendChild(opts);

    var ta = el('textarea');
    ta.rows = 2;
    ta.placeholder = 'Комментарий (необязательно): что хочешь прокачать или почему поставил этот уровень';
    ta.value = ans.comment || '';
    ta.addEventListener('input', function () {
      state.answers[sk.name] = { level: (state.answers[sk.name] && state.answers[sk.name].level) || 0, comment: ta.value };
    });
    card.appendChild(ta);
    return card;
  }

  function renderForm() {
    $('#whoami').textContent = state.name + ' (' + state.grade + ')';
    buildForm();
    $('#form-msg').textContent = '';
  }

  function saveAssessment() {
    var missing = state.allSkillNames.filter(function (name) {
      return !(state.answers[name] && state.answers[name].level >= 1);
    });
    if (missing.length) {
      $('#form-msg').textContent = 'Оцените уровни, которые ещё не заполнены: ' + missing.join(', ');
      return;
    }
    renderResult();
    showScreen('screen-result');
  }

  /* result */

  function renderResult() {
    var profile = $('#profile');
    profile.innerHTML = '';
    $('#result-msg').textContent = '';
    REGISTRY.forEach(function (block) {
      var secEl = el('div', 'profile-block');
      secEl.appendChild(el('div', 'profile-block-title', block.category));
      block.skills.forEach(function (sk) {
        var ans = state.answers[sk.name];
        if (!ans) return;
        var row = el('div', 'profile-skill');
        row.appendChild(el('span', null, sk.name));
        row.appendChild(el('span', 'lvl', 'Ур. ' + ans.level));
        row.addEventListener('click', function () { openLevelInfo(sk, ans.level); });
        secEl.appendChild(row);
      });
      profile.appendChild(secEl);
    });
  }

  function openLevelInfo(sk, level) {
    var modal = el('div', 'modal-mask');
    var box = el('div', 'modal');
    var header = el('div', 'modal-header');
    header.appendChild(el('h2', null, sk.name));
    box.appendChild(header);

    var body = el('div', 'modal-body');
    body.appendChild(el('div', 'level-title', 'Текущий уровень (' + level + ')'));
    body.appendChild(el('p', 'level-text', (sk.levels && sk.levels[String(level)]) || 'Описание отсутствует.'));
    if (level < 4) {
      body.appendChild(el('div', 'level-title dim', 'Следующий уровень (' + (level + 1) + ') — что нужно освоить'));
      body.appendChild(el('p', 'level-text', (sk.levels && sk.levels[String(level + 1)]) || 'Описание отсутствует.'));
    } else {
      body.appendChild(el('p', 'level-text', 'Достигнут максимальный уровень (4).'));
    }
    box.appendChild(body);

    var footer = el('div', 'modal-footer');
    var close = el('button', 'primary', 'Закрыть');
    close.addEventListener('click', function () { modal.remove(); });
    footer.appendChild(close);
    box.appendChild(footer);
    modal.appendChild(box);
    modal.addEventListener('click', function (e) { if (e.target === modal) modal.remove(); });
    $('#modal-root').appendChild(modal);
  }

  /* export */

  function pad(n) { return String(n).padStart(2, '0'); }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function fileBase(n) {
    return String(n).trim().replace(/[^\w\u0400-\u04FF-]+/g, '_').replace(/_+/g, '_');
  }

  function exportJson() {
    var skills = state.allSkillNames.map(function (name) {
      var ans = state.answers[name];
      return { skill: name, level: ans.level, comment: ans.comment || '' };
    });
    var out = {
      employee: { name: state.name, grade: state.grade, assessmentDate: today() },
      skills: skills
    };
    var blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = el('a');
    a.href = url;
    a.download = 'self-assessment_' + fileBase(state.name) + '_' + today().replace(/-/g, '') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* init */

  $('#start').addEventListener('click', startWelcome);
  $('#name').addEventListener('keydown', function (e) { if (e.key === 'Enter') startWelcome(); });
  $('#back').addEventListener('click', function () { showScreen('screen-welcome'); });
  $('#save').addEventListener('click', saveAssessment);
  $('#again').addEventListener('click', function () {
    state.answers = {};
    renderForm();
    showScreen('screen-form');
  });
  $('#download').addEventListener('click', exportJson);

  if (REGISTRY.length === 0) {
    $('#welcome-msg').textContent = 'Реестр навыков не загружен.';
  }
})();