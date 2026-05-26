'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function expandUser(value) {
  const text = String(value || '');
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return text;
}

function abs(value) {
  return path.resolve(expandUser(value));
}

function codexSkillsDir(installRoot) {
  return path.join(abs(installRoot), 'assets', 'codex', 'skills');
}

function claudeSkillsDir(installRoot) {
  return path.join(abs(installRoot), 'assets', 'claude', 'skills');
}

function claudeAgentsDir(installRoot) {
  return path.join(abs(installRoot), 'assets', 'claude', 'agents');
}

function claudeSkillFile(installRoot, name = 'xmux-codex') {
  return path.join(claudeSkillsDir(installRoot), name, 'SKILL.md');
}

function firstExistingDir(candidates) {
  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
    } catch (_) {
      return false;
    }
  }) || '';
}

function codexSkillSourceCandidates(installRoot) {
  return [
    codexSkillsDir(installRoot),
  ];
}

function installedCodexSkillsDir(installRoot) {
  return firstExistingDir(codexSkillSourceCandidates(installRoot)) || codexSkillsDir(installRoot);
}

function githubCodexSkillsDir(extractedRoot) {
  return firstExistingDir(codexSkillSourceCandidates(extractedRoot));
}

module.exports = {
  codexSkillsDir,
  claudeSkillsDir,
  claudeAgentsDir,
  claudeSkillFile,
  installedCodexSkillsDir,
  githubCodexSkillsDir,
};
