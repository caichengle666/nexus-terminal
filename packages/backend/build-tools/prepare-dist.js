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
const packageJsonPath = path.join(rootDir, 'package.json');
if (fs.existsSync(packageJsonPath)) {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  delete packageJson.devDependencies;
  fs.writeFileSync(
    path.join(distDir, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    'utf8'
  );
}
copyIfExists(path.join(rootDir, 'package-lock.json'), path.join(distDir, 'package-lock.json'));
