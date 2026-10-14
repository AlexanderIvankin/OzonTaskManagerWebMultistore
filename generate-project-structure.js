#!/usr/bin/env node
/**
 * generate-project-structure.js
 *
 * Auto-generates PROJECT_STRUCTURE.md in the repository root.
 * Walks the tree, shows actual source/config files as a tree view,
 * lists empty directories and excluded directories.
 *
 * Usage:
 *   node generate-project-structure.js
 *   node generate-project-structure.js --root /path/to/repo
 *   node generate-project-structure.js --out custom.md
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------- CLI ----------
function parseArgs(argv) {
  const args = { root: __dirname, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' || a === '-r') args.root = argv[++i];
    else if (a === '--out' || a === '-o') args.out = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node generate-project-structure.js [--root DIR] [--out FILE]');
      process.exit(0);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(args.root);
const OUTPUT = args.out
  ? path.resolve(args.out)
  : path.join(ROOT, 'PROJECT_STRUCTURE.md');

// ---------- Config ----------

/**
 * Директории, которые пропускаем полностью — не заходим и не показываем.
 * Матч по basename (имени) на любой глубине.
 */
const EXCLUDED_DIRS = new Set([
  // Служебное
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  // Сборка и кэш
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  'tmp',
  'temp',
  // Проектное
  'ServerFiles',   // исключено по просьбе
  'backups',       // создаётся BackupService
  'outputs',       // создаётся сервисами экспорта
  'logs',
  'models-cache',  // кэш S3-моделей
  'uploads',       // временные загрузки multer
]);

/** Дот-директории, которые всё же интересно показать. */
const SHOW_DOT_DIRS = new Set(['.github', '.vscode', '.husky']);

/** Расширения, которые включаем в отчёт. */
const INCLUDE_EXT = new Set([
  '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx',
  '.http',
  '.sql',
  '.sh', '.ps1',
  '.md',
  '.json',
  '.yml', '.yaml',
]);

/** Файлы, которые пропускаем, даже если расширение подходит. */
const SKIP_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'PROJECT_STRUCTURE.md', // не показываем сам отчёт в отчёте
]);

/**
 * .env-файлы матчим по имени, т.к. у них часто нет «нормального» расширения:
 * .env, .env.store1, .env.example, .env.local, ...
 */
function isEnvFile(name) {
  if (name === '.env') return true;
  if (name.startsWith('.env.')) return true;  // .env.store1, .env.example
  if (name.endsWith('.env')) return true;     // (редкий) foo.env
  return false;
}

/** Включать ли файл в отчёт? */
function shouldIncludeFile(name) {
  if (SKIP_FILES.has(name)) return false;
  if (isEnvFile(name)) return true;
  // прочие скрытые файлы (кроме .env*) — не показываем (.gitignore и т.п.)
  if (name.startsWith('.')) return false;
  const ext = path.extname(name).toLowerCase();
  return INCLUDE_EXT.has(ext);
}

/** Пропускать ли директорию целиком? */
function shouldSkipDir(name) {
  if (EXCLUDED_DIRS.has(name)) return true;
  if (name.startsWith('.') && !SHOW_DOT_DIRS.has(name)) return true;
  return false;
}

// ---------- Walk ----------

/**
 * Рекурсивно строит дерево: { dirs: [{name, dirs, files}], files: [string] }.
 * Пустые (после фильтров) директории отсекаются.
 */
function collectTree(dirPath) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return { dirs: [], files: [] };
  }

  const dirs = [];
  const files = [];

  for (const e of entries) {
    if (e.isDirectory()) {
      if (shouldSkipDir(e.name)) continue;
      const sub = collectTree(path.join(dirPath, e.name));
      if (sub.dirs.length === 0 && sub.files.length === 0) continue;
      dirs.push({ name: e.name, ...sub });
    } else if (e.isFile()) {
      if (!shouldIncludeFile(e.name)) continue;
      files.push(e.name);
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.localeCompare(b));
  return { dirs, files };
}

/** Рендер дерева в массив строк с ASCII-разветвителями. */
function renderTree(node, prefix = '') {
  const lines = [];
  const total = node.dirs.length + node.files.length;
  let idx = 0;

  for (const d of node.dirs) {
    idx++;
    const isLast = idx === total;
    lines.push(prefix + (isLast ? '└── ' : '├── ') + d.name + '/');
    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    lines.push(...renderTree(d, childPrefix));
  }
  for (const f of node.files) {
    idx++;
    const isLast = idx === total;
    lines.push(prefix + (isLast ? '└── ' : '├── ') + f);
  }
  return lines;
}

/** Ищем реально пустые директории (0 элементов), исключая excluded. */
function findEmptyDirs(dirPath, relPath = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (shouldSkipDir(e.name)) continue;

    const subPath = path.join(dirPath, e.name);
    const subRel = relPath ? `${relPath}/${e.name}` : e.name;

    let subEntries = [];
    try { subEntries = fs.readdirSync(subPath); } catch { /* skip */ }

    if (subEntries.length === 0) {
      out.push(subRel + '/');
    } else {
      out.push(...findEmptyDirs(subPath, subRel));
    }
  }
  return out;
}

/** Считает файлы и директории в собранном дереве. */
function countTree(node) {
  let files = node.files.length;
  let dirs = node.dirs.length;
  for (const d of node.dirs) {
    const sub = countTree(d);
    files += sub.files;
    dirs += sub.dirs;
  }
  return { files, dirs };
}

// ---------- Main ----------

if (!fs.existsSync(ROOT)) {
  console.error(`Root not found: ${ROOT}`);
  process.exit(1);
}

const tree = collectTree(ROOT);
const emptyDirs = findEmptyDirs(ROOT);
const stats = countTree(tree);
const rootName = path.basename(ROOT);

const lines = [];
lines.push('# Project Structure');
lines.push('');
lines.push(`_Auto-generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC_`);
lines.push('');
lines.push(`**Root:** \`${rootName}\`  `);
lines.push(`**Files shown:** ${stats.files}  `);
lines.push(`**Directories shown:** ${stats.dirs}`);
lines.push('');
lines.push('## Tree');
lines.push('');
lines.push('```');
lines.push(`${rootName}/`);
lines.push(...renderTree(tree));
lines.push('```');

if (emptyDirs.length) {
  lines.push('');
  lines.push('## Empty directories');
  lines.push('');
  for (const d of emptyDirs) lines.push(`- \`${d}\``);
}

lines.push('');
lines.push('## Excluded directories');
lines.push('');
lines.push('_Пропущены намеренно (сборка, кэш, секреты, тяжёлые данные):_');
lines.push('');
for (const d of Array.from(EXCLUDED_DIRS).sort()) lines.push(`- \`${d}/\``);

lines.push('');
lines.push('## Included file extensions');
lines.push('');
const extList = Array.from(INCLUDE_EXT).sort().map((e) => `\`${e}\``).join(', ');
lines.push(`${extList}, а также любые \`.env*\` файлы`);

fs.writeFileSync(OUTPUT, lines.join('\n') + '\n', 'utf8');
console.log(`✅ Generated: ${OUTPUT}`);
console.log(`   Files: ${stats.files}, dirs: ${stats.dirs}, empty dirs: ${emptyDirs.length}`);