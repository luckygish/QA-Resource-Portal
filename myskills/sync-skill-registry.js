// Генерирует встроенную копию реестра навыков для MySkills из data.json основного портала.
// Запуск: node sync-skill-registry.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dataFile = path.join(root, 'data.json');
const outFile = path.join(__dirname, 'public', 'skills.js');

let data;
try {
  data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
} catch (e) {
  console.error('Не удалось прочитать ../data.json:', e.message);
  process.exit(1);
}

// исключаем временный/тестовый навык (например «Навык Короля ночи»)
const registry = (data.skillRegistry || []).filter((s) => !/корол[ья]\s*ночи/i.test(String(s.skill || '')));

const byCategory = {};
registry.forEach((s) => {
  const cat = (s.category && typeof s.category === 'string' && s.category.trim()) ? s.category.trim() : 'Прочее';
  if (!byCategory[cat]) byCategory[cat] = [];
  byCategory[cat].push({ id: s.id, name: s.skill, levels: s.levels });
});

const grouped = Object.keys(byCategory).map((cat) => ({ category: cat, skills: byCategory[cat] }));
const js = 'window.MYSKILLS_REGISTRY = ' + JSON.stringify(grouped, null, 2) + ';\n';
fs.writeFileSync(outFile, js, 'utf8');
console.log('Реестр записан: myskills/public/skills.js (' + registry.length + ' навыков, категорий: ' + grouped.length + ')');