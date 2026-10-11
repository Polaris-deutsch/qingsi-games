const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const targets = [
  'server.js',
  'android/main.js',
  'startup-port.js',
  'public-origin.js',
  'internet-security.js',
  'games',
  'bots',
  'public/js',
  'public/js/lang',
  'public/js/renderers',
  'scripts',
  'tests',
];

function collectJsFiles(target) {
  const fullPath = path.join(root, target);
  if (!fs.existsSync(fullPath)) return [];

  const stat = fs.statSync(fullPath);
  if (stat.isFile()) return fullPath.endsWith('.js') ? [fullPath] : [];

  return fs.readdirSync(fullPath, { withFileTypes: true })
    .flatMap((entry) => {
      const child = path.join(fullPath, entry.name);
      if (entry.isDirectory()) {
        return collectJsFiles(path.relative(root, child));
      }
      return entry.name.endsWith('.js') ? [child] : [];
    });
}

const files = [...new Set(targets.flatMap(collectJsFiles))]
  .filter((file) => path.basename(file) !== 'check-syntax.js')
  .sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
  });

  if (result.status !== 0) {
    console.error(`Syntax check failed: ${path.relative(root, file)}`);
    if (result.error) console.error(result.error.message);
    if (result.signal) console.error(`Checker terminated by ${result.signal}.`);
    process.stderr.write(result.stderr || result.stdout || '');
    process.exit(result.status || 1);
  }
}

console.log(`Checked ${files.length} JavaScript files.`);
