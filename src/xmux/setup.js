#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  codexDiagnostics,
  main: codexSetupMain,
  removeLegacyCodexSkills,
  resolveConfigPath: resolveCodexConfigPath,
} = require('../codex/setup');
const { main: codexCliMain } = require('../codex/cli');
const {
  main: claudeSetupMain,
  claudeDiagnostics,
  cleanupProjectClaudeResidue,
  doctorClaude,
  removeClaude,
} = require('../claude/setup');
const {
  legacySessionResidue,
  migrateLegacySessions,
} = require('./session-state');

const HOOK_TAG_KEY = 'XMUX_HOOK_TAG';
const CODEX_HOOK_TAG_VALUE = 'xmux-codex-harness';
const LEGACY_CODEX_AGENT_MARKER = '# XMUX_MANAGED_AGENT';
const LEGACY_CODEX_AGENT_MANIFEST = '.xmux-agents.json';
const LEGACY_CODEX_AGENT_NAMES = ['xmux_claude.toml', 'xmux_copilot.toml', 'xmux_gemini.toml'];
const CURRENT_CODEX_SKILLS = new Set(['xmux-claude', 'xmux-implement', 'xmux-send']);

function expandUser(value) {
  const text = String(value || '');
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return text;
}

function abs(value) {
  return path.resolve(expandUser(value));
}

function readText(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function xmuxRuntimeShellPath(root) {
  return path.join(abs(root), 'runtime', 'shell', 'xmux.zsh');
}

function hasXmuxRuntime(root) {
  const installRoot = abs(root);
  return fs.existsSync(xmuxRuntimeShellPath(installRoot)) || fs.existsSync(path.join(installRoot, 'xmux.zsh'));
}

function stableHomebrewInstallRoot(value) {
  return abs(value);
}

function homebrewInstallCandidates() {
  const candidates = [];
  for (const prefix of ['/opt/homebrew', '/usr/local']) {
    for (const formula of ['xmux', 'xmux-beta']) {
      candidates.push(path.join(prefix, 'opt', formula, 'libexec'));
    }
  }
  return candidates;
}

function resolveSetupXmuxInstallDir(explicitInstallDir, scriptInstallDir) {
  if (explicitInstallDir) return stableHomebrewInstallRoot(explicitInstallDir);
  const scriptInstallRoot = stableHomebrewInstallRoot(scriptInstallDir);
  if (hasXmuxRuntime(scriptInstallRoot)) return scriptInstallRoot;
  const envInstallDir = process.env.XMUX_INSTALL_DIR
    ? stableHomebrewInstallRoot(process.env.XMUX_INSTALL_DIR)
    : '';
  if (envInstallDir && hasXmuxRuntime(envInstallDir)) return envInstallDir;
  for (const candidate of homebrewInstallCandidates()) {
    if (hasXmuxRuntime(candidate)) return candidate;
  }
  return scriptInstallRoot;
}

async function withXmuxInstallDir(installDir, fn) {
  const previous = process.env.XMUX_INSTALL_DIR;
  process.env.XMUX_INSTALL_DIR = installDir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.XMUX_INSTALL_DIR;
    else process.env.XMUX_INSTALL_DIR = previous;
  }
}

function claudeHome() {
  return process.env.CLAUDE_HOME ? abs(process.env.CLAUDE_HOME) : path.join(os.homedir(), '.claude');
}

function projectRoot(start = process.cwd()) {
  let current = abs(start);
  try {
    if (fs.existsSync(current) && !fs.statSync(current).isDirectory()) current = path.dirname(current);
  } catch (_) {
    current = process.cwd();
  }
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    current = path.dirname(current);
  }
  return abs(start || process.cwd());
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function isManagedCodexHookCommand(command) {
  const text = String(command || '');
  return text.includes(HOOK_TAG_KEY) && text.includes(CODEX_HOOK_TAG_VALUE) && text.includes(' codex hook ');
}

function removeManagedCodexHooks(settings) {
  if (!settings || typeof settings !== 'object' || !settings.hooks || typeof settings.hooks !== 'object') {
    return 0;
  }
  let removed = 0;
  for (const eventName of Object.keys(settings.hooks)) {
    const current = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
    const filtered = current
      .map((entry) => {
        if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) return entry;
        const hooks = entry.hooks.filter((hook) => {
          const managed = isManagedCodexHookCommand((hook || {}).command || '');
          if (managed) removed += 1;
          return !managed;
        });
        return { ...entry, hooks };
      })
      .filter((entry) => !entry || !Array.isArray(entry.hooks) || entry.hooks.length > 0);
    if (filtered.length) settings.hooks[eventName] = filtered;
    else delete settings.hooks[eventName];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

function cleanupProjectCodexResidue(projectDir, opts = {}) {
  const root = projectDir ? abs(projectDir) : projectRoot();
  const hooksFile = path.join(root, '.codex', 'hooks.json');
  if (!fs.existsSync(hooksFile)) return { project: root, hooks: 0 };
  const settings = readJson(hooksFile, {});
  const hooks = removeManagedCodexHooks(settings);
  if (hooks && !opts.dry_run) writeJson(hooksFile, settings);
  return { project: root, hooks };
}

function codexHomeFromOpts(opts = {}) {
  return opts.home ? abs(opts.home) : path.join(os.homedir(), '.codex');
}

function codexAgentsDirFromOpts(opts = {}) {
  return path.join(codexHomeFromOpts(opts), 'agents');
}

function legacyProcessMatches() {
  const result = spawnSync('ps', ['-Ao', 'pid,ppid,stat,command', '-ww'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => (
      line.includes('xmux-bridge/mcp/servers/bridge.js')
      || line.includes('xmux-lead-mcp')
      || line.includes('xmux-mcp-bridge')
      || line.includes('xmux-bridge.zsh')
    ));
}

function dirHasEntries(dirPath) {
  try {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory() && fs.readdirSync(dirPath).length > 0;
  } catch (_) {
    return false;
  }
}

function fileContains(filePath, patterns) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  return patterns.filter((pattern) => content.includes(pattern));
}

function legacyCodexAgentResidue(opts = {}) {
  const root = codexAgentsDirFromOpts(opts);
  const items = [];
  const warnings = [];
  const manifest = path.join(root, LEGACY_CODEX_AGENT_MANIFEST);
  if (fs.existsSync(manifest)) items.push({ path: manifest, type: 'manifest', managed: true });
  for (const name of LEGACY_CODEX_AGENT_NAMES) {
    const filePath = path.join(root, name);
    if (!fs.existsSync(filePath)) continue;
    const managed = readText(filePath).includes(LEGACY_CODEX_AGENT_MARKER);
    if (managed) items.push({ path: filePath, type: 'agent', managed: true });
    else warnings.push(`legacy Codex agent proxy exists but is unmanaged: ${filePath}`);
  }
  return { items, warnings };
}

function legacyDiagnostics(opts = {}) {
  const project = opts.project ? abs(opts.project) : projectRoot();
  const codexHomeDir = codexHomeFromOpts(opts);
  const stateRoot = path.join(project, '.codex', 'xmux');
  const issues = [];
  const warnings = [];
  const notes = [];
  const processes = legacyProcessMatches();
  if (processes.length) {
    issues.push(`legacy XMux MCP/team processes are still running: ${processes.length}`);
  }

  const legacySkill = path.join(codexHomeDir, 'skills', 'xmux-claude');
  const legacyManifest = path.join(codexHomeDir, 'skills', '.xmux-skills.json');
  const legacyCodexAgents = legacyCodexAgentResidue(opts);
  const agentsSkills = path.join(os.homedir(), '.agents', 'skills');
  const activeTeams = path.join(codexHomeDir, 'xmux', 'active-teams');
  const projectTeams = path.join(project, '.codex', 'xmux', 'teams');
  const projectArchive = path.join(project, '.codex', 'xmux', 'archive');

  if (fs.existsSync(legacySkill)) warnings.push(`legacy Codex skill remains at ${legacySkill}`);
  if (fs.existsSync(legacyManifest)) warnings.push(`legacy Codex skill manifest remains at ${legacyManifest}`);
  for (const item of legacyCodexAgents.items) warnings.push(`legacy Codex agent proxy remains at ${item.path}`);
  warnings.push(...legacyCodexAgents.warnings);
  if (dirHasEntries(agentsSkills)) {
    for (const name of fs.readdirSync(agentsSkills).sort()) {
      if (name.startsWith('xmux-') && !CURRENT_CODEX_SKILLS.has(name)) warnings.push(`legacy .agents XMux skill remains at ${path.join(agentsSkills, name)}`);
    }
  }
  if (dirHasEntries(activeTeams)) warnings.push(`legacy active team state remains at ${activeTeams}`);
  if (dirHasEntries(projectTeams)) warnings.push(`legacy project team state remains at ${projectTeams}`);
  if (dirHasEntries(projectArchive)) warnings.push(`legacy project archives remain at ${projectArchive}; use cleanup-legacy --purge-archive to remove them`);
  for (const item of legacySessionResidue(stateRoot)) {
    warnings.push(`legacy ${item.role} session state remains at ${item.path}; cleanup-legacy migrates it to sessions/<role>--<name>.json`);
  }

  const codexConfig = path.join(codexHomeDir, 'config.toml');
  for (const match of fileContains(codexConfig, [
    'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
    'CLAUDE_CODE_SPAWN_BACKEND',
    '[mcp_servers.xmux_lead',
    '[mcp_servers.amux_lead',
  ])) {
    warnings.push(`legacy/shared setting remains in ${codexConfig}: ${match}`);
  }
  const claudeSettings = path.join(claudeHome(), 'settings.json');
  for (const match of fileContains(claudeSettings, [
    'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
    'CLAUDE_CODE_SPAWN_BACKEND',
  ])) {
    warnings.push(`legacy/shared setting remains in ${claudeSettings}: ${match}`);
  }

  if (!issues.length && !warnings.length) notes.push(['OK', 'No legacy XMux residue detected']);
  return { project, issues, warnings, notes, processes };
}

function removePathIfPresent(target, opts, removed) {
  if (!fs.existsSync(target)) return;
  if (!opts.dry_run) fs.rmSync(target, { recursive: true, force: true });
  removed.push(target);
}

function cleanupLegacyCodexAgents(opts = {}) {
  const residue = legacyCodexAgentResidue(opts);
  const removed = [];
  for (const item of residue.items) {
    if (!opts.dry_run) fs.rmSync(item.path, { force: true });
    removed.push(item.path);
  }
  return { removed, warnings: residue.warnings };
}

function cleanupAgentsLegacySkills(opts = {}) {
  const root = path.join(os.homedir(), '.agents', 'skills');
  const removed = [];
  const warnings = [];
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { removed, warnings };
  for (const name of fs.readdirSync(root).sort()) {
    if (!name.startsWith('xmux-')) continue;
    const candidate = path.join(root, name);
    let stat = null;
    try {
      stat = fs.lstatSync(candidate);
    } catch (_) {
      continue;
    }
    const marker = path.join(candidate, '.xmux-managed-skill');
    const isCurrent = CURRENT_CODEX_SKILLS.has(name);
    const removable = stat.isSymbolicLink() || (!isCurrent && stat.isDirectory() && fs.existsSync(marker));
    if (removable) {
      if (!opts.dry_run) fs.rmSync(candidate, { recursive: true, force: true });
      removed.push(candidate);
    } else if (!isCurrent) {
      warnings.push(`legacy .agents skill exists but is unmanaged: ${candidate}`);
    }
  }
  return { removed, warnings };
}

function cleanupLegacy(opts = {}) {
  const diagnostics = legacyDiagnostics(opts);
  const removed = [];
  const migrated = [];
  const warnings = [...diagnostics.issues, ...diagnostics.warnings];
  if (diagnostics.issues.length && !opts.force && !opts.dry_run) {
    if (!opts.quiet) {
      console.log('[FAIL] Refusing to clean legacy XMux state while legacy processes are running');
      for (const issue of diagnostics.issues) console.log(`  - ${issue}`);
      for (const processLine of diagnostics.processes) console.log(`  - ${processLine}`);
      console.log('Stop the listed legacy xmux-bridge/xmux-lead-mcp processes, or rerun with --force if you understand the risk.');
    }
    return 1;
  }

  const codexConfig = path.join(codexHomeFromOpts(opts), 'config.toml');
  const legacySkills = removeLegacyCodexSkills(codexConfig, opts);
  removed.push(...legacySkills.removed);
  warnings.push(...legacySkills.warnings);
  const legacyCodexAgents = cleanupLegacyCodexAgents(opts);
  removed.push(...legacyCodexAgents.removed);
  warnings.push(...legacyCodexAgents.warnings);
  const legacyAgentsSkills = cleanupAgentsLegacySkills(opts);
  removed.push(...legacyAgentsSkills.removed);
  warnings.push(...legacyAgentsSkills.warnings);
  removePathIfPresent(path.join(codexHomeFromOpts(opts), 'xmux', 'active-teams'), opts, removed);

  const claudeResidue = cleanupProjectClaudeResidue(opts.project, opts);
  removed.push(...claudeResidue.commands, ...claudeResidue.skills);
  if (claudeResidue.hooks) removed.push(path.join(claudeResidue.project, '.claude', 'settings.local.json'));
  const codexResidue = cleanupProjectCodexResidue(opts.project, opts);
  if (codexResidue.hooks) removed.push(path.join(codexResidue.project, '.codex', 'hooks.json'));

  const project = opts.project ? abs(opts.project) : projectRoot();
  const sessionMigration = migrateLegacySessions(path.join(project, '.codex', 'xmux'), {
    dry_run: opts.dry_run,
    removeLegacy: true,
  });
  migrated.push(...sessionMigration.migrated);
  removed.push(...sessionMigration.removed);
  warnings.push(...sessionMigration.warnings);
  removePathIfPresent(path.join(project, '.codex', 'xmux', 'teams'), opts, removed);
  const archive = path.join(project, '.codex', 'xmux', 'archive');
  if (opts.purge_archive) removePathIfPresent(archive, opts, removed);
  else if (dirHasEntries(archive)) warnings.push(`preserved legacy archive: ${archive}`);

  if (!opts.quiet) {
    const prefix = opts.dry_run ? '[DRY-RUN]' : '[OK]';
    console.log(`${prefix} XMux legacy cleanup`);
    for (const item of migrated) {
      console.log(`  - ${opts.dry_run ? 'would migrate' : 'migrated'} ${item.role}:${item.name} -> ${item.to}`);
    }
    if (removed.length) for (const item of removed) console.log(`  - ${opts.dry_run ? 'would remove' : 'removed'} ${item}`);
    else console.log('  - no removable legacy state found');
    for (const warning of warnings) console.log(`  - [WARN] ${warning}`);
  }
  return 0;
}

function parseArgs(argv) {
  const opts = {
    doctor: false,
    remove: false,
    cleanup_legacy: false,
    quiet: false,
    json: false,
    dry_run: false,
    refresh: false,
    purge_archive: false,
    force: false,
    without_codex: false,
    without_claude: false,
    without_skills: false,
    with_skills: true,
    without_codex_permissions: false,
    with_codex_permissions: true,
    ref: '',
    home: '',
    project: '',
    skills_dir: '',
    tmux_socket: '',
    xmux_install_dir: '',
  };
  for (let i = 0; i < argv.length;) {
    const arg = argv[i];
    if (arg === '--doctor') { opts.doctor = true; i += 1; }
    else if (arg === '--remove') { opts.remove = true; i += 1; }
    else if (arg === '--cleanup-legacy') { opts.cleanup_legacy = true; i += 1; }
    else if (arg === '--quiet') { opts.quiet = true; i += 1; }
    else if (arg === '--json') { opts.json = true; i += 1; }
    else if (arg === '--dry-run') { opts.dry_run = true; i += 1; }
    else if (arg === '--refresh') { opts.refresh = true; i += 1; }
    else if (arg === '--purge-archive') { opts.purge_archive = true; i += 1; }
    else if (arg === '--force') { opts.force = true; i += 1; }
    else if (arg === '--without-codex') { opts.without_codex = true; i += 1; }
    else if (arg === '--without-claude') { opts.without_claude = true; i += 1; }
    else if (arg === '--with-skills') { opts.with_skills = true; opts.without_skills = false; i += 1; }
    else if (arg === '--without-skills') { opts.without_skills = true; opts.with_skills = false; i += 1; }
    else if (arg === '--with-codex-permissions') { opts.with_codex_permissions = true; opts.without_codex_permissions = false; i += 1; }
    else if (arg === '--without-codex-permissions') { opts.without_codex_permissions = true; opts.with_codex_permissions = false; i += 1; }
    else if ((arg === '--ref' || arg === '--home' || arg === '--project' || arg === '--skills-dir' || arg === '--tmux-socket' || arg === '--xmux-install-dir') && i + 1 < argv.length) {
      opts[arg.slice(2).replace(/-/g, '_')] = argv[i + 1];
      i += 2;
    } else {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
  }
  return opts;
}

async function setupClaude(opts, xmuxInstallDir) {
  const args = ['ensure-hooks'];
  if (opts.dry_run) args.push('--dry-run');
  if (opts.quiet || !opts.dry_run) args.push('--quiet');
  return withXmuxInstallDir(xmuxInstallDir, () => claudeSetupMain(args));
}

async function setupCodexHooks(opts, xmuxInstallDir) {
  const codexHome = opts.home ? abs(opts.home) : path.join(os.homedir(), '.codex');
  const hooksFile = path.join(codexHome, 'hooks.json');
  if (opts.dry_run) {
    if (!opts.quiet) {
      console.log(`[DRY-RUN] Would install Codex global hooks in ${hooksFile}`);
    }
    return 0;
  }
  const args = ['ensure-hooks', '--quiet'];
  if (opts.home) args.push('--home', opts.home);
  return withXmuxInstallDir(xmuxInstallDir, () => codexCliMain(args));
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const scriptInstallDir = path.dirname(path.dirname(path.dirname(abs(__filename))));
  const xmuxInstallDir = resolveSetupXmuxInstallDir(opts.xmux_install_dir, scriptInstallDir);
  if (opts.cleanup_legacy) return cleanupLegacy(opts);
  if (opts.doctor) {
    const codexArgs = ['--doctor', ...(opts.quiet || opts.json ? ['--quiet'] : [])];
    if (opts.home) codexArgs.push('--home', opts.home);
    if (opts.project) codexArgs.push('--project', opts.project);
    if (opts.skills_dir || process.env.XMUX_CODEX_SKILLS_DIR) {
      codexArgs.push('--skills-dir', opts.skills_dir || process.env.XMUX_CODEX_SKILLS_DIR);
    }
    if (opts.tmux_socket) codexArgs.push('--tmux-socket', opts.tmux_socket);
    codexArgs.push('--xmux-install-dir', xmuxInstallDir);
    const codexSkillsDir = opts.skills_dir || process.env.XMUX_CODEX_SKILLS_DIR || '';
    const codexDiag = opts.without_codex
      ? { issues: [], warnings: [], notes: [] }
      : codexDiagnostics(resolveCodexConfigPath({ home: opts.home, project: opts.project }), xmuxInstallDir, codexSkillsDir, {
        tmux_socket: opts.tmux_socket,
      });
    const codex = opts.without_codex
      ? 0
      : (opts.json ? (codexDiag.issues.length ? 1 : 0) : codexSetupMain(codexArgs));
    const legacyDiag = legacyDiagnostics(opts);
    const legacyStatus = legacyDiag.issues.length ? 1 : 0;
    if (opts.json) {
      const claudeDiag = opts.without_claude
        ? { issues: [], notes: [] }
        : await withXmuxInstallDir(xmuxInstallDir, () => claudeDiagnostics());
      const claude = claudeDiag.issues.length ? 1 : 0;
      console.log(JSON.stringify({
        status: codex || claude || legacyStatus ? 'fail' : 'ok',
        codex: {
          enabled: !opts.without_codex,
          status: codex ? 'fail' : (codexDiag.warnings.length ? 'warn' : 'ok'),
          issues: codexDiag.issues,
          warnings: codexDiag.warnings,
          notes: codexDiag.notes,
        },
        claude: {
          enabled: !opts.without_claude,
          status: claude ? 'fail' : 'ok',
          issues: claudeDiag.issues,
          notes: claudeDiag.notes,
        },
        legacy: {
          status: legacyStatus ? 'fail' : (legacyDiag.warnings.length ? 'warn' : 'ok'),
          issues: legacyDiag.issues,
          warnings: legacyDiag.warnings,
          notes: legacyDiag.notes,
        },
      }, null, 2));
      return codex || claude || legacyStatus;
    }
    const claude = opts.without_claude
      ? 0
      : await withXmuxInstallDir(xmuxInstallDir, () => doctorClaude(opts));
    if (!opts.quiet && (legacyDiag.issues.length || legacyDiag.warnings.length)) {
      console.log(legacyDiag.issues.length ? '[FAIL] Legacy XMux runtime is still active' : '[WARN] Legacy XMux residue detected');
      for (const issue of legacyDiag.issues) console.log(`  - ${issue}`);
      for (const warning of legacyDiag.warnings) console.log(`  - [WARN] ${warning}`);
      if (!legacyDiag.issues.length) console.log('  - Run: xmux cleanup-legacy --dry-run');
    }
    return codex || claude || legacyStatus;
  }
  if (opts.remove) {
    const codexArgs = ['--remove', ...(opts.dry_run ? ['--dry-run'] : []), ...(opts.with_skills ? ['--with-skills'] : [])];
    if (opts.home) codexArgs.push('--home', opts.home);
    if (opts.project) codexArgs.push('--project', opts.project);
    codexArgs.push('--xmux-install-dir', xmuxInstallDir);
    const codex = opts.without_codex ? 0 : codexSetupMain(codexArgs);
    if (!opts.without_codex) cleanupProjectCodexResidue(opts.project, opts);
    const claude = opts.without_claude
      ? 0
      : await withXmuxInstallDir(xmuxInstallDir, () => removeClaude(opts));
    const legacy = cleanupLegacy(opts);
    return codex || claude || legacy;
  }

  const codexArgs = [
    ...(opts.without_skills ? ['--without-skills'] : ['--with-skills']),
    ...(opts.with_codex_permissions && !opts.without_codex_permissions ? ['--with-codex-permissions'] : []),
    ...(opts.dry_run ? ['--dry-run'] : []),
    ...(opts.refresh ? ['--refresh'] : []),
  ];
  if (opts.home) codexArgs.push('--home', opts.home);
  if (opts.project) codexArgs.push('--project', opts.project);
  if (opts.skills_dir || process.env.XMUX_CODEX_SKILLS_DIR) {
    codexArgs.push('--skills-dir', opts.skills_dir || process.env.XMUX_CODEX_SKILLS_DIR);
  }
  if (opts.tmux_socket) codexArgs.push('--tmux-socket', opts.tmux_socket);
  if (opts.ref) codexArgs.push('--ref', opts.ref);
  codexArgs.push('--xmux-install-dir', xmuxInstallDir);
  const project = opts.project ? abs(opts.project) : projectRoot();
  const sessionMigration = migrateLegacySessions(path.join(project, '.codex', 'xmux'), {
    dry_run: opts.dry_run,
  });
  if (!opts.quiet && (sessionMigration.migrated.length || sessionMigration.warnings.length)) {
    for (const item of sessionMigration.migrated) {
      console.log(`${opts.dry_run ? '[DRY-RUN]' : '[OK]'} ${opts.dry_run ? 'Would migrate' : 'Migrated'} ${item.role}:${item.name} -> ${item.to}`);
    }
    for (const warning of sessionMigration.warnings) console.log(`[WARN] ${warning}`);
  }
  const codexConfig = opts.without_codex ? 0 : codexSetupMain(codexArgs);
  const codexHooks = opts.without_codex ? 0 : await setupCodexHooks(opts, xmuxInstallDir);
  const codex = codexConfig || codexHooks;
  const claude = opts.without_claude ? 0 : await setupClaude(opts, xmuxInstallDir);
  if (!opts.quiet && !opts.dry_run) console.log('[OK] XMux setup complete');
  return codex || claude;
}

if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`xmux setup: ${error && error.message ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}

module.exports = { main };
