#!/usr/bin/env node
/**
 * Скрипт релиза DSH-плагина (без зависимостей, Node >= 22)
 * ---------------------------------------------------------------------------
 * Цель: превратить «версионную дисциплину» в жёсткий гейт внутри скрипта, а не в то, что нужно помнить.
 *
 *   semver: проверка/шаг  →  git tag  →  npm publish --tag  →  синхронизация агрегаторов  →  запись CHANGELOG
 *
 * Железные правила (скрипт отказывается от невыполненных релизов):
 *   - patch — только исправления, breaking никогда
 *   - этап 0.x: breaking → minor (^0.2.0 == >=0.2.0 <0.3.0, не пересекает минор)
 *   - этап 1.x+: breaking → major
 *   - функции → minor; исправления → patch
 *
 * Использование (по умолчанию dry-run; в registry пишется только при явном --publish):
 *   node scripts/release.mjs --bump auto                 # репетиция
 *   node scripts/release.mjs --bump auto --publish       # настоящий релиз
 *   node scripts/release.mjs --version 0.3.0 --publish
 *   node scripts/release.mjs --pre rc --bump minor --publish   # выпустить 0.3.0-rc.1 (dist-tag next)
 *   node scripts/release.mjs --line 0.1 --bump patch --publish # обслуживаемая линия: dist-tag 0-1
 *   node scripts/release.mjs --deprecate 0.2.1 "серьёзный баг, обновитесь до 0.2.2"
 *   node scripts/release.mjs --check                     # только проверки (CI / перед релизом)
 *
 * Коды выхода: 0 успех / 1 провал (включая нарушения дисциплины и несостоявшиеся проверки)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// 0. Базовые вещи
// ---------------------------------------------------------------------------

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[2m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', b: '', d: '', x: '' };

const log = (...a) => process.stdout.write(a.join(' ') + '\n');
const info = (m) => log(`${C.b}▸${C.x} ${m}`);
const ok = (m) => log(`${C.g}✓${C.x} ${m}`);
const warn = (m) => log(`${C.y}!${C.x} ${m}`);
const bad = (m) => log(`${C.r}✗${C.x} ${m}`);
const dim = (m) => log(`${C.d}  ${m}${C.x}`);

class Abort extends Error {}
const die = (m) => {
  throw new Abort(m);
};

/** Выполнить команду; при throwOnFail=false возвращает {code, stdout, stderr}, не бросая. */
function sh(cmd, args, { cwd = process.cwd(), env = {}, throwOnFail = true, quiet = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) {
    if (throwOnFail) die(`Не удалось выполнить \`${cmd}\`: ${r.error.message}`);
    return { code: 127, stdout: '', stderr: r.error.message };
  }
  const out = { code: r.status ?? 1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
  if (out.code !== 0 && throwOnFail) die(`Сбой \`${cmd} ${args.join(' ')}\` (код выхода ${out.code})\n${out.stderr || out.stdout}`);
  return out;
}
const trySh = (cmd, args, opts) => sh(cmd, args, { ...opts, throwOnFail: false });

// ---------------------------------------------------------------------------
// 1. Минимальная реализация semver (без зависимостей)
// ---------------------------------------------------------------------------

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

function parseSemver(v) {
  const m = SEMVER_RE.exec(String(v || '').trim());
  if (!m) return null;
  return {
    raw: String(v).trim(),
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

const cmpPre = (a, b) => {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // официальная версия > предварительная
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
};

function compareSemver(a, b) {
  const A = parseSemver(a), B = parseSemver(b);
  if (!A || !B) die(`Нельзя сравнить неверные версии: ${a} / ${b}`);
  for (const k of ['major', 'minor', 'patch']) if (A[k] !== B[k]) return A[k] < B[k] ? -1 : 1;
  return cmpPre(A.prerelease, B.prerelease);
}

function incSemver(v, kind) {
  const p = parseSemver(v);
  if (!p) die(`Текущая версия некорректна: ${v}`);
  if (kind === 'major') return `${p.major + 1}.0.0`;
  if (kind === 'minor') return `${p.major}.${p.minor + 1}.0`;
  if (kind === 'patch') return `${p.major}.${p.minor}.${p.patch + 1}`;
  die(`Неизвестный тип bump: ${kind}`);
}

/** base вида 0.3.0; current вида 0.3.0-rc.2 → rc.3, иначе rc.1. */
const nextPreNumber = (current, base) => {
  const p = parseSemver(current);
  if (p && `${p.major}.${p.minor}.${p.patch}` === base && p.prerelease.length >= 2) {
    const n = Number(p.prerelease[p.prerelease.length - 1]);
    if (Number.isFinite(n)) return n + 1;
  }
  return 1;
};

// ---------------------------------------------------------------------------
// 2. Разбор аргументов
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = {
    bump: null, version: null, pre: null, tag: null, line: null,
    publish: false, check: false, yes: false, json: false,
    skipGit: false, skipNpm: false, skipAggregates: false, skipChangelog: false,
    deprecate: null, allowDirty: false, branch: null, remote: 'origin',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      const v = argv[++i];
      if (v === undefined) die(`У аргумента ${a} не указано значение`);
      return v;
    };
    switch (a) {
      case '--bump': o.bump = need(); break;
      case '--version': case '-v': o.version = need(); break;
      case '--pre': case '--prerelease': o.pre = need(); break;
      case '--tag': o.tag = need(); break;
      case '--line': o.line = need(); break;
      case '--publish': o.publish = true; break;
      case '--dry-run': o.publish = false; break;
      case '--check': case '--verify': o.check = true; break;
      case '--yes': case '-y': o.yes = true; break;
      case '--json': o.json = true; break;
      case '--skip-git': o.skipGit = true; break;
      case '--skip-npm': o.skipNpm = true; break;
      case '--skip-aggregates': o.skipAggregates = true; break;
      case '--skip-changelog': o.skipChangelog = true; break;
      case '--allow-dirty': o.allowDirty = true; break;
      case '--branch': o.branch = need(); break;
      case '--remote': o.remote = need(); break;
      case '--deprecate': {
        const v = need();
        const m = argv[++i];
        if (m === undefined) die('--deprecate требует два параметра: <версия> "<причина>"');
        o.deprecate = { version: v, message: m };
        break;
      }
      case '--help': case '-h': o.help = true; break;
      default:
        if (a.startsWith('--')) die(`Неизвестный аргумент: ${a} (см. --help)`);
    }
  }
  return o;
}

const HELP = `
Скрипт релиза DSH-плагина (по умолчанию dry-run; настоящий релиз — только с --publish)

  Версия
    --bump <auto|patch|minor|major>   шаг по коммитам (auto = читаем conventional commits)
    --version <x.y.z>                 задать версию-цель явно
    --pre <rc|beta|alpha>             предварительный релиз, напр. --pre rc → 0.2.1-rc.1 (dist-tag по умолчанию next)
    --line <x.y>                      релиз на обслуживаемой линии (напр. 0.1), dist-tag по умолчанию 0-1

  Теги
    --tag <name>                      npm dist-tag (по умолчанию: официальная → latest, предварительная → next)

  Действия
    --publish                         выполнить по-настоящему (по умолчанию только репетиция)
    --check                           только проверки перед релизом (для CI)
    --deprecate <ver> "<msg>"         отметить опубликованную версию как устаревшую (без нового релиза)
    --yes                             пропустить интерактивное подтверждение

  Пропуск
    --skip-git / --skip-npm / --skip-aggregates / --skip-changelog / --allow-dirty
    --branch <name>                   ветка релиза (по умолчанию текущая)
    --remote <name>                   git remote (по умолчанию origin)
    --json                            машинно-читаемый результат
`;

// ---------------------------------------------------------------------------
// 3. Контекст репозитория
// ---------------------------------------------------------------------------

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { die(`Не удалось разобрать ${p}: ${e.message}`); }
}

function loadContext(cwd) {
  const root = resolve(cwd);
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) die(`В текущем каталоге нет package.json: ${root}`);
  const pkg = readJson(pkgPath);

  const cfgPath = join(root, 'release.config.json');
  const cfg = existsSync(cfgPath) ? readJson(cfgPath) : {};

  const changelogPath = join(root, 'CHANGELOG.md');
  const gitReady = existsSync(join(root, '.git')) && trySh('git', ['rev-parse', '--git-dir'], { cwd: root }).code === 0;

  return { root, pkg, pkgPath, cfg, changelogPath, gitReady };
}

const git = (ctx, args, opts = {}) => trySh('git', args, { cwd: ctx.root, ...opts }).stdout;

// ---------------------------------------------------------------------------
// 4. Анализ коммитов и версионная дисциплина
// ---------------------------------------------------------------------------

/** Коммиты начиная с since (пустое since — вся история). */
function collectCommits(ctx, since) {
  const range = since ? `${since}..HEAD` : 'HEAD';
  const raw = git(ctx, ['log', range, '--no-merges', '--pretty=format:%s%x1f%b%x1e']);
  if (!raw) return [];
  return raw
    .split('\x1e')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((block) => {
      const [subject = '', body = ''] = block.split('\x1f');
      return { subject: subject.trim(), body: body.trim() };
    });
}

const HEADER_RE = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s*(?<desc>.+)$/i;

function classifyCommits(commits) {
  const breaking = [], feat = [], fix = [], other = [];
  for (const c of commits) {
    const m = HEADER_RE.exec(c.subject);
    const isBreaking = Boolean(m?.groups?.bang) || /^BREAKING[ -]CHANGE:/im.test(c.body);
    if (isBreaking) breaking.push(c);
    else if (m?.groups?.type?.toLowerCase() === 'feat') feat.push(c);
    else if (m?.groups?.type?.toLowerCase() === 'fix') fix.push(c);
    else other.push(c);
  }
  return { breaking, feat, fix, other };
}

/**
 * Версионная дисциплина: из «текущая версия + характер изменений» выводим **минимально допустимый** bump.
 *   breaking: 0.x → minor; >=1.x → major
 *   feat:     minor
 *   прочее:   patch
 */
function requiredBump(currentVersion, changes) {
  const cur = parseSemver(currentVersion);
  if (!cur) die(`version в package.json некорректна: ${currentVersion}`);
  if (changes.breaking.length > 0) return cur.major === 0 ? 'minor' : 'major';
  if (changes.feat.length > 0) return 'minor';
  return 'patch';
}

const RANK = { patch: 0, minor: 1, major: 2 };

/**
 * Проверка, что версия-цель удовлетворяет дисциплине:
 *  - уровень bump цели не ниже required (breaking на 0.x обязан идти через minor)
 *  - patch никогда не содержит breaking — единственный случай, который реально кусает пользователей ^x.y.z
 */
function assertDiscipline(currentVersion, targetVersion, changes) {
  const cur = parseSemver(currentVersion);
  const tgt = parseSemver(targetVersion);
  if (!cur || !tgt) die('Номер версии некорректен — нельзя проверить дисциплину');
  if (compareSemver(targetVersion, currentVersion) <= 0) die(`Версия-цель ${targetVersion} не больше текущей ${currentVersion}`);

  const req = requiredBump(currentVersion, changes);
  const curBase = `${cur.major}.${cur.minor}.${cur.patch}`;
  const tgtBase = `${tgt.major}.${tgt.minor}.${tgt.patch}`;

  // Предварительная версия: достаточно того же base либо шага по required
  if (tgt.prerelease.length > 0) {
    const sameBase = tgtBase === curBase;
    const bumped = { major: tgt.major > cur.major, minor: tgt.major === cur.major && tgt.minor > cur.minor, patch: tgtBase === incSemver(curBase, 'patch') };
    if (sameBase) {
      // Предварительная на том же base — это «репетиция patch-уровня следующей версии»; прятать туда breaking нельзя
      if (changes.breaking.length > 0) {
        die([
          `Нельзя прятать breaking-изменения в «предварительной на том же base» (${curBase} → ${targetVersion}).`,
          `На этапе 0.x breaking-изменения идут только через minor: начиная с ${incSemver(curBase, 'minor')}-${(tgt.prerelease[0] || 'rc')}.1.`,
        ].join('\n'));
      }
      return { required: req, level: 'patch' };
    }
    if (req === 'major' && !bumped.major) die(`Есть breaking-изменения — ${cur.major >= 1 ? 'нужен major' : 'нужен minor'}: версии-цели ${targetVersion} недостаточно`);
    if (req === 'minor' && !bumped.major && !bumped.minor) die(`Есть${changes.breaking.length ? ' breaking-изменения' : ' новые функции'} — нужен minor: версии-цели ${targetVersion} недостаточно`);
    return { required: req, level: bumped.major ? 'major' : bumped.minor ? 'minor' : 'patch' };
  }

  if (changes.breaking.length > 0) {
    if (cur.major === 0 && !(tgt.major === 0 && tgt.minor > cur.minor)) {
      die([
        `Breaking-изменения должны идти через minor (этап 0.x): сейчас ${currentVersion}.`,
        `  Причина: ^${cur.major}.${cur.minor}.${cur.patch} эквивалентно >=${cur.major}.${cur.minor}.${cur.patch} <${cur.major}.${cur.minor + 1}.0,`,
        `  не пересекает минор. Breaking в миноре — пользователи старого минора не обновятся автоматически.`,
        `  Рекомендуемая цель: ${incSemver(currentVersion, 'minor')}`,
      ].join('\n'));
    }
    if (cur.major >= 1 && tgt.major === cur.major) {
      die(`Breaking-изменения должны идти через major: сейчас ${currentVersion} → рекомендуется ${incSemver(currentVersion, 'major')} (цель ${targetVersion} всё ещё в пределах ${cur.major}.x)`);
    }
  }
  if (changes.feat.length > 0 && tgt.major === cur.major && tgt.minor === cur.minor) {
    die(`Есть новые функции — нужен minor: сейчас ${currentVersion} → рекомендуется ${incSemver(currentVersion, 'minor')} (цель ${targetVersion} — только patch)`);
  }

  const level = tgt.major > cur.major ? 'major' : tgt.minor > cur.minor ? 'minor' : 'patch';
  if (RANK[level] < RANK[req]) die(`Уровень версии-цели ${targetVersion} (${level}) ниже требуемого дисциплиной (${req})`);
  return { required: req, level };
}

// ---------------------------------------------------------------------------
// 5. Проверка перед релизом
// ---------------------------------------------------------------------------

function npmView(pkgName, field) {
  const r = trySh('npm', ['view', `${pkgName}@${field}`, '--json'], { quiet: true });
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return r.stdout || null; }
}

function checkCompatDeclarations(ctx) {
  const issues = [];
  const notes = [];
  const pkg = ctx.pkg;

  if (!pkg.dsh?.engines?.dsh) {
    issues.push('Не хватает `dsh.engines.dsh` (обычное объявление экосистемы; dshmarket фактически читает объединение peer — но должно быть и то, и другое)');
  } else {
    notes.push(`dsh.engines.dsh = ${pkg.dsh.engines.dsh}`);
  }

  const peers = Object.entries(pkg.peerDependencies || {}).filter(([n]) => n.startsWith('@deepseek-ai/dsh'));
  if (peers.length === 0) issues.push('Не хватает peerDependencies `@deepseek-ai/dsh*` (по ним рынок плагинов считает диапазон совместимости)');
  else notes.push(`Объявлений совместимости с peer: ${peers.length}: ${peers.map(([n, v]) => `${n}@${v}`).join(', ')}`);

  if (!pkg.engines?.node) issues.push('Не хватает `engines.node` (несовместимость версии Node должна падать при установке, а не молча ломаться)');

  const files = pkg.files || [];
  if (!files.includes('CHANGELOG.md')) issues.push('`files` не содержит CHANGELOG.md (история изменений не попадёт в tarball)');
  // Каталоги дистрибутива должны покрываться `files`. Классический расклад — `lib/`; у bundle-плагинов код может жить
  // в кастомных каталогах (у dsh-wechat-clawbot это dsh-wechat-bot/ + dsh-client-wechat-ui/, без lib/ вообще),
  // поэтому проверяем пути точек входа, реально объявленные в main / exports / dsh.bundle.patch, чтобы не давать
  // ложных срабатываний на легитимные расклады. 2026-09-17: при релизе dsh-wechat-clawbot наступили на это — сделали проверку адаптивной к раскладу.
  if (existsSync(join(ctx.root, 'lib'))) {
    if (!files.includes('lib')) issues.push('`files` не содержит lib');
  } else {
    const targets = new Set();
    if (typeof pkg.main === 'string') targets.add(pkg.main)
    for (const v of Object.values(pkg.exports || {})) {
      if (typeof v === 'string') targets.add(v)
      else if (v && typeof v === 'object') for (const vv of Object.values(v)) if (typeof vv === 'string') targets.add(vv)
    }
    if (pkg.dsh?.bundle?.patch) targets.add(pkg.dsh.bundle.patch)
    const uncovered = [...targets].filter((rel) => {
      const clean = String(rel).replace(/^\.\//, '')
      // package.json npm всегда кладёт в tarball независимо от files; README/LICENSE/CHANGELOG включаются автоматически так же.
      if (clean === 'package.json' || /^(README|LICENSE|CHANGELOG)(\.|$)/i.test(clean)) return false
      const top = clean.split('/')[0]
      return !files.some((f) => {
        const fc = String(f).replace(/^\.\//, '').replace(/\/$/, '')
        return fc === clean || fc === top || clean.startsWith(`${fc}/`)
      })
    })
    if (uncovered.length) issues.push(`\`files\` не покрывает объявленные пути точек входа: ${uncovered.join(', ')}`)
  }

  // name в cordis.patch.yml должен совпадать с именем пакета (при переименовании чаще всего забывают именно сюда)
  const patchRel = pkg.dsh?.bundle?.patch;
  if (patchRel) {
    const patchPath = join(ctx.root, patchRel);
    if (!existsSync(patchPath)) issues.push(`dsh.bundle.patch указывает на несуществующий файл: ${patchRel}`);
    else {
      const m = /^name:\s*(.+)$/m.exec(readFileSync(patchPath, 'utf8'));
      const declared = m?.[1]?.trim().replace(/^['"]|['"]$/g, '');
      if (declared && declared !== pkg.name) issues.push(`name в cordis.patch.yml (${declared}) ≠ name в package.json (${pkg.name})`);
      else if (declared) notes.push(`name cordis bundle совпадает: ${declared}`);
    }
  } else {
    issues.push('Не хватает `dsh.bundle.patch`');
  }

  if (!pkg.repository?.url) issues.push('Не хватает `repository.url`');
  return { issues, notes };
}

function checkChangelog(ctx) {
  const issues = [];
  if (!existsSync(ctx.changelogPath)) {
    issues.push('Нет CHANGELOG.md (у каждого breaking-релиза должны быть заметки о миграции)');
    return { issues, notes: [] };
  }
  const text = readFileSync(ctx.changelogPath, 'utf8');
  const notes = [];
  if (!/\[Unreleased\]/i.test(text)) issues.push('В CHANGELOG.md нет раздела `## [Unreleased]`');
  const cur = ctx.pkg.version;
  if (!text.includes(`[${cur}]`)) notes.push(`В CHANGELOG.md пока нет раздела [${cur}] (при релизе допишется автоматически)`);
  else notes.push(`Раздел [${cur}] в CHANGELOG.md уже есть`);
  return { issues, notes };
}

function runChecks(ctx, { strict = true, allowDirty = false } = {}) {
  info(`Проверка перед релизом: ${ctx.pkg.name}@${ctx.pkg.version} (${ctx.root})`);
  const issues = [];
  const notes = [];

  if (!ctx.gitReady) issues.push('Это не git-репозиторий (или git недоступен)');
  else {
    const dirty = git(ctx, ['status', '--porcelain']);
    if (dirty && !allowDirty) issues.push(`Рабочее дерево грязное (${dirty.split('\n').length} изменений) — сначала закоммитьте, потом релизьте`);
    else if (dirty) notes.push(`Рабочее дерево грязное (${dirty.split('\n').length} изменений) — --allow-dirty пропустил`);
    const branch = git(ctx, ['rev-parse', '--abbrev-ref', 'HEAD']);
    notes.push(`Ветка: ${branch}`);
  }

  const comp = checkCompatDeclarations(ctx);
  issues.push(...comp.issues);
  notes.push(...comp.notes);

  const cl = checkChangelog(ctx);
  issues.push(...cl.issues);
  notes.push(...cl.notes);

  // Расхождение имени каталога и имени пакета — историческая яма этих репозиториев; показываем явно
  const dirName = ctx.root.split('/').pop();
  if (dirName !== ctx.pkg.name) notes.push(`Внимание: имя каталога ${dirName} ≠ имя пакета ${ctx.pkg.name} (скрипт всегда опирается на package.json)`);

  for (const n of notes) dim(n);
  if (issues.length > 0) {
    for (const i of issues) bad(i);
    if (strict) die(`Не пройдено проверок: ${issues.length}`);
    return { ok: false, issues, notes };
  }
  ok('Все проверки прошли');
  return { ok: true, issues: [], notes };
}

// ---------------------------------------------------------------------------
// 6. Генерация CHANGELOG
// ---------------------------------------------------------------------------

const CHANGELOG_HEADER = (name) => `# Changelog

> Все изменения версий ${name}. Файл дополняется автоматически \`scripts/release.mjs\` при релизе.
> Формат — [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/), номера версий — [Semantic Versioning](https://semver.org/lang/zh-CN/).

`;

function categorize(changes) {
  const sec = [];
  if (changes.breaking.length) sec.push(['⚠️ Breaking-изменения (BREAKING)', changes.breaking]);
  if (changes.feat.length) sec.push(['Добавлено (Added)', changes.feat]);
  if (changes.fix.length) sec.push(['Исправлено (Fixed)', changes.fix]);
  if (changes.other.length) sec.push(['Прочее (Changed)', changes.other]);
  return sec;
}

function renderEntry(ctx, version, date, changes, extraNotes = []) {
  const pkg = ctx.pkg;
  const lines = [`## [${version}] - ${date}`, ''];
  for (const [title, items] of categorize(changes)) {
    lines.push(`### ${title}`, '');
    for (const c of items) lines.push(`- ${c.subject}`);
    lines.push('');
  }
  const dshRange = pkg.dsh?.engines?.dsh;
  lines.push('### Совместимость', '');
  if (dshRange) lines.push(`- DSH: \`${dshRange}\``);
  const nodeRange = pkg.engines?.node;
  if (nodeRange) lines.push(`- Node: \`${nodeRange}\``);
  const dshPeers = [...new Set(
    Object.entries(pkg.peerDependencies || {})
      .filter(([n]) => n.startsWith('@deepseek-ai/dsh'))
      .map(([, v]) => v),
  )];
  if (dshPeers.length) lines.push(`- DSH peer: ${dshPeers.join(' || ')}`);
  if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
    lines.push(`- Зависимости рантайма: ${Object.entries(pkg.dependencies).map(([n, v]) => `\`${n}@${v}\``).join(', ')}`);
  }
  for (const n of extraNotes) lines.push(`- ${n}`);
  lines.push('');
  if (changes.breaking.length) {
    lines.push('### Заметки о миграции', '');
    lines.push('> В breaking-версии здесь обязательно пишем, что должен поменять пользователь. После релиза дублируем в GitHub Release.', '');
    for (const c of changes.breaking) lines.push(`- ${c.subject}`);
    lines.push('');
  }
  return lines.join('\n');
}

function writeChangelog(ctx, version, changes, { dryRun }) {
  const text = existsSync(ctx.changelogPath)
    ? readFileSync(ctx.changelogPath, 'utf8')
    : CHANGELOG_HEADER(ctx.pkg.name);
  const date = new Date().toISOString().slice(0, 10);
  const entry = renderEntry(ctx, version, date, changes);

  if (text.includes(`## [${version}]`)) {
    warn(`В CHANGELOG.md уже есть раздел [${version}] — не записываем повторно`);
    return false;
  }
  let next;
  const anchor = /^##\s*\[Unreleased\][^\n]*\n/m.exec(text);
  if (anchor) {
    const at = anchor.index + anchor[0].length;
    next = text.slice(0, at) + '\n' + entry + text.slice(at);
  } else {
    // Вставить перед первым версионным разделом либо в конец файла
    const first = /^##\s*\[/m.exec(text);
    next = first ? text.slice(0, first.index) + entry + text.slice(first.index) : `${text.trimEnd()}\n\n${entry}`;
  }
  if (dryRun) {
    info('Раздел, который будет записан в CHANGELOG.md:');
    dim(entry.split('\n').slice(0, 12).join('\n  '));
    return true;
  }
  writeFileSync(ctx.changelogPath, next);
  ok(`В CHANGELOG.md записан раздел [${version}]`);
  return true;
}

// ---------------------------------------------------------------------------
// 7. Действия релиза
// ---------------------------------------------------------------------------

function npmAuthEnv() {
  // Приоритет учётных данных: токен из <DSH_HOME>/dsh-npm.json на этой машине (сам npm не залогинен).
  // DSH_HOME учитывает перенесённые launcher'ом / спасательной капсулой home-каталоги; ~/.dsh — только как запасной вариант.
  const dshHome = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh');
  const dshNpm = join(dshHome, 'dsh-npm.json');
  const env = {};
  const cleanups = [];
  if (existsSync(dshNpm)) {
    const cfg = readJson(dshNpm);
    if (cfg.token) {
      const dir = mkdtempSync(join(tmpdir(), 'dsh-rel-rc-'));
      const rc = join(dir, '.npmrc');
      writeFileSync(rc, `//registry.npmjs.org/:_authToken=${cfg.token}\n`, { mode: 0o600 });
      chmodSync(rc, 0o600);
      env.NPM_CONFIG_USERCONFIG = rc;
      env.NPM_CONFIG_CACHE = mkdtempSync(join(tmpdir(), 'dsh-rel-cache-'));
      cleanups.push(dir, env.NPM_CONFIG_CACHE);
      env.__usedToken = 'yes';
    }
  }
  return { env, cleanups };
}

function doPublish(ctx, version, tag, { dryRun, env }) {
  const args = ['publish', '--tag', tag, '--access', 'public'];
  if (dryRun) {
    // В dry-run нельзя реально звать `npm publish --dry-run`: package.json ещё не bumpнут,
    // и он полезет в registry со **старым номером версии** с ошибкой "cannot publish over previously published versions".
    // Вместо этого проверяем содержимое дистрибутива через `npm pack --dry-run` (без обращения к registry), а команду просто печатаем.
    info('npm pack --dry-run (проверка дистрибутива)');
    const pack = trySh('npm', ['pack', '--dry-run', '--json'], { cwd: ctx.root, quiet: true });
    if (pack.code === 0) {
      try {
        const j = JSON.parse(pack.stdout)[0];
        dim(`tarball: ${j.filename} · ${j.entryCount} files · ${(j.size / 1024).toFixed(1)} kB`);
        for (const f of j.files.map((f) => f.path)) dim(`  ${f}`);
      } catch { dim('(не удалось разобрать вывод pack)'); }
    } else {
      warn(`npm pack --dry-run упал: ${pack.stderr || pack.stdout}`);
    }
    info(`[dry-run] Будет выполнено: npm ${args.join(' ')}`);
    return { processing: false };
  }
  info(`npm ${args.join(' ')}`);
  const r = trySh('npm', args, { cwd: ctx.root, env, quiet: true });
  if (r.code !== 0) {
    bad(`npm publish упал (код выхода ${r.code})`);
    dim(r.stderr || r.stdout);
    die('npm publish упал');
  }
  // 202 = being processed: это не провал, но версия появится не сразу
  const processing = /202|being processed/i.test(r.stdout + r.stderr);
  if (processing) warn('registry вернул 202 "being processed": версия будет видна через 2–3 минуты — **не** торопитесь перепубликовать ту же версию (будет 409)');
  else ok(`npm publish завершён (tag=${tag})`);
  return { processing };
}

function doGit(ctx, version, { dryRun, branch, remote, tag }) {
  const tagName = `v${version}`;
  const b = branch || git(ctx, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';

  const existing = git(ctx, ['tag', '-l', tagName]);
  if (existing) die(`git-тег ${tagName} уже есть (перед повторным релизом убедитесь, что версия ещё не публиковалась)`);

  if (!dryRun) {
    git(ctx, ['add', '-A']);
    trySh('git', ['commit', '-m', `chore(release): ${version}`], { cwd: ctx.root });
    git(ctx, ['tag', '-a', tagName, '-m', `Release ${version}`]);
    ok(`Поставлен тег ${tagName}`);
    const push = trySh('git', ['push', remote, b, '--follow-tags'], { cwd: ctx.root, quiet: true });
    if (push.code !== 0) {
      warn(`git push упал: ${push.stderr}`);
      warn(`Можно позже вручную: git push ${remote} ${b} --follow-tags`);
    } else ok(`Вытолкнуто в ${remote}/${b} + тег ${tagName}`);
  } else {
    info(`[dry-run] Будет commit / тег ${tagName} / push ${remote} ${b} --follow-tags`);
  }
  return tagName;
}

function doAggregates(ctx, version, { dryRun }) {
  const aggs = ctx.cfg.aggregates || [];
  if (aggs.length === 0) {
    info('Синхронизация агрегатов не настроена (aggregates в release.config.json пуст)');
    return [];
  }
  const results = [];
  for (const a of aggs) {
    if (!a.command) {
      results.push({ name: a.name, status: 'skipped', note: a.note || 'ручная синхронизация не нужна' });
      dim(`${a.name}: пропуск (${a.note || 'автосканирование / ручная синхронизация не нужна'})`);
      continue;
    }
    const command = a.command.replaceAll('${VERSION}', version).replaceAll('${PKG}', ctx.pkg.name);
    if (dryRun) {
      results.push({ name: a.name, status: 'planned', command });
      info(`[dry-run] Синхронизация агрегата ${a.name}: ${command}`);
      continue;
    }
    const r = trySh('sh', ['-c', command], { cwd: ctx.root, quiet: true });
    results.push({ name: a.name, status: r.code === 0 ? 'ok' : 'failed', note: (r.stdout || r.stderr).slice(0, 400) });
    if (r.code === 0) ok(`Синхронизация агрегата ${a.name} завершена`);
    else warn(`Синхронизация агрегата ${a.name} упала (релиз не блокируется): ${(r.stderr || r.stdout).slice(0, 200)}`);
  }
  return results;
}

function doDeprecate(ctx, { version, message }, { dryRun }) {
  const { env, cleanups } = npmAuthEnv();
  try {
    if (!/^\d+\.\d+\.\d+/.test(version)) die(`Версия для --deprecate некорректна: ${version}`);
    const args = ['deprecate', `${ctx.pkg.name}@${version}`, message];
    info(`npm ${args.join(' ')}`);
    if (dryRun) { dim('[dry-run] Не выполняется'); return; }
    const r = trySh('npm', args, { cwd: ctx.root, env, quiet: true });
    if (r.code !== 0) die(`npm deprecate упал: ${r.stderr || r.stdout}`);
    ok(`${ctx.pkg.name}@${version} отмечен как устаревший (версия всё ещё устанавливается, но при установке будет видно предупреждение)`);
  } finally {
    for (const d of cleanups) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// 8. Основной поток
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const o = parseArgs(argv);
  if (o.help) { log(HELP); return 0; }

  const ctx = loadContext(process.cwd());

  if (o.deprecate) {
    doDeprecate(ctx, o.deprecate, { dryRun: !o.publish });
    return 0;
  }

  if (o.check) {
    const res = runChecks(ctx, { allowDirty: o.allowDirty });
    if (o.json) log(JSON.stringify({ ok: res.ok, issues: res.issues, notes: res.notes }, null, 2));
    return res.ok ? 0 : 1;
  }

  const current = ctx.pkg.version;
  if (!parseSemver(current)) die(`version в package.json некорректна: ${current}`);

  // Тег предыдущего релиза (для ограничения диапазона коммитов и расчёта шага)
  const lastTagRaw = git(ctx, ['describe', '--tags', '--abbrev=0', '--match', 'v*']);
  const lastTag = lastTagRaw || null;
  const commits = collectCommits(ctx, lastTag);
  const changes = classifyCommits(commits);

  info(`Текущая версия ${current}${lastTag ? ` (предыдущий тег ${lastTag})` : ' (исторических тегов нет — анализ по всей истории)'}`);
  dim(`С последнего релиза коммитов: ${commits.length} — breaking ${changes.breaking.length} / feat ${changes.feat.length} / fix ${changes.fix.length} / прочее ${changes.other.length}`);

  const req = requiredBump(current, changes);
  info(`Минимальный уровень по дисциплине: ${req}${changes.breaking.length ? ' (обнаружены breaking-изменения)' : ''}`);

  // Определяем версию-цель
  let target = o.version;
  if (!target) {
    const bump = o.bump || 'auto';
    let kind;
    if (bump === 'auto') kind = req;
    else if (['patch', 'minor', 'major'].includes(bump)) {
      if (RANK[bump] < RANK[req]) {
        die([
          `--bump ${bump} нарушает версионную дисциплину: обнаружены${changes.breaking.length ? ' breaking-изменения' : changes.feat.length ? ' новые функции' : ''}, минимум — ${req}.`,
          changes.breaking.length
            ? `  Железное правило: в patch только исправления, никогда breaking (иначе все пользователи ^${current} автоматически поднимутся на сломанную версию).`
            : '',
        ].filter(Boolean).join('\n'));
      }
      kind = bump;
    } else die(`--bump принимает только auto|patch|minor|major, получено: ${bump}`);
    target = incSemver(current, kind);
  }

  if (o.pre) {
    const base = target.split('-')[0];                 // 0.3.0
    if (!/^(rc|beta|alpha|next)$/i.test(o.pre)) {
      // Допускаются собственные идентификаторы предварительных версий: --pre canary.1
      target = `${base}-${o.pre}`;
    } else {
      const label = o.pre.toLowerCase() === 'next' ? 'rc' : o.pre.toLowerCase();
      target = `${base}-${label}.${nextPreNumber(current, base)}`;
    }
  }

  // Проверка дисциплины (включая запрет breaking в patch)
  const discipline = assertDiscipline(current, target, changes);
  ok(`Шаг версии соответствует дисциплине: ${current} → ${target} (уровень ${discipline.level}, требование дисциплины ${discipline.required})`);

  // Разметка dist-tag
  const isPre = parseSemver(target).prerelease.length > 0;
  let tag = o.tag;
  if (!tag) {
    if (o.line) tag = o.line.replace(/\./g, '-');        // 0.1 → 0-1 (обслуживаемая линия)
    else if (isPre) tag = 'next';                        // rc/beta → next
    else tag = 'latest';                                 // стабильная линия → latest
  }
  info(`dist-tag: ${tag}${o.line ? ` (линия обслуживания ${o.line})` : ''}`);

  // Версия-цель не должна уже существовать
  if (!o.skipNpm) {
    const exists = trySh('npm', ['view', `${ctx.pkg.name}@${target}`, 'version'], { quiet: true });
    if (exists.code === 0 && exists.stdout) die(`${ctx.pkg.name}@${target} уже есть в registry — повторная публикация невозможна (перезаписать можно только force, это рискованно; скрипт этого не предлагает)`);
    else ok(`${ctx.pkg.name}@${target} в registry пока нет`);
  }

  const dryRun = !o.publish;
  if (dryRun) {
    warn('DRY-RUN: не пишем в registry / не коммитим / не толкаем. Для настоящего релиза добавьте --publish.');
  } else if (!o.yes) {
    die('Настоящий релиз требует одновременно --publish и --yes (защита от случайного нажатия)');
  }

  runChecks(ctx, { strict: true, allowDirty: o.allowDirty });

  // 1) Пишем CHANGELOG (сначала — чтобы он попал в коммит)
  const extraNotes = o.line ? [`Релиз на обслуживаемой линии (release/${o.line}): только cherry-pick исправлений багов / безопасности`] : [];
  if (!o.skipChangelog) writeChangelog(ctx, target, changes, { dryRun });

  // 2) bump package.json version
  if (!dryRun) {
    const pkgRaw = readFileSync(ctx.pkgPath, 'utf8');
    const bumped = pkgRaw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${target}$2`);
    writeFileSync(ctx.pkgPath, bumped);
    ok(`package.json version → ${target}`);
  } else {
    info(`[dry-run] package.json version → ${target}`);
  }

  // 3) Сборка (только если есть скрипт сборки)
  const buildCmd = ctx.cfg.build ?? (ctx.pkg.scripts?.build ? 'npm run build' : null);
  if (buildCmd && !/^none$/i.test(buildCmd)) {
    if (dryRun) info(`[dry-run] Сборка: ${buildCmd}`);
    else {
      info(`Сборка: ${buildCmd}`);
      const r = trySh('sh', ['-c', buildCmd], { cwd: ctx.root, quiet: true });
      if (r.code !== 0) { dim(r.stdout || r.stderr); die('Сборка упала — релиз прерван'); }
      ok('Сборка прошла');
    }
  }

  let tagName = null;
  if (!o.skipGit) tagName = doGit(ctx, target, { dryRun, branch: o.branch, remote: o.remote, tag });

  if (!o.skipNpm) {
    const { env, cleanups } = npmAuthEnv();
    try {
      doPublish(ctx, target, tag, { dryRun, env });
    } finally {
      for (const d of cleanups) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  const aggregates = o.skipAggregates ? [] : doAggregates(ctx, target, { dryRun });

  const result = {
    package: ctx.pkg.name,
    from: current,
    to: target,
    distTag: tag,
    gitTag: tagName,
    dryRun,
    discipline,
    changes: { breaking: changes.breaking.length, feat: changes.feat.length, fix: changes.fix.length, other: changes.other.length },
    aggregates,
    installHint: `dsh plugin --profile web add ${ctx.pkg.name}@${target}`,
  };

  if (o.json) log(JSON.stringify(result, null, 2));
  else {
    log('');
    ok(`${dryRun ? '[DRY-RUN] план' : 'релиз'} выполнен: ${ctx.pkg.name}@${target} (tag=${tag})`);
    dim(`Установка у пользователя: dsh plugin --profile web add ${ctx.pkg.name}@${target}`);
    if (isPre) dim(`Предварительный релиз: npm i ${ctx.pkg.name}@next`);
    if (o.line) dim(`Линия обслуживания: npm i ${ctx.pkg.name}@${tag}`);
    if (!dryRun) dim('Не забудьте: заметки о миграции в GitHub Release (обязательны для breaking-версий), дозапись в Obsidian, синхронизация агрегаторов');
  }
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  if (e instanceof Abort) {
    bad(e.message);
    process.exit(1);
  }
  bad(`Непредвиденная ошибка: ${e?.stack || e}`);
  process.exit(1);
}
