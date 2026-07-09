const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

function copyIfExists(from, to) {
  if (!fs.existsSync(from)) return;
  fs.cpSync(from, to, { recursive: true, force: true });
}

fs.mkdirSync(distDir, { recursive: true });
copyIfExists(path.join(rootDir, 'src', 'locales'), path.join(distDir, 'locales'));
copyIfExists(path.join(rootDir, 'html-presets'), path.join(distDir, 'html-presets'));
copyIfExists(path.join(rootDir, 'package.json'), path.join(distDir, 'package.json'));
copyIfExists(path.join(rootDir, 'package-lock.json'), path.join(distDir, 'package-lock.json'));
