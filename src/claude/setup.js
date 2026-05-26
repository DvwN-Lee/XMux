#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { claudeAgentsDir, claudeSkillFile } = require('../xmux/assets');

const COMMAND_NAME = 'xmux-codex';
const THEME_NAME = 'xmux-claude-code';
const THEME_SETTING_VALUE = `custom:${THEME_NAME}`;
const HOOK_TAG_KEY = 'XMUX_HOOK_TAG';
const HOOK_TAG_VALUE = 'xmux-claude-harness';
const MANAGED_SKILL_MARKER = '.xmux-managed-skill';
const MANAGED_AGENT_MARKER = '.xmux-managed-agent';
const MANAGED_THEME_MARKER = '.xmux-managed-theme-xmux-claude-code';
const LEGACY_MANAGED_SKILL_MARKER = '<!-- XMUX_MANAGED_CLAUDE_XMUX_CODEX_SKILL -->';
const MANAGED_COMMAND_MARKER = '<!-- XMUX_MANAGED_CLAUDE_XMUX_CODEX_COMMAND -->';

function expandUser(value) {
  const text = String(value || '');
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return text;
}

function abs(value) {
  return path.resolve(expandUser(value));
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

function claudeHome() {
  return process.env.CLAUDE_HOME ? abs(process.env.CLAUDE_HOME) : path.join(os.homedir(), '.claude');
}

function xmuxRuntimeShellPath(root) {
  return path.join(path.resolve(expandUser(root)), 'runtime', 'shell', 'xmux.zsh');
}

function hasXmuxRuntime(root) {
  const resolved = path.resolve(expandUser(root));
  return fs.existsSync(xmuxRuntimeShellPath(resolved)) || fs.existsSync(path.join(resolved, 'xmux.zsh'));
}

function stableHomebrewInstallRoot(value) {
  const root = path.resolve(expandUser(value));
  const parts = root.split(path.sep);
  const cellarIndex = parts.lastIndexOf('Cellar');
  const formula = cellarIndex >= 0 ? parts[cellarIndex + 1] : '';
  if (
    !['xmux', 'xmux-beta'].includes(formula)
    || !root.endsWith(`${path.sep}libexec`)
    || !hasXmuxRuntime(root)
  ) return root;
  const prefix = parts.slice(0, cellarIndex).join(path.sep) || path.sep;
  const candidate = path.join(prefix, 'opt', formula, 'libexec');
  return hasXmuxRuntime(candidate) ? candidate : root;
}

function installRoot() {
  const raw = process.env.XMUX_INSTALL_DIR
    ? path.resolve(expandUser(process.env.XMUX_INSTALL_DIR))
    : path.resolve(__dirname, '..', '..');
  return stableHomebrewInstallRoot(raw);
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

function writeTextAtomic(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, String(text), 'utf8');
  fs.renameSync(tmp, filePath);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function hookSubcommandForEvent(eventName) {
  if (eventName === 'SessionStart') return 'session-start';
  if (eventName === 'Stop') return 'stop';
  if (eventName === 'PreToolUse') return 'pre-tool-use';
  if (eventName === 'SubagentStop') return 'subagent-stop';
  if (eventName === 'UserPromptExpansion') return 'user-prompt-expansion';
  return 'user-prompt';
}

function isManagedClaudeHookCommand(command, eventName = '') {
  const text = String(command || '');
  if (eventName) {
    const subcommand = hookSubcommandForEvent(eventName);
    if (text.includes(`${HOOK_TAG_KEY}=${HOOK_TAG_VALUE}`) && text.includes(` claude hook ${subcommand}`)) {
      return true;
    }
    const legacyPattern = new RegExp(
      String.raw`(^|\s)(?:'[^']*/bin/xmux'|"[^"]*/bin/xmux"|[^\s]+/bin/xmux|xmux)\s+claude\s+hook\s+${subcommand}(\s|$)`
    );
    return legacyPattern.test(text);
  }
  return (
    text.includes(HOOK_TAG_KEY) && text.includes(HOOK_TAG_VALUE)
  ) || (
    (text.includes('XMUX_PROJECT_DIR=') || text.includes('XMUX_STATE_DIR='))
    && text.includes(' claude hook ')
  );
}

function ensureHookList(settings, eventName, command, matcher = '') {
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  const current = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
  const filtered = current
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const hooks = Array.isArray(entry.hooks)
        ? entry.hooks.filter((hook) => !isManagedClaudeHookCommand((hook || {}).command || '', eventName))
        : entry.hooks;
      return { ...entry, hooks };
    })
    .filter((entry) => !entry || !Array.isArray(entry.hooks) || entry.hooks.length > 0);
  filtered.push({
    matcher,
    hooks: [{ type: 'command', command }],
  });
  settings.hooks[eventName] = filtered;
}

function removeManagedClaudeHooks(settings) {
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
          const managed = isManagedClaudeHookCommand((hook || {}).command || '');
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

function managedClaudeSkillContent() {
  const asset = claudeSkillFile(installRoot(), COMMAND_NAME);
  if (fs.existsSync(asset)) return fs.readFileSync(asset, 'utf8');
  throw new Error(`missing managed Claude skill asset: ${asset}`);
}

function managedClaudeAgentSources() {
  const root = claudeAgentsDir(installRoot());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  return fs.readdirSync(root)
    .sort()
    .filter((name) => name.startsWith('xmux-') && name.endsWith('.md'))
    .map((name) => [name, path.join(root, name)]);
}

function claudeSkillManaged(skillDir) {
  const marker = path.join(skillDir, MANAGED_SKILL_MARKER);
  const skillFile = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(marker)) return true;
  return fs.existsSync(skillFile) && fs.readFileSync(skillFile, 'utf8').includes(LEGACY_MANAGED_SKILL_MARKER);
}

function removeManagedClaudeSkillDir(skillRoot, opts = {}) {
  const skillDir = path.join(skillRoot, COMMAND_NAME);
  try {
    const stat = fs.lstatSync(skillDir);
    if (stat.isSymbolicLink()) {
      if (!opts.dry_run) fs.unlinkSync(skillDir);
      return { removed: true, path: skillDir, reason: '' };
    }
    if (!stat.isDirectory()) return { removed: false, path: skillDir, reason: 'not a directory' };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { removed: false, path: skillDir, reason: 'missing' };
    throw error;
  }
  if (!claudeSkillManaged(skillDir)) return { removed: false, path: skillDir, reason: 'unmanaged' };
  if (!opts.dry_run) fs.rmSync(skillDir, { recursive: true, force: true });
  return { removed: true, path: skillDir, reason: '' };
}

function removeManagedClaudeCommand(commandRoot, opts = {}) {
  const commandFile = path.join(commandRoot, `${COMMAND_NAME}.md`);
  if (!fs.existsSync(commandFile)) return { removed: false, path: commandFile, reason: 'missing' };
  const current = fs.readFileSync(commandFile, 'utf8');
  if (!current.includes(MANAGED_COMMAND_MARKER)) return { removed: false, path: commandFile, reason: 'unmanaged' };
  if (!opts.dry_run) fs.unlinkSync(commandFile);
  return { removed: true, path: commandFile, reason: '' };
}

function claudeThemeManaged(themeRoot) {
  const marker = path.join(themeRoot, MANAGED_THEME_MARKER);
  return fs.existsSync(marker);
}

function removeManagedClaudeTheme(themeRoot, opts = {}) {
  const themeFile = path.join(themeRoot, `${THEME_NAME}.json`);
  const marker = path.join(themeRoot, MANAGED_THEME_MARKER);
  if (!fs.existsSync(themeFile) && !fs.existsSync(marker)) {
    return { removed: false, path: themeFile, reason: 'missing' };
  }
  if (fs.existsSync(themeFile) && !claudeThemeManaged(themeRoot)) {
    return { removed: false, path: themeFile, reason: 'unmanaged' };
  }
  if (!opts.dry_run) {
    try {
      fs.unlinkSync(themeFile);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    try {
      fs.unlinkSync(marker);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
  return { removed: true, path: themeFile, reason: '' };
}

function managedClaudeThemeSelected(settings) {
  return settings && typeof settings === 'object' && settings.theme === THEME_SETTING_VALUE;
}

function removeManagedClaudeThemeSelection(settings) {
  if (!managedClaudeThemeSelected(settings)) return false;
  delete settings.theme;
  return true;
}

function ensureManagedClaudeSkillGlobal(opts = {}) {
  const home = claudeHome();
  const skillRoot = path.join(home, 'skills');
  const removed = removeManagedClaudeSkillDir(skillRoot, opts);
  if (removed.reason === 'unmanaged' || removed.reason === 'not a directory') {
    throw new Error(`refusing to overwrite ${removed.reason} Claude skill: ${removed.path}`);
  }
  removeManagedClaudeCommand(path.join(home, 'commands'), opts);
  const skillFile = path.join(skillRoot, COMMAND_NAME, 'SKILL.md');
  if (!opts.dry_run) {
    writeTextAtomic(skillFile, managedClaudeSkillContent());
    writeTextAtomic(path.join(path.dirname(skillFile), MANAGED_SKILL_MARKER), `${claudeSkillFile(installRoot(), COMMAND_NAME)}\n`);
  }
  return skillFile;
}

function ensureManagedClaudeAgentsGlobal(opts = {}) {
  const agentRoot = path.join(claudeHome(), 'agents');
  const installed = [];
  for (const [name, source] of managedClaudeAgentSources()) {
    const dst = path.join(agentRoot, name);
    const marker = path.join(agentRoot, `${name}.${MANAGED_AGENT_MARKER}`);
    if (fs.existsSync(dst) && !fs.existsSync(marker)) {
      throw new Error(`refusing to overwrite unmanaged Claude agent: ${dst}`);
    }
    if (!opts.dry_run) {
      writeTextAtomic(dst, fs.readFileSync(source, 'utf8'));
      writeTextAtomic(marker, `${source}\n`);
    }
    installed.push(name.replace(/\.md$/, ''));
  }
  return installed;
}

function ensureHooks(opts = {}) {
  if (opts.dry_run) {
    const status = claudeStatus();
    if (!opts.quiet) {
      console.log(`[DRY-RUN] Would install Claude global hooks in ${status.settingsFile}`);
      console.log(`[DRY-RUN] Would install Claude skill at ${status.skillFile}`);
      if (status.themeManaged) console.log(`[DRY-RUN] Would remove XMux-managed Claude theme at ${status.themeFile}`);
      if (status.themeSelected) console.log(`[DRY-RUN] Would clear Claude theme ${THEME_SETTING_VALUE}`);
    }
    return 0;
  }
  const skillFile = ensureManagedClaudeSkillGlobal();
  const agents = ensureManagedClaudeAgentsGlobal();
  const settingsFile = path.join(claudeHome(), 'settings.json');
  const settings = readJson(settingsFile, {});
  const removedThemeSetting = removeManagedClaudeThemeSelection(settings);
  const removedTheme = removeManagedClaudeTheme(path.join(claudeHome(), 'themes'));
  const xmuxBin = fs.existsSync(path.join(installRoot(), 'bin', 'xmux'))
    ? path.join(installRoot(), 'bin', 'xmux')
    : 'xmux';
  const env = [
    `${HOOK_TAG_KEY}=${shellQuote(HOOK_TAG_VALUE)}`,
    `XMUX_INSTALL_DIR=${shellQuote(installRoot())}`,
  ].join(' ');
  ensureHookList(settings, 'SessionStart', `${env} ${shellQuote(xmuxBin)} claude hook session-start`);
  ensureHookList(settings, 'UserPromptSubmit', `${env} ${shellQuote(xmuxBin)} claude hook user-prompt`);
  ensureHookList(settings, 'UserPromptExpansion', `${env} ${shellQuote(xmuxBin)} claude hook user-prompt-expansion`);
  ensureHookList(settings, 'PreToolUse', `${env} ${shellQuote(xmuxBin)} claude hook pre-tool-use`, 'Agent|Task');
  ensureHookList(settings, 'SubagentStop', `${env} ${shellQuote(xmuxBin)} claude hook subagent-stop`);
  ensureHookList(settings, 'Stop', `${env} ${shellQuote(xmuxBin)} claude hook stop`);
  writeJson(settingsFile, settings);
  if (opts.quiet) return 0;
  if (opts.json) {
    console.log(JSON.stringify({
      status: 'ok',
      settings: settingsFile,
      skill: skillFile,
      agents,
      removedTheme: removedTheme.removed ? removedTheme.path : null,
      removedThemeSetting,
    }, null, 2));
  }
  else console.log(`[xmux] installed Claude hooks in ${settingsFile}`);
  return 0;
}

function removeManagedFileOrDir(filePath, marker, opts = {}) {
  if (!fs.existsSync(filePath)) return { removed: false, path: filePath, reason: 'missing' };
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.includes(marker)) return { removed: false, path: filePath, reason: 'unmanaged' };
  const target = opts.remove_dir ? path.dirname(filePath) : filePath;
  if (!opts.dry_run) fs.rmSync(target, { recursive: true, force: true });
  return { removed: true, path: target, reason: '' };
}

function cleanupProjectClaudeResidue(projectDir, opts = {}) {
  const root = projectDir ? abs(projectDir) : projectRoot();
  const claudeDir = path.join(root, '.claude');
  if (!fs.existsSync(claudeDir)) return { project: root, hooks: 0, commands: [], skills: [] };

  const settingsFile = path.join(claudeDir, 'settings.local.json');
  let hooks = 0;
  if (fs.existsSync(settingsFile)) {
    const settings = readJson(settingsFile, {});
    hooks = removeManagedClaudeHooks(settings);
    if (hooks && !opts.dry_run) writeJson(settingsFile, settings);
  }

  const command = removeManagedFileOrDir(
    path.join(claudeDir, 'commands', `${COMMAND_NAME}.md`),
    MANAGED_COMMAND_MARKER,
    opts,
  );
  const skillDir = path.join(claudeDir, 'skills', COMMAND_NAME);
  let skill = { removed: false, path: skillDir, reason: 'missing' };
  if (fs.existsSync(skillDir) && claudeSkillManaged(skillDir)) {
    if (!opts.dry_run) fs.rmSync(skillDir, { recursive: true, force: true });
    skill = { removed: true, path: skillDir, reason: '' };
  }
  return {
    project: root,
    hooks,
    commands: command.removed ? [command.path] : [],
    skills: skill.removed ? [skill.path] : [],
  };
}

function removeClaude(opts = {}) {
  const status = claudeStatus();
  const settings = readJson(status.settingsFile, {});
  const removedHooks = removeManagedClaudeHooks(settings);
  const removedThemeSetting = removeManagedClaudeThemeSelection(settings);
  const skill = removeManagedClaudeSkillDir(path.join(claudeHome(), 'skills'), opts);
  const theme = removeManagedClaudeTheme(path.join(claudeHome(), 'themes'), opts);
  const residue = cleanupProjectClaudeResidue(opts.project, opts);
  if (!opts.dry_run && (removedHooks || removedThemeSetting)) writeJson(status.settingsFile, settings);
  if (!opts.quiet) {
    const prefix = opts.dry_run ? '[DRY-RUN]' : '[OK]';
    console.log(`${prefix} Removed XMux-managed Claude hooks: ${removedHooks}`);
    console.log(`     Claude theme setting: ${removedThemeSetting ? 'removed' : 'not managed'}`);
    if (skill.removed) console.log(`     removed Claude skill: ${skill.path}`);
    else console.log(`     Claude skill: ${skill.reason}`);
    if (theme.removed) console.log(`     removed Claude theme: ${theme.path}`);
    else console.log(`     Claude theme: ${theme.reason}`);
    if (residue.hooks || residue.commands.length || residue.skills.length) {
      console.log(`     removed project-local Claude residue under ${residue.project}`);
    }
  }
  return 0;
}

function claudeStatus() {
  const settingsFile = path.join(claudeHome(), 'settings.json');
  const skillFile = path.join(claudeHome(), 'skills', COMMAND_NAME, 'SKILL.md');
  const themeFile = path.join(claudeHome(), 'themes', `${THEME_NAME}.json`);
  const settings = readJson(settingsFile, {});
  const themeSetting = typeof settings.theme === 'string' ? settings.theme : '';
  const hookCount = settings && settings.hooks && typeof settings.hooks === 'object'
    ? Object.values(settings.hooks)
      .flatMap((entries) => (Array.isArray(entries) ? entries : []))
      .flatMap((entry) => (entry && Array.isArray(entry.hooks) ? entry.hooks : []))
      .filter((hook) => isManagedClaudeHookCommand((hook || {}).command || ''))
      .length
    : 0;
  const skillManaged = claudeSkillManaged(path.dirname(skillFile));
  const themeManaged = fs.existsSync(themeFile) && claudeThemeManaged(path.dirname(themeFile));
  const themeSelected = themeSetting === THEME_SETTING_VALUE;
  return { settingsFile, skillFile, themeFile, themeSetting, hookCount, skillManaged, themeManaged, themeSelected };
}

function claudeDiagnostics() {
  const status = claudeStatus();
  const issues = [];
  const notes = [];
  if (status.hookCount >= 6) notes.push(['OK', `Claude global hooks installed in ${status.settingsFile}`]);
  else issues.push(`Claude global hooks missing or incomplete in ${status.settingsFile}`);
  if (status.skillManaged) notes.push(['OK', `Claude xmux-codex skill installed at ${status.skillFile}`]);
  else issues.push(`Claude xmux-codex skill missing or unmanaged at ${status.skillFile}`);
  if (status.themeManaged) issues.push(`Claude XMux custom theme is still managed at ${status.themeFile}`);
  else notes.push(['OK', 'Claude XMux custom theme is not managed']);
  if (status.themeSelected) issues.push(`Claude XMux custom theme is still selected in ${status.settingsFile}`);
  else notes.push(['OK', 'Claude theme is not forced by XMux']);
  return { status, issues, notes };
}

function doctorClaude(opts = {}) {
  const diagnostics = claudeDiagnostics();
  const { issues, notes } = diagnostics;
  if (opts.quiet) return issues.length ? 1 : 0;
  if (opts.json) {
    console.log(JSON.stringify({ status: issues.length ? 'fail' : 'ok', issues, notes }, null, 2));
  } else if (issues.length) {
    console.log('[FAIL] XMux Claude setup is incomplete');
    for (const issue of issues) console.log(`  - ${issue}`);
    for (const [level, note] of notes) console.log(`  - [${level}] ${note}`);
  } else {
    console.log('[OK] XMux Claude setup looks ready');
    for (const [level, note] of notes) console.log(`  - [${level}] ${note}`);
  }
  return issues.length ? 1 : 0;
}

function parseArgs(argv) {
  const opts = {
    _: [],
    doctor: false,
    remove: false,
    quiet: false,
    json: false,
    dry_run: false,
    project: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      opts._.push(arg);
      continue;
    }
    if (arg === '--doctor') opts.doctor = true;
    else if (arg === '--remove') opts.remove = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--dry-run') opts.dry_run = true;
    else if (arg === '--project' && i + 1 < argv.length) opts.project = argv[++i];
    else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  return opts;
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const command = opts._[0] || '';
  if (opts.doctor || command === 'doctor') return doctorClaude(opts);
  if (opts.remove || command === 'remove') return removeClaude(opts);
  if (command === 'ensure-hooks' || command === 'install-hooks' || command === '') return ensureHooks(opts);
  throw new Error(`unknown Claude setup command: ${command}`);
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`xmux claude setup: ${error && error.message ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  ensureHooks,
  removeClaude,
  claudeStatus,
  claudeDiagnostics,
  doctorClaude,
  removeManagedClaudeHooks,
  cleanupProjectClaudeResidue,
};
