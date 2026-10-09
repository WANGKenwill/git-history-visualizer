import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

try {
  const project = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
  if (!lock.packages) throw new Error('需要包含 packages 的 package-lock.json，请先运行 npm ci');
  const dependencies = Object.keys(project.dependencies || {}).map(name => {
    const path = `node_modules/${name}`;
    const entry = lock.packages[path];
    if (!entry?.version || entry.link) throw new Error(`${name} 缺少受支持的锁文件条目，请核查 package-lock.json`);
    const dir = resolve(root, path);
    const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
    if (pkg.version !== entry.version) throw new Error(`${pkg.name} 的安装版本与锁文件不一致，请先运行 npm ci`);
    if (typeof pkg.license !== 'string' || !pkg.license.trim()) throw new Error(`${pkg.name} 缺少许可证标识，需要人工核查`);
    const files = readdirSync(dir).filter(name => /^(licen[cs]e|notice)(\.(md|txt))?$|^ThirdPartyNotices\.txt$/i.test(name));
    if (!files.some(name => /^licen[cs]e/i.test(name))) throw new Error(`${pkg.name} 缺少许可证文本，需要人工核查`);
    files.sort();
    return { name: pkg.name, version: pkg.version, license: pkg.license, path,
      texts: files.map(name => ({ name, text: readFileSync(resolve(dir, name), 'utf8').trimEnd() })) };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const header = '# 第三方许可证\n\n由 `npm run licenses` 根据 package.json、锁文件及本地安装包生成，收录直接运行依赖的根目录 LICENSE、NOTICE 和 ThirdPartyNotices.txt 原文。\n本文件用于仅分发本工程源码的依赖说明，不是包含依赖的交付物许可清单。传递依赖及内嵌组件的完整声明随上游安装包提供，本文件不展开这些文本。\n项目自身的授权由根目录 LICENSE 决定；本文件不覆盖外部安装的 Git、Chromium 或 FFmpeg。\n';
  const sections = dependencies.map(pkg => `\n## ${pkg.name} ${pkg.version}\n\n许可证：${pkg.license}\n\n安装位置：\`${pkg.path}\`\n${pkg.texts.map(file => `\n### ${file.name}\n\n${file.text}\n`).join('')}`);
  writeFileSync(resolve(root, 'LICENSES_THIRD_PARTY.md'), header + sections.join(''));
  console.log(`已生成 LICENSES_THIRD_PARTY.md，包含 ${dependencies.length} 个直接运行依赖`);
} catch (error) {
  console.error(`生成第三方许可证失败：${error.message}`);
  process.exitCode = 1;
}
