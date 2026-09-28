#!/usr/bin/env node
/**
 * pack.js — create extension.zip for distribution (npm run pack).
 *
 * The old command was `zip -r extension.zip . -x ...` — the Unix `zip` CLI does
 * not exist on Windows, so the script could never run here (see AGENTS.md).
 * This runner picks the archive backend at runtime:
 *
 *   1. PowerShell .NET ZipFile (preferred — native on Windows; entry paths are
 *      passed explicitly because `Compress-Archive` flattens relative paths)
 *   2. node:zlib zip writer (dependency-free fallback, works everywhere)
 *
 * Exclusions follow two rules:
 *   - `.gitignore` is honored (use `git ls-files`) so local-only content never
 *     ships — notably `docs/HANDOFF.md` (marked internal/unfinished) and the
 *     `temp/` harness (holds a ~200MB Chrome-for-Testing install).
 *   - distribution noise is dropped even when tracked:
 *     '*.git*', 'node_modules/', '*.zip', docs/dev/test metadata (AGENTS.md,
 *     CONTRIBUTING.md, .env.example, tests/, docs/), plus secrets/logs —
 *     so the fallback below leaks nothing even without .gitignore.
 *   Fallback when git is unavailable: filesystem walk + the static excludes
 *   (secrets and logs included — `.gitignore` cannot be read without git).
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'extension.zip');

// Paths are tested in posix form; a directory probe gets a trailing slash so
// directory-only rules (temp/, node_modules/) can match.
const EXCLUDE = [
  /\.git/, // '-x *.git*'
  /(^|\/)node_modules\//, // '-x node_modules/*'
  /\.zip$/, // '-x *.zip'
  /^temp\//, // local harness, gitignored — not distribution content
  // Repo metadata that is not part of the shipped extension:
  /^AGENTS\.md$/,
  /^CONTRIBUTING\.md$/,
  /^\.env\.example$/,
  /^\.vscode\//, // IDE settings — root-level only
  /^tests\//,
  /^docs\//,
  // Secrets & logs. These are normally caught by .gitignore, but
  // collectFromDisk() (no git available) cannot honor .gitignore — without
  // these, a stray .env or logs/*.log in a source export ships in the zip,
  // which is exactly what the gitignore-based collection exists to prevent.
  /^\.env$/,
  /^\.env\./, // .env.local, .env.production (…but .env.example already dropped above)
  /\.(key|secret|pem|p12|pfx|crx)$/,
  /(^|\/)(api_keys|credentials|secrets|token)\.json$/,
  /_key\.json$/,
  /_secret\.json$/,
  /(^|\/)logs\//,
  /\.log$/,
  /^\.claude\/settings\.local\.json$/,
];

function isExcluded(relPosix, isDir) {
  const probe = isDir ? `${relPosix}/` : relPosix;
  return EXCLUDE.some((re) => re.test(probe));
}

/**
 * Repo-relative posix paths via git — honors .gitignore (tracked + staged only).
 *
 * `-c core.quotepath=false` is load-bearing: without it git C-quotes any path
 * with non-ASCII bytes (`音试.wav` → `"\351\237\263….wav"`), and the backslash
 * cleanup below then mangles it into a path that existsSync() cannot find —
 * so the file is silently dropped from the archive while pack still reports
 * success. `-z` would also work, but quotepath=false keeps the split('\n')
 * parsing and lets each path through untouched.
 */
function collectWithGit() {
  const r = spawnSync(
    'git',
    ['-c', 'core.quotepath=false', 'ls-files', '-c', '-o', '--exclude-standard'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.error || r.status !== 0) return null;
  const out = [];
  const skipped = [];
  for (const raw of r.stdout.split('\n')) {
    const rel = raw.trim().replace(/\\/g, '/');
    if (!rel || isExcluded(rel, false)) continue;
    // git lists untracked-but-not-ignored files too; a path that is gone now
    // (or is a directory) is dropped — reported, not silently swallowed.
    const abs = path.join(ROOT, ...rel.split('/'));
    let isFile = false;
    try {
      isFile = fs.statSync(abs).isFile();
    } catch {
      isFile = false;
    }
    if (isFile) out.push(rel);
    else skipped.push(rel);
  }
  if (skipped.length) {
    console.warn(`  [pack] skipped ${skipped.length} listed path(s): ${skipped.join(', ')}`);
  }
  return out.sort();
}

/** Filesystem walk fallback when git is unavailable: static excludes only. */
function collectFromDisk() {
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!isExcluded(relPath, true)) walk(path.join(dir, entry.name), relPath);
      } else if (entry.isFile() && !isExcluded(relPath, false)) {
        out.push(relPath);
      }
      // symlinks and other specials are skipped on purpose (no cycles)
    }
  };
  walk(ROOT, '');
  return out.sort();
}

// ---------- backend 1: PowerShell Compress-Archive ----------

/** Single-quote for PowerShell literal strings. */
const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;

function psScript(listPath) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$list = @(Get-Content -LiteralPath ${psQuote(listPath)} -Encoding UTF8 | Where-Object { $_ -ne '' })
if ($list.Count -eq 0) { throw 'empty pack list' }
if (Test-Path -LiteralPath ${psQuote(OUT)}) { Remove-Item -LiteralPath ${psQuote(OUT)} -Force }
# NOTE: do NOT use Compress-Archive here — it flattens relative paths into entry
# names (audio/convert.js -> convert.js), producing a broken archive.
$root = ${psQuote(ROOT)}
$zip = [System.IO.Compression.ZipFile]::Open(${psQuote(OUT)}, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($rel in $list) {
    # CreateEntryFromFile(source, entryName): entryName keeps the repo-relative
    # structure (subdirs included) regardless of the current working directory.
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $root $rel), $rel, 'Optimal') | Out-Null
  }
} finally { $zip.Dispose() }
$zip2 = [System.IO.Compression.ZipFile]::OpenRead(${psQuote(OUT)})
try { Write-Output ('ENTRIES:' + $zip2.Entries.Count) } finally { $zip2.Dispose() }
`;
}

/**
 * Try `pwsh` then `powershell`. Returns the entry count on success, null when
 * neither backend is usable — the caller falls back to the Node writer.
 */
function packWithPowerShell(listPath) {
  if (process.platform !== 'win32') return null;
  // -EncodedCommand keeps the script free of cmd/powershell quoting hazards.
  const encoded = Buffer.from(psScript(listPath), 'utf16le').toString('base64');
  let lastError = '';
  for (const exe of ['pwsh', 'powershell']) {
    const r = spawnSync(
      exe,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: 120000 },
    );
    if (!r.error && r.status === 0) {
      const m = /ENTRIES:(\d+)/.exec(r.stdout || '');
      if (m && fs.existsSync(OUT)) return Number(m[1]);
    }
    lastError = r.error
      ? r.error.message
      : `${exe}: ${String(r.stderr || r.stdout || '').trim().slice(0, 300)}`;
  }
  console.error(`  [pack] PowerShell backend failed (${lastError}) — using node:zlib fallback`);
  try {
    fs.rmSync(OUT, { force: true }); // drop any partial archive
  } catch {}
  return null;
}

// ---------- backend 2: node:zlib zip writer ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time =
    ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xffff;
  const day = Math.max(date.getDate(), 1);
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const dosDate = (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | day) & 0xffff;
  return { time, dosDate };
}

function packWithNode(relFiles) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const rel of relFiles) {
    const abs = path.join(ROOT, ...rel.split('/'));
    const raw = fs.readFileSync(abs);

    // deflate only when it actually shrinks the entry
    let method = 0;
    let payload = raw;
    if (raw.length > 0) {
      const deflated = zlib.deflateRawSync(raw, { level: 6 });
      if (deflated.length < raw.length) {
        method = 8;
        payload = deflated;
      }
    }

    const crc = crc32(raw);
    const { time, dosDate } = dosDateTime(fs.statSync(abs).mtime);
    const name = Buffer.from(rel, 'utf8');
    const flags = /[^\x00-\x7f]/.test(rel) ? 0x0800 : 0; // bit 11 = UTF-8 names

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localParts.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: unix, zip 2.0
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    // 0o100644 << 16 is a *signed* 32-bit shift in JS (negative) — >>> 0 unsigned
    central.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // external: regular file 644
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralSize = centralParts.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(relFiles.length, 8);
  eocd.writeUInt16LE(relFiles.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20);

  // write via a temp file so a failed run never leaves a half-written archive
  const tmp = `${OUT}.node-tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    for (const buf of [...localParts, ...centralParts, eocd]) fs.writeSync(fd, buf);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, OUT);
}

function main() {
  const forceNode = process.argv.includes('--node');
  const relFiles = collectWithGit() || collectFromDisk();
  if (relFiles.length === 0) {
    console.error('[pack] nothing to archive');
    process.exitCode = 1;
    return;
  }

  const listPath = path.join(os.tmpdir(), `pack-list-${process.pid}.txt`);
  fs.writeFileSync(listPath, `${relFiles.join('\n')}\n`, 'utf8');

  let entries = null;
  let via = 'node:zlib';
  if (!forceNode) {
    entries = packWithPowerShell(listPath);
    if (entries !== null) via = 'PowerShell (.NET ZipFile)';
  }
  fs.rmSync(listPath, { force: true });

  if (entries === null) {
    fs.rmSync(OUT, { force: true });
    packWithNode(relFiles);
    entries = relFiles.length;
  }

  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`extension.zip — ${entries} entries, ${kb} KB (${via})`);
}

main();
