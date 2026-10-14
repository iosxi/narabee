/**
 * 動作テスト用のビルドを作る。
 *   node tools/make-test-build.js <出力先>
 *
 * 製品のコピーに tools/test-open.js を足しただけのもの。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dest = process.argv[2];
if (!dest) {
  console.error('usage: node tools/make-test-build.js <out-dir>');
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(path.join(root, 'src'), path.join(dest, 'src'), { recursive: true });
fs.copyFileSync(path.join(root, 'tools', 'test-open.js'), path.join(dest, 'src', 'test-open.js'));

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
manifest.background.scripts.push('src/test-open.js');
fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log('test build ->', dest);
