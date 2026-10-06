// Скрипт для ad-hoc подписи macOS-сборок JiraTime.
// Без подписи macOS (arm64 обязательно) прибьёт бинарник при запуске.
// Штатно запускается на macOS (`npm run build:macos`), где есть codesign.
// На Linux требует утилиту ldid. На Windows cделать подпись нельзя —
// выводится предупреждение и подписать нужно на Mac:
//   codesign --sign - JiraTime-mac-arm64
//   codesign --sign - JiraTime-mac-x64

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const files = ['../../JiraTime-mac-arm64', '../../JiraTime-mac-x64']
  .map((f) => path.join(__dirname, f));

function signWith(tool, args) {
  const r = spawnSync(tool, args, { stdio: 'inherit' });
  return r.status === 0;
}

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error('Не найден файл: ' + file);
    continue;
  }
  if (process.platform === 'darwin') {
    const ok = signWith('codesign', ['--sign', '-', file]);
    console.log(ok ? 'Подписано: ' + file : 'Не удалось подписать: ' + file);
  } else if (process.platform === 'linux' && spawnSync('which', ['ldid'], { stdio: 'ignore' }).status === 0) {
    const ok = signWith('ldid', ['-S', file]);
    console.log(ok ? 'Подписано (ldid): ' + file : 'Не удалось подписать: ' + file);
  } else {
    console.warn('Подпись невозможна на ' + process.platform
      + '. Перед запуском на Mac выполните: codesign --sign - ' + file);
  }
}