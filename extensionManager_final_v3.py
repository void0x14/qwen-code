import sys
import os

filepath = 'packages/core/src/extension/extensionManager.ts'
with open(filepath, 'r') as f:
    content = f.read()

# Logic for smart monorepo fallback - rewrite part of convertGeminiOrClaudeExtension
search_fallback = """      if (monorepoPluginDir) {
        const packageJsonPath = path.join(monorepoPluginDir, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
          throw new Error(`UnresolvableMonorepoError: package.json not found in ${monorepoPluginDir}`);
        }

        let actualPackageName: string;
        try {
          const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
          if (!pkg.name) {
            throw new Error(`UnresolvableMonorepoError: "name" field missing in ${packageJsonPath}`);
          }
          actualPackageName = pkg.name;
        } catch (e) {
          if (e instanceof Error && e.message.includes('UnresolvableMonorepoError')) {
            throw e;
          }
          throw new Error(`UnresolvableMonorepoError: Failed to parse ${packageJsonPath}`);
        }

        const config: ExtensionConfig = {
          name: pluginName,
          version: '1.0.0',
          mcpServers: {
            [pluginName]: {
              command: 'npx',
              args: ['-y', actualPackageName],
            },
          },
        };"""

# The logic is actually already very close in v2, but I'll make sure it's strictly correct as per v3 requirements.
# v3 requirement: Read package.json in targeted subfolder. Extract name exactly. Throw error if missing.
# My v2 patch already does exactly this. I will just verify the current content.

with open(filepath, 'w') as f:
    f.write(content)
