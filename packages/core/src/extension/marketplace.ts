/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionConfig } from './extensionManager.js';
import type { ExtensionInstallMetadata } from '../config/config.js';
import type { ClaudeMarketplaceConfig } from './claude-converter.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import { stat } from 'node:fs/promises';
import { parseGitHubRepoForReleases } from './github.js';

export interface MarketplaceInstallOptions {
  marketplaceUrl: string;
  pluginName: string;
  tempDir: string;
  requestConsent: (consent: string) => Promise<boolean>;
}

export interface MarketplaceInstallResult {
  config: ExtensionConfig;
  sourcePath: string;
  installMetadata: ExtensionInstallMetadata;
}

/**
 * Intercept web URLs and extract the exact installation command using Regex.
 * Implements a dynamic scraper with zero hardcoded assumptions.
 */
async function interceptWebUrl(
  url: string,
): Promise<ExtensionInstallMetadata | null> {
  if (!url.includes('claudemarketplaces.com') && !url.includes('smithery.ai')) {
    return null;
  }

  const content = await fetchUrl(url, { 'User-Agent': 'qwen-code' });
  if (!content) {
    throw new Error(
      'UnresolvableMarketplaceError: Failed to fetch the marketplace page content',
    );
  }

  // Pattern 1: Skills CLI (npx skills add <url> [--skill <name>])
  const skillsRegex =
    /npx\s+skills\s+add\s+(https:\/\/github\.com\/[^\s'"]+)(?:\s+--skill\s+([a-zA-Z0-9_-]+))?/;
  const skillsMatch = content.match(skillsRegex);
  if (skillsMatch) {
    return {
      source: skillsMatch[1],
      type: 'git',
      pluginName: skillsMatch[2],
    };
  }

  // Pattern 2: Claude MCP (claude mcp add <name> <command>)
  const claudeMcpRegex = /claude\s+mcp\s+add\s+([a-zA-Z0-9_-]+)\s+([^'"]+)/;
  const claudeMcpMatch = content.match(claudeMcpRegex);
  if (claudeMcpMatch) {
    // If the command starts with npx, extract the package name
    const cmd = claudeMcpMatch[2].trim();
    const npxCmdRegex = /npx\s+(?:-y\s+)?([@a-zA-Z0-9_\-/]+)/;
    const npxCmdMatch = cmd.match(npxCmdRegex);

    return {
      source: npxCmdMatch ? npxCmdMatch[1] : cmd,
      type: 'npm',
      pluginName: claudeMcpMatch[1],
    };
  }

  // Pattern 3: Raw NPX (npx -y <package>)
  const npxRegex = /npx\s+-y\s+([@a-zA-Z0-9_\-/]+)/;
  const npxMatch = content.match(npxRegex);
  if (npxMatch) {
    return {
      source: npxMatch[1],
      type: 'npm',
    };
  }

  throw new Error(
    'UnresolvableMarketplaceError: Cannot detect a valid Claude Code, Skill, or MCP installation command on this page.',
  );
}

/**
 * Parse the install source string into repo and optional pluginName.
 * Format: <repo>:<pluginName> where pluginName is optional
 */
function parseSourceAndPluginName(source: string): {
  repo: string;
  pluginName?: string;
} {
  const urlSchemes = ['http://', 'https://', 'git@', 'sso://', 'npm:'];

  let repoEndIndex = source.length;
  let hasPluginName = false;

  for (const scheme of urlSchemes) {
    if (source.startsWith(scheme)) {
      const afterScheme = source.substring(scheme.length);
      const lastColonIndex = afterScheme.lastIndexOf(':');
      if (lastColonIndex !== -1) {
        const potentialPluginName = afterScheme.substring(lastColonIndex + 1);
        if (
          potentialPluginName &&
          !potentialPluginName.includes('/') &&
          !/^\d+/.test(potentialPluginName)
        ) {
          repoEndIndex = scheme.length + lastColonIndex;
          hasPluginName = true;
        }
      }
      break;
    }
  }

  if (
    repoEndIndex === source.length &&
    !urlSchemes.some((s) => source.startsWith(s))
  ) {
    const lastColonIndex = source.lastIndexOf(':');
    if (lastColonIndex > 1) {
      repoEndIndex = lastColonIndex;
      hasPluginName = true;
    }
  }

  if (hasPluginName) {
    return {
      repo: source.substring(0, repoEndIndex),
      pluginName: source.substring(repoEndIndex + 1),
    };
  }

  return { repo: source };
}

function isOwnerRepoFormat(source: string): boolean {
  const ownerRepoRegex = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
  return ownerRepoRegex.test(source);
}

function convertOwnerRepoToGitHubUrl(ownerRepo: string): string {
  return `https://github.com/${ownerRepo}`;
}

function isGitUrl(source: string): boolean {
  return (
    source.startsWith('http://') ||
    source.startsWith('https://') ||
    source.startsWith('git@') ||
    source.startsWith('sso://')
  );
}

function fetchUrl(
  url: string,
  headers: Record<string, string>,
): Promise<string | null> {
  return new Promise((resolve) => {
    https
      .get(url, { headers }, (res) => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve(Buffer.concat(chunks).toString());
        });
      })
      .on('error', () => resolve(null));
  });
}

async function fetchGitHubMarketplaceConfig(
  owner: string,
  repo: string,
): Promise<ClaudeMarketplaceConfig | null> {
  const token = process.env['GITHUB_TOKEN'];
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/.claude-plugin/marketplace.json`;
  const apiHeaders: Record<string, string> = {
    'User-Agent': 'qwen-code',
    Accept: 'application/vnd.github.v3.raw',
  };
  if (token) {
    apiHeaders['Authorization'] = `token ${token}`;
  }

  let content = await fetchUrl(apiUrl, apiHeaders);
  if (!content) {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/.claude-plugin/marketplace.json`;
    content = await fetchUrl(rawUrl, { 'User-Agent': 'qwen-code' });
  }

  if (!content) return null;
  try {
    return JSON.parse(content) as ClaudeMarketplaceConfig;
  } catch {
    return null;
  }
}

async function readLocalMarketplaceConfig(
  localPath: string,
): Promise<ClaudeMarketplaceConfig | null> {
  const marketplaceConfigPath = path.join(
    localPath,
    '.claude-plugin',
    'marketplace.json',
  );
  try {
    const content = await fs.promises.readFile(marketplaceConfigPath, 'utf-8');
    return JSON.parse(content) as ClaudeMarketplaceConfig;
  } catch {
    return null;
  }
}

export async function parseInstallSource(
  source: string,
): Promise<ExtensionInstallMetadata> {
  if (source.startsWith('npm:')) {
    return {
      source: source.substring(4),
      type: 'npm',
    };
  }

  const { repo, pluginName } = parseSourceAndPluginName(source);

  const intercepted = await interceptWebUrl(repo);
  if (intercepted) {
    return {
      ...intercepted,
      pluginName: pluginName || intercepted.pluginName,
    };
  }

  let installMetadata: ExtensionInstallMetadata;
  let repoSource = repo;
  let marketplaceConfig: ClaudeMarketplaceConfig | null = null;

  let isLocalPath = false;
  try {
    await stat(repo);
    isLocalPath = true;
  } catch {
    // Expected if not a local path
  }

  if (isLocalPath) {
    installMetadata = { source: repo, type: 'local', pluginName };
    marketplaceConfig = await readLocalMarketplaceConfig(repo);
  } else if (isGitUrl(repo)) {
    installMetadata = { source: repoSource, type: 'git', pluginName };
    try {
      const { owner, repo: repoName } = parseGitHubRepoForReleases(repoSource);
      marketplaceConfig = await fetchGitHubMarketplaceConfig(owner, repoName);
    } catch {
      // Not a GitHub URL
    }
  } else if (isOwnerRepoFormat(repo)) {
    repoSource = convertOwnerRepoToGitHubUrl(repo);
    installMetadata = { source: repoSource, type: 'git', pluginName };
    try {
      const [owner, repoName] = repo.split('/');
      marketplaceConfig = await fetchGitHubMarketplaceConfig(owner, repoName);
    } catch {
      // Failed to fetch config
    }
  } else {
    throw new Error(`Install source not found: ${repo}`);
  }

  if (marketplaceConfig) {
    installMetadata.marketplaceConfig = marketplaceConfig;
    installMetadata.originSource = 'Claude';
  }

  return installMetadata;
}
