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
const lockPath = path.join(rootDir, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  // 锁文件里标记为 devOptional 的包（目前只有 typescript：既是 devDependency，又是 i18next 的
  // 可选 peer 依赖）在删掉 devDependencies 后仍会被 `npm install --omit=dev` 当作可选 peer 装进
  // 生产包（约 23 MB）。生产环境不需要它，从 dist 的锁文件里去掉，npm 便不会再安装缺失的可选 peer。
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (lock.packages) {
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (key && entry && entry.devOptional) delete lock.packages[key];
    }
  }
  fs.writeFileSync(path.join(distDir, 'package-lock.json'), `${JSON.stringify(lock, null, 3)}\n`, 'utf8');
}
