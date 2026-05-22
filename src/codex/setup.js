#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { installedCodexSkillsDir } = require("../xmux/assets");

const RULE_BEGIN = "# XMUX_COMMAND_RULE_BEGIN";
const RULE_END = "# XMUX_COMMAND_RULE_END";
const CODEX_HOOK_TAG_KEY = "XMUX_HOOK_TAG";
const CODEX_HOOK_TAG_VALUE = "xmux-codex-harness";
const SKILL_MARKER = ".xmux-managed-skill";
const PUBLIC_SKILL_NAMES = ["xmux-claude", "xmux-send"];
const PUBLIC_SKILL_SET = new Set(PUBLIC_SKILL_NAMES);
const HOMEBREW_PREFIXES = ["/opt/homebrew", "/usr/local"];
const XMUX_HOMEBREW_FORMULAS = ["xmux", "xmux-beta"];

function expandUser(value) {
  const text = String(value || "");
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function abs(value) {
  return path.resolve(expandUser(value));
}

function readText(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function writeTextAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

function userError(message) {
  const error = new Error(message);
  error.user_error = true;
  return error;
}

function tomlQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseTomlAssignmentValue(line, key) {
  const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)\\s*$`));
  if (!match) return null;
  const raw = match[1].trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return raw.slice(1, -1);
    }
  }
  return null;
}

function xmuxRuntimeShellPath(installDir) {
  return path.join(abs(installDir), "runtime", "shell", "xmux.zsh");
}

function hasXmuxRuntime(installDir) {
  const root = abs(installDir);
  return fs.existsSync(xmuxRuntimeShellPath(root)) || fs.existsSync(path.join(root, "xmux.zsh"));
}

function stableHomebrewXmuxInstallDir(xmuxInstallDir) {
  const installDir = abs(xmuxInstallDir);
  const parts = installDir.split(path.sep);
  const cellarIndex = parts.lastIndexOf("Cellar");
  const formula = cellarIndex >= 0 ? parts[cellarIndex + 1] : "";
  if (
    !XMUX_HOMEBREW_FORMULAS.includes(formula)
    || !installDir.endsWith(`${path.sep}libexec`)
    || !hasXmuxRuntime(installDir)
  ) {
    return installDir;
  }
  const prefix = parts.slice(0, cellarIndex).join(path.sep) || path.sep;
  const candidate = path.join(prefix, "opt", formula, "libexec");
  return hasXmuxRuntime(candidate) ? candidate : installDir;
}

function homebrewXmuxInstallCandidates() {
  const candidates = [];
  for (const prefix of HOMEBREW_PREFIXES) {
    for (const formula of XMUX_HOMEBREW_FORMULAS) {
      candidates.push(path.join(prefix, "opt", formula, "libexec"));
    }
  }
  return candidates;
}

function resolveSetupXmuxInstallDir(explicitInstallDir, scriptInstallDir) {
  if (explicitInstallDir) return stableHomebrewXmuxInstallDir(explicitInstallDir);
  const scriptInstallRoot = stableHomebrewXmuxInstallDir(scriptInstallDir);
  if (hasXmuxRuntime(scriptInstallRoot)) return scriptInstallRoot;
  const envInstallDir = process.env.XMUX_INSTALL_DIR
    ? stableHomebrewXmuxInstallDir(process.env.XMUX_INSTALL_DIR)
    : "";
  if (envInstallDir && hasXmuxRuntime(envInstallDir)) return envInstallDir;
  for (const candidate of homebrewXmuxInstallCandidates()) {
    if (hasXmuxRuntime(candidate)) return candidate;
  }
  return scriptInstallRoot;
}

function resolvePathWithNode() {
  const nodeBinDir = path.dirname(fs.realpathSync(process.execPath));
  return [...new Set([nodeBinDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])].join(":");
}

function isLiveXmuxRuntimeBinPath(candidatePath, currentXmuxBin) {
  const expanded = abs(candidatePath);
  if (expanded === abs(currentXmuxBin)) return true;
  if (path.basename(expanded) !== "bin") return false;
  const installDir = path.dirname(expanded);
  return hasXmuxRuntime(installDir) && fs.existsSync(path.join(expanded, "xmux"));
}

function isHomebrewXmuxLibexecBinPath(candidatePath) {
  const expanded = abs(candidatePath);
  const parts = expanded.split(path.sep).filter(Boolean);
  const prefix = expanded.startsWith(path.sep) ? `${path.sep}${parts[0]}${path.sep}${parts[1]}` : "";
  if (!HOMEBREW_PREFIXES.includes(prefix)) return false;
  const rest = parts.slice(2);

  if (
    rest.length === 4
    && rest[0] === "opt"
    && XMUX_HOMEBREW_FORMULAS.includes(rest[1])
    && rest[2] === "libexec"
    && rest[3] === "bin"
  ) {
    return true;
  }

  return rest.length === 5
    && rest[0] === "Cellar"
    && XMUX_HOMEBREW_FORMULAS.includes(rest[1])
    && rest[3] === "libexec"
    && rest[4] === "bin";
}

function isXmuxOwnedBinPath(candidatePath, currentXmuxBin) {
  // Strip stale Homebrew Cellar/opt XMux bins left in Codex PATH after brew upgrades or uninstall.
  return isLiveXmuxRuntimeBinPath(candidatePath, currentXmuxBin)
    || isHomebrewXmuxLibexecBinPath(candidatePath);
}

function pathWithXmuxBin(xmuxInstallDir, basePath = null) {
  const xmuxBin = path.join(abs(xmuxInstallDir), "bin");
  const source = basePath == null ? resolvePathWithNode() : basePath;
  const parts = source.split(":").filter((part) => part && !isXmuxOwnedBinPath(part, xmuxBin));
  return [xmuxBin, ...parts].join(":");
}

function ensureCodexShellEnvironment(content, xmuxInstallDir) {
  const installDir = abs(xmuxInstallDir);
  const lines = content.split("\n");
  const header = "[shell_environment_policy.set]";
  let start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) {
    const block = [
      header,
      `PATH = ${tomlQuote(pathWithXmuxBin(installDir))}`,
      `XMUX_INSTALL_DIR = ${tomlQuote(installDir)}`,
    ].join("\n");
    return content.trim() ? `${content.trimEnd()}\n\n${block}\n` : `${block}\n`;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const stripped = lines[i].trim();
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      end = i;
      break;
    }
  }

  let seenPath = false;
  let seenInstall = false;
  for (let i = start + 1; i < end; i += 1) {
    const stripped = lines[i].trim();
    const key = stripped.includes("=") ? stripped.split("=", 1)[0].trim() : "";
    if (key === "PATH") {
      const current = parseTomlAssignmentValue(stripped, "PATH");
      lines[i] = `PATH = ${tomlQuote(pathWithXmuxBin(installDir, current == null ? resolvePathWithNode() : current))}`;
      seenPath = true;
    } else if (key === "XMUX_INSTALL_DIR") {
      lines[i] = `XMUX_INSTALL_DIR = ${tomlQuote(installDir)}`;
      seenInstall = true;
    }
  }
  const inserts = [];
  if (!seenPath) inserts.push(`PATH = ${tomlQuote(pathWithXmuxBin(installDir))}`);
  if (!seenInstall) inserts.push(`XMUX_INSTALL_DIR = ${tomlQuote(installDir)}`);
  if (inserts.length) lines.splice(start + 1, 0, ...inserts);
  return `${lines.join("\n").trimEnd()}\n`;
}

function removeCodexShellEnvironment(content, xmuxInstallDir) {
  const lines = content.split("\n");
  const header = "[shell_environment_policy.set]";
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return content;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const stripped = lines[i].trim();
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      end = i;
      break;
    }
  }

  const installBin = path.join(abs(xmuxInstallDir), "bin");
  const sectionLines = [];
  for (const line of lines.slice(start + 1, end)) {
    const stripped = line.trim();
    const key = stripped.includes("=") ? stripped.split("=", 1)[0].trim() : "";
    if (key === "XMUX_INSTALL_DIR") continue;
    if (key === "PATH") {
      const current = parseTomlAssignmentValue(stripped, "PATH");
      if (current != null) {
        const parts = current.split(":").filter((part) => part && !isXmuxOwnedBinPath(part, installBin));
        if (parts.length) sectionLines.push(`PATH = ${tomlQuote(parts.join(":"))}`);
        continue;
      }
    }
    sectionLines.push(line);
  }

  if (sectionLines.some((line) => line.trim())) lines.splice(start + 1, end - start - 1, ...sectionLines);
  else lines.splice(start, end - start);
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function removeTomlBlocks(content, matcher) {
  const lines = content.split("\n");
  const out = [];
  let skip = false;
  for (const line of lines) {
    const stripped = line.trim();
    if (matcher(stripped)) {
      skip = true;
      continue;
    }
    if (skip && stripped.startsWith("[") && !matcher(stripped)) skip = false;
    if (!skip) out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

function removeObsoleteXmuxConfig(content) {
  content = removeTomlBlocks(content, (stripped) => stripped.startsWith("[mcp_servers.xmux_lead"));
  content = removeTomlBlocks(content, (stripped) => stripped.startsWith("[mcp_servers.amux_lead"));
  content = removeTomlBlocks(content, (stripped) => stripped === "[marketplaces.xmux-local]" || stripped === "[marketplaces.amux-local]");
  content = removeTomlBlocks(content, (stripped) => stripped === '[plugins."xmux@xmux-local"]' || stripped === '[plugins."amux@amux-local"]');
  return content;
}

function removeMarkerBlock(content, begin, end) {
  const lines = content.split("\n");
  const out = [];
  let skip = false;
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped === begin) {
      skip = true;
      continue;
    }
    if (skip && stripped === end) {
      skip = false;
      continue;
    }
    if (!skip) out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

function codexHome(configPath) {
  return path.dirname(abs(configPath));
}

function rulesPath(configPath) {
  return path.join(codexHome(configPath), "rules", "default.rules");
}

function hooksPath(configPath) {
  return path.join(codexHome(configPath), "hooks.json");
}

function pluginCacheRoot(configPath) {
  return path.join(codexHome(configPath), "plugins", "cache");
}

function skillsRoot(configPath) {
  return path.join(os.homedir(), ".agents", "skills");
}

function legacyCodexSkillsRoot(configPath) {
  return path.join(codexHome(configPath), "skills");
}

function installXmuxCommandRule(configPath) {
  const filePath = rulesPath(configPath);
  let content = removeMarkerBlock(readText(filePath), RULE_BEGIN, RULE_END);
  const block = [
    RULE_BEGIN,
    "# Allow the scoped XMux wrapper command; user intent and XMux wrappers control operation scope.",
    'prefix_rule(pattern=["xmux"], decision="allow")',
    RULE_END,
  ].join("\n");
  content = content.trim() ? `${content.trimEnd()}\n\n${block}\n` : `${block}\n`;
  writeTextAtomic(filePath, content);
}

function removeXmuxCommandRule(configPath) {
  const filePath = rulesPath(configPath);
  const content = removeMarkerBlock(readText(filePath), RULE_BEGIN, RULE_END);
  writeTextAtomic(filePath, content ? `${content}\n` : "");
}

function isXmuxManagedSkill(candidatePath) {
  return fs.existsSync(candidatePath)
    && fs.statSync(candidatePath).isDirectory()
    && fs.existsSync(path.join(candidatePath, SKILL_MARKER));
}

function skillPathStatus(candidatePath) {
  try {
    const stat = fs.lstatSync(candidatePath);
    return {
      exists: true,
      is_symlink: stat.isSymbolicLink(),
      is_dir: stat.isDirectory(),
      managed: !stat.isSymbolicLink() && stat.isDirectory() && fs.existsSync(path.join(candidatePath, SKILL_MARKER)),
    };
  } catch (_) {
    return { exists: false, is_symlink: false, is_dir: false, managed: false };
  }
}

function xmuxSkillSources(xmuxInstallDir, skillsDir = "") {
  const base = skillsDir ? abs(skillsDir) : installedCodexSkillsDir(xmuxInstallDir);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return [];
  return fs.readdirSync(base)
    .sort()
    .filter((name) => PUBLIC_SKILL_SET.has(name))
    .map((name) => [name, path.join(base, name)])
    .filter(([, source]) => fs.existsSync(path.join(source, "SKILL.md")));
}

function pruneObsoleteXmuxSkills(root, opts = {}) {
  const removed = [];
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return removed;
  for (const name of fs.readdirSync(root).sort()) {
    if (!name.startsWith("xmux-") || PUBLIC_SKILL_SET.has(name)) continue;
    const candidate = path.join(root, name);
    if (!isXmuxManagedSkill(candidate)) continue;
    if (!opts.dry_run) fs.rmSync(candidate, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

function xmuxVersionFromInstallDir(xmuxInstallDir) {
  const content = readText(xmuxRuntimeShellPath(xmuxInstallDir));
  const match = content.match(/^XMUX_VERSION=["']([^"']+)["']/m);
  return match ? match[1] : "";
}

function installXmuxSkills(configPath, xmuxInstallDir, opts = {}) {
  const root = skillsRoot(configPath);
  const sources = xmuxSkillSources(xmuxInstallDir, opts.skills_dir || "");
  const installed = [];
  const skipped = [];
  const force = Boolean(opts.force || opts.refresh);
  const dryRun = Boolean(opts.dry_run);
  const removed = pruneObsoleteXmuxSkills(root, { dry_run: dryRun });

  for (const [name, source] of sources) {
    const dst = path.join(root, name);
    const status = skillPathStatus(dst);
    if (status.exists) {
      if (status.is_symlink) {
        if (!dryRun) fs.unlinkSync(dst);
      } else if (!status.is_dir) {
        skipped.push({ name, reason: "existing non-directory path" });
        continue;
      } else if (!status.managed) {
        skipped.push({ name, reason: "existing non-XMux skill" });
        continue;
      } else if (!force) {
        skipped.push({ name, reason: "already installed" });
        continue;
      }
    }
    if (!dryRun) {
      fs.rmSync(dst, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });
      fs.cpSync(source, dst, { recursive: true });
      writeTextAtomic(path.join(dst, SKILL_MARKER), `${abs(source)}\n`);
    }
    installed.push(name);
  }
  return { installed, skipped, removed, source_count: sources.length };
}

function removeXmuxSkills(configPath, opts = {}) {
  const root = skillsRoot(configPath);
  const removed = [];
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return removed;
  for (const name of fs.readdirSync(root).sort()) {
    if (!name.startsWith("xmux-")) continue;
    const candidate = path.join(root, name);
    const status = skillPathStatus(candidate);
    if (!status.is_symlink && !status.managed) continue;
    if (!opts.dry_run) fs.rmSync(candidate, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

function removeLegacyCodexSkills(configPath, opts = {}) {
  const root = legacyCodexSkillsRoot(configPath);
  const removed = [];
  const warnings = [];
  const manifest = path.join(root, ".xmux-skills.json");
  if (fs.existsSync(manifest)) {
    if (!opts.dry_run) fs.rmSync(manifest, { force: true });
    removed.push(manifest);
  }
  for (const name of PUBLIC_SKILL_NAMES) {
    const candidate = path.join(root, name);
    const status = skillPathStatus(candidate);
    if (!status.exists) continue;
    if (status.is_symlink || status.managed) {
      if (!opts.dry_run) fs.rmSync(candidate, { recursive: true, force: true });
      removed.push(candidate);
    } else {
      warnings.push(`legacy Codex skill exists but is unmanaged: ${candidate}`);
    }
  }
  return { removed, warnings };
}

function hookSubcommandForEvent(eventName) {
  return eventName === "Stop" ? "stop" : "user-prompt";
}

function isManagedCodexHookCommand(command, eventName = "") {
  const text = String(command || "");
  const hasTag = text.includes(CODEX_HOOK_TAG_KEY) && text.includes(CODEX_HOOK_TAG_VALUE);
  if (!eventName) return hasTag && text.includes(" codex hook ");
  return hasTag && text.includes(` codex hook ${hookSubcommandForEvent(eventName)}`);
}

function removeXmuxCodexHooksFromConfig(config) {
  if (!config || typeof config !== "object" || !config.hooks || typeof config.hooks !== "object") return 0;
  let removed = 0;
  for (const eventName of Object.keys(config.hooks)) {
    const current = Array.isArray(config.hooks[eventName]) ? config.hooks[eventName] : [];
    const filtered = current
      .map((entry) => {
        if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) return entry;
        const hooks = entry.hooks.filter((hook) => {
          const managed = isManagedCodexHookCommand((hook || {}).command || "", eventName);
          if (managed) removed += 1;
          return !managed;
        });
        return { ...entry, hooks };
      })
      .filter((entry) => !entry || !Array.isArray(entry.hooks) || entry.hooks.length > 0);
    if (filtered.length) config.hooks[eventName] = filtered;
    else delete config.hooks[eventName];
  }
  if (Object.keys(config.hooks).length === 0) delete config.hooks;
  return removed;
}

function removeXmuxCodexHooks(configPath, opts = {}) {
  const filePath = hooksPath(configPath);
  const config = readJson(filePath, null);
  if (!config) return 0;
  const removed = removeXmuxCodexHooksFromConfig(config);
  if (removed && !opts.dry_run) writeJson(filePath, config);
  return removed;
}

function codexHooksHaveXmux(configPath) {
  const config = readJson(hooksPath(configPath), null);
  const hooks = config && config.hooks && typeof config.hooks === "object" ? config.hooks : {};
  return ["UserPromptSubmit", "Stop"].every((eventName) => (
    Array.isArray(hooks[eventName])
      && hooks[eventName].some((entry) => (
        entry && Array.isArray(entry.hooks)
          && entry.hooks.some((hook) => isManagedCodexHookCommand((hook || {}).command || "", eventName))
      ))
  ));
}

function commandTokens(command) {
  return String(command || "").match(/"[^"]*"|'[^']*'|\S+/g) || [];
}

function stripCommandQuotes(token) {
  const text = String(token || "");
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1);
  }
  return text;
}

function executableToken(command) {
  for (const token of commandTokens(command)) {
    const text = stripCommandQuotes(token);
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) return text;
  }
  return "";
}

function hookCommandBasename(command) {
  const token = executableToken(command);
  return token ? path.basename(token) : "";
}

function collectHookRecords(config, sourceFile) {
  const records = [];
  const hooks = config && config.hooks && typeof config.hooks === "object" ? config.hooks : {};
  for (const eventName of Object.keys(hooks)) {
    const entries = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
    for (const entry of entries) {
      const matcher = String((entry || {}).matcher || "");
      const commands = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
      for (const hook of commands) {
        const command = String((hook || {}).command || "").trim();
        if (!command) continue;
        records.push({
          eventName,
          matcher,
          command,
          executable: executableToken(command),
          basename: hookCommandBasename(command),
          sourceFile,
        });
      }
    }
  }
  return records;
}

function findFilesNamed(root, fileName) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name === fileName) found.push(fullPath);
    }
  }
  return found.sort();
}

function codexPluginHookDiagnostics(configPath) {
  const warnings = [];
  const globalHookFile = hooksPath(configPath);
  const globalRecords = collectHookRecords(readJson(globalHookFile, null), globalHookFile);
  const globalBySignature = new Map();
  for (const record of globalRecords) {
    if (!record.basename) continue;
    const key = [record.eventName, record.basename].join("\0");
    if (!globalBySignature.has(key)) globalBySignature.set(key, record);
  }

  const emitted = new Set();
  for (const hookFile of findFilesNamed(pluginCacheRoot(configPath), "hooks.json")) {
    const pluginRecords = collectHookRecords(readJson(hookFile, null), hookFile);
    for (const record of pluginRecords) {
      if (record.executable.startsWith("./") || record.executable.startsWith("../")) {
        const key = `relative\0${hookFile}\0${record.command}`;
        if (!emitted.has(key)) {
          warnings.push(`Codex plugin cache hook uses a relative command that can exit 127: ${hookFile}: ${record.command}`);
          emitted.add(key);
        }
      }
      if (!record.basename) continue;
      const signature = [record.eventName, record.basename].join("\0");
      const global = globalBySignature.get(signature);
      if (global) {
        const key = `duplicate\0${hookFile}\0${signature}`;
        if (!emitted.has(key)) {
          warnings.push(`Codex hook appears in both global hooks and plugin cache: ${record.eventName} command "${record.basename}" (${global.sourceFile} and ${hookFile})`);
          emitted.add(key);
        }
      }
    }
  }
  return warnings;
}

function contentHasShellEnvironment(content, xmuxInstallDir) {
  const installBin = path.join(abs(xmuxInstallDir), "bin");
  return content.includes("[shell_environment_policy.set]")
    && content.includes(`XMUX_INSTALL_DIR = "${abs(xmuxInstallDir)}"`)
    && content.includes(installBin);
}

function rulesHaveXmuxCommand(configPath) {
  const content = readText(rulesPath(configPath));
  return content.includes(RULE_BEGIN)
    && content.includes(RULE_END)
    && content.includes('prefix_rule(pattern=["xmux"], decision="allow")');
}

function installedSkillNames(configPath) {
  const root = skillsRoot(configPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return new Set();
  return new Set(
    fs.readdirSync(root)
      .filter((name) => fs.existsSync(path.join(root, name, "SKILL.md")))
      .filter((name) => isXmuxManagedSkill(path.join(root, name))),
  );
}

function codexDiagnostics(configPath, xmuxInstallDir, skillsDir = "") {
  const content = readText(configPath);
  const issues = [];
  const notes = [];
  const warnings = codexPluginHookDiagnostics(configPath);

  if (!fs.existsSync(configPath)) issues.push(`missing config: ${configPath}`);
  else notes.push(["OK", "Codex config exists"]);

  if (contentHasShellEnvironment(content, xmuxInstallDir)) notes.push(["OK", "Codex shell PATH includes XMux bin"]);
  else issues.push("Codex shell PATH/XMUX_INSTALL_DIR setup is missing or stale");

  if (rulesHaveXmuxCommand(configPath)) notes.push(["OK", `scoped xmux command rule exists in ${rulesPath(configPath)}`]);
  else issues.push("scoped xmux command rule is missing");

  if (codexHooksHaveXmux(configPath)) notes.push(["OK", `Codex global hooks installed in ${hooksPath(configPath)}`]);
  else issues.push(`Codex global hooks are missing or incomplete in ${hooksPath(configPath)}`);

  const sourceNames = new Set(xmuxSkillSources(xmuxInstallDir, skillsDir).map(([name]) => name));
  const installedNames = installedSkillNames(configPath);
  const missing = [...sourceNames].filter((name) => !installedNames.has(name)).sort();
  if (missing.length) issues.push(`missing XMux Codex skills: ${missing.join(", ")}`);
  else notes.push(["OK", `XMux Codex skills installed under ${skillsRoot(configPath)}`]);

  return { issues, notes, warnings };
}

function doctorCodex(configPath, xmuxInstallDir, skillsDir = "", quiet = false) {
  const { issues, notes, warnings } = codexDiagnostics(configPath, xmuxInstallDir, skillsDir);

  if (quiet) return issues.length ? 1 : 0;
  if (issues.length) {
    console.log("[FAIL] XMux Codex setup is incomplete");
    for (const issue of issues) console.log(`  - ${issue}`);
    for (const warning of warnings) console.log(`  - [WARN] ${warning}`);
    for (const [level, note] of notes) console.log(`  - [${level}] ${note}`);
    console.log("Run: xmux setup-xmux");
    return 1;
  }
  console.log("[OK] XMux Codex setup looks ready");
  for (const [level, note] of notes) console.log(`  - [${level}] ${note}`);
  for (const warning of warnings) console.log(`  - [WARN] ${warning}`);
  return 0;
}

function parseArgs(argv) {
  const opts = {
    remove: false,
    doctor: false,
    quiet: false,
    with_skills: false,
    skip_skills: false,
    skills_dir: "",
    ref: "",
    force: false,
    refresh: false,
    dry_run: false,
    home: "",
    project: "",
    xmux_install_dir: "",
  };
  for (let i = 0; i < argv.length;) {
    const arg = argv[i];
    if (arg === "--remove") { opts.remove = true; i += 1; }
    else if (arg === "--doctor") { opts.doctor = true; i += 1; }
    else if (arg === "--quiet") { opts.quiet = true; i += 1; }
    else if (arg === "--with-skills") { opts.with_skills = true; i += 1; }
    else if (arg === "--without-skills") { opts.skip_skills = true; i += 1; }
    else if (arg === "--force") { opts.force = true; i += 1; }
    else if (arg === "--refresh") { opts.refresh = true; opts.force = true; i += 1; }
    else if (arg === "--dry-run") { opts.dry_run = true; i += 1; }
    else if (["--skills-dir", "--ref", "--home", "--project", "--xmux-install-dir"].includes(arg) && i + 1 < argv.length) {
      opts[arg.slice(2).replace(/-/g, "_")] = expandUser(argv[i + 1]);
      i += 2;
    } else if (arg.startsWith("--mcp") || arg === "--cache-mcp" || arg === "--no-cache-mcp" || arg === "--from-github" || arg === "--server-path") {
      throw userError(`${arg} was removed; XMux 2.x uses Codex-Claude hooks and bundled assets only`);
    } else {
      throw userError(`unknown or incomplete argument: ${arg}`);
    }
  }
  return opts;
}

function defaultProjectDir() {
  let current = process.cwd();
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, ".git"))) return abs(current);
    current = path.dirname(current);
  }
  return abs(process.cwd());
}

function resolveConfigPath(opts) {
  if (opts.home && opts.project) throw userError("--home and --project are mutually exclusive");
  if (opts.home) return path.join(expandUser(opts.home), "config.toml");
  if (opts.project) return path.join(abs(opts.project), ".codex", "config.toml");
  return path.join(os.homedir(), ".codex", "config.toml");
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const configPath = resolveConfigPath(opts);
  const scriptInstallDir = path.dirname(path.dirname(path.dirname(abs(__filename))));
  const xmuxInstallDir = resolveSetupXmuxInstallDir(opts.xmux_install_dir, scriptInstallDir);

  if (opts.remove) {
    let content = removeObsoleteXmuxConfig(readText(configPath));
    content = removeCodexShellEnvironment(content, xmuxInstallDir);
    if (!opts.dry_run) {
      removeXmuxCommandRule(configPath);
    }
    const removedHooks = removeXmuxCodexHooks(configPath, { dry_run: opts.dry_run });
    const removedSkills = opts.with_skills ? removeXmuxSkills(configPath, { dry_run: opts.dry_run }) : [];
    if (!opts.dry_run) writeTextAtomic(configPath, content);
    console.log(`${opts.dry_run ? "[DRY-RUN]" : "[OK]"} Removed XMux Codex config from ${configPath}`);
    if (removedHooks) console.log(`     removed hooks: ${removedHooks}`);
    if (removedSkills.length) console.log(`     removed skills: ${removedSkills.join(", ")}`);
    return 0;
  }

  if (opts.doctor) return doctorCodex(configPath, xmuxInstallDir, opts.skills_dir, opts.quiet);

  let content = readText(configPath);
  const globalConfig = path.join(os.homedir(), ".codex", "config.toml");
  if (opts.project && !content.trim() && abs(globalConfig) !== abs(configPath)) {
    content = readText(globalConfig);
  }

  content = ensureCodexShellEnvironment(content, xmuxInstallDir);
  if (!opts.dry_run) writeTextAtomic(configPath, content);

  const shouldInstallSkills = !opts.skip_skills
    && (opts.with_skills || opts.skills_dir || process.env.XMUX_CODEX_SKILLS_DIR);
  const skillResult = shouldInstallSkills
    ? installXmuxSkills(configPath, xmuxInstallDir, {
      skills_dir: opts.skills_dir || process.env.XMUX_CODEX_SKILLS_DIR || "",
      xmux_version: xmuxVersionFromInstallDir(xmuxInstallDir),
      force: opts.force,
      refresh: opts.refresh,
      dry_run: opts.dry_run,
      ref: opts.ref,
    })
    : { installed: [], skipped: [] };

  if (!opts.dry_run) installXmuxCommandRule(configPath);

  console.log(`${opts.dry_run ? "[DRY-RUN]" : "[OK]"} Wrote XMux Codex shell integration to ${configPath}`);
  console.log(`     xmux_install_dir: ${xmuxInstallDir}`);
  console.log(`     xmux_project_dir: ${defaultProjectDir()}`);
  console.log("     xmux_state_dir: inherited from xmux-launched Codex runtime");
  if (skillResult.installed.length) console.log(`     skills: ${skillResult.installed.join(", ")}`);
  else if (shouldInstallSkills && skillResult.skipped.length) console.log("     skills: no changes");
  else if (shouldInstallSkills) console.log("     skills: no importable XMux skills found");
  if (skillResult.removed && skillResult.removed.length) console.log(`     removed obsolete skills: ${skillResult.removed.join(", ")}`);
  for (const item of skillResult.skipped) console.log(`     skipped ${item.name}: ${item.reason}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (error && error.user_error) console.error(`error: ${error.message}`);
    else console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  codexDiagnostics,
  codexPluginHookDiagnostics,
  ensureCodexShellEnvironment,
  removeCodexShellEnvironment,
  pathWithXmuxBin,
  isXmuxOwnedBinPath,
  installXmuxCommandRule,
  removeXmuxCommandRule,
  removeXmuxCodexHooksFromConfig,
  removeLegacyCodexSkills,
  resolveConfigPath,
  skillsRoot,
  legacyCodexSkillsRoot,
};
