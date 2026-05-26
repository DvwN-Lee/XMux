'use strict';

const LINEAGES = new Set(['codex', 'claude']);

const PHASES = {
  'claude:review': {
    lineage: 'claude',
    phase: 'review',
    marker_name: 'xmux-claude-review',
    required_agent: 'xmux-review',
  },
  'claude:review-recheck': {
    lineage: 'claude',
    phase: 'review-recheck',
    marker_name: 'xmux-claude-review-recheck',
    required_agent: 'xmux-review',
  },
  'claude:plan-critique': {
    lineage: 'claude',
    phase: 'plan-critique',
    marker_name: 'xmux-claude-plan-critique',
    required_agent: 'xmux-plan-critique',
  },
  'claude:verification-contract': {
    lineage: 'claude',
    phase: 'verification-contract',
    marker_name: 'xmux-claude-verification-contract',
    required_agent: 'xmux-verification-contract',
  },
  'claude:final-signoff': {
    lineage: 'claude',
    phase: 'final-signoff',
    marker_name: 'xmux-claude-final-signoff',
    required_agent: 'xmux-final-signoff',
  },
  'claude:stuck': {
    lineage: 'claude',
    phase: 'stuck',
    marker_name: 'xmux-claude-stuck',
    required_agent: 'xmux-stuck',
  },
  'codex:implement-core': {
    lineage: 'codex',
    phase: 'implement-core',
    marker_name: 'xmux-codex-implement-core',
    required_agent: 'xmux-implement-core',
  },
  'codex:verify': {
    lineage: 'codex',
    phase: 'verify',
    marker_name: 'xmux-codex-verify',
    required_agent: 'xmux-verify',
  },
  'codex:fixup': {
    lineage: 'codex',
    phase: 'fixup',
    marker_name: 'xmux-codex-fixup',
    required_agent: 'xmux-fixup',
  },
  'codex:finalize': {
    lineage: 'codex',
    phase: 'finalize',
    marker_name: 'xmux-codex-finalize',
    required_agent: 'xmux-finalize',
  },
};

function registryKey(lineage, phase) {
  const target = String(lineage || '').trim();
  const name = String(phase || '').trim();
  if (!LINEAGES.has(target)) throw new Error(`lineage must be one of: ${[...LINEAGES].join(', ')}`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('phase must be a lower-kebab identifier');
  return `${target}:${name}`;
}

function phaseEntry(lineage, phase) {
  return PHASES[registryKey(lineage, phase)] || null;
}

function phaseMarker(lineage, phase) {
  const entry = phaseEntry(lineage, phase);
  if (!entry) throw new Error(`unknown XMux phase: ${lineage}:${phase}`);
  return `[${entry.marker_name}]`;
}

function markerEntry(markerName) {
  const clean = String(markerName || '').replace(/^\[/, '').replace(/\]$/, '').trim();
  return Object.values(PHASES).find((entry) => entry.marker_name === clean) || null;
}

function parsePhaseMarker(input = {}) {
  const prompt = String(input.prompt || '').trim();
  const match = prompt.match(/^\[(xmux-(codex|claude)-([a-z0-9][a-z0-9-]*))\](?:\s|$)/);
  if (!match) return null;
  const marker_name = match[1];
  const entry = markerEntry(marker_name);
  if (!entry) return null;
  const marker = `[${marker_name}]`;
  const body = prompt === marker ? '' : prompt.slice(marker.length).trimStart().trimEnd();
  return {
    ...entry,
    marker,
    body,
  };
}

function allPhaseEntries() {
  return Object.values(PHASES).map((entry) => ({ ...entry }));
}

module.exports = {
  PHASES,
  phaseEntry,
  phaseMarker,
  markerEntry,
  parsePhaseMarker,
  allPhaseEntries,
};
