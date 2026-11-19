import type { CommandPolicy } from './types';

export interface CommandVerdict {
  decision: 'allow' | 'ask' | 'deny';
  reason: string;
}

interface Rule {
  re: RegExp;
  reason: string;
}

/**
 * Hard deny-list: refused even when the policy is `auto-all`. These are the
 * "this destroys the machine or pipes the internet into your shell" patterns.
 * `allowDangerousCommands` turns the list into a warning-only `ask`.
 */
export const DANGEROUS: Rule[] = [
  { re: /\brm\s+(-[^\s]+\s+)*-[a-z]*[rf][a-z]*\s+(\/|~|\$HOME|\/\*)(\s|$)/i, reason: 'recursive delete of / or $HOME' },
  { re: /\brm\s+-[a-z]*\s+-\/(\s|$)/, reason: 'recursive delete of /' },
  { re: /\b(mkfs|mkfs\.[a-z0-9]+)\b/i, reason: 'format a filesystem' },
  { re: /\bdd\b[^\n]*\bof=\/dev\//i, reason: 'raw write to a block device' },
  { re: />\s*\/dev\/(sd|nvme|disk|hd)/i, reason: 'write to a raw device' },
  { re: /:\(\)\s*\{\s*:\|\s*:&\s*\}\s*;\s*:/, reason: 'fork bomb' },
  { re: /\b(shutdown|reboot|halt|poweroff|init\s+0)\b/i, reason: 'power state change' },
  { re: /\bchmod\s+(-R\s+)?777\s+\/(\s|$)/i, reason: 'world-writable root' },
  { re: /\b(curl|wget|iwr|invoke-webrequest)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|fi|k|da)?sh\b/i, reason: 'piping a download straight into a shell' },
  { re: /\b(sudo|doas)\s+rm\s+-[a-z]*[rf]/i, reason: 'sudo recursive delete' },
  { re: /\bformat\s+[a-z]:/i, reason: 'format a Windows volume' },
  { re: /\bdel\s+\/[a-z]\s+\/[a-z]\s+[a-z]:\\/i, reason: 'recursive Windows delete of a drive' },
  { re: /\bgit\s+clean\s+-[a-z]*[xdf]/i, reason: 'git clean that removes untracked/ignored files' },
  { re: /\bhistory\s+-c\b/, reason: 'wipe shell history' },
];

/** Commands considered read-only / low risk, auto-approved under `auto-safe`. */
const SAFE_PATTERNS: RegExp[] = [
  /^\s*(ls|dir|pwd|cat|bat|head|tail|wc|file|stat|tree|du|df|which|whoami|hostname|date|uname|id|env|printenv|type|realpath)\b/,
  /^\s*(grep|rg|ag|find|fd|fdfind|locate)\b/,
  /^\s*git\s+(status|diff|log|show|branch|remote|rev-parse|describe|ls-files|blame|shortlog|tag)\b/,
  /^\s*git\s+stash\s+list\b/,
  /^\s*(node|python|python3|deno|bun|go|rustc|cargo|dotnet|java|javac|ruby|php|swift|gcc|g\+\+|clang|tsc)\s+--?v(ersion)?\b/,
  /^\s*(npm|pnpm|yarn|bun)\s+--?v(ersion)?\b/,
  /^\s*(npm|pnpm|yarn|bun)\s+(ls|list|view|info|outdated|why)\b/,
  /^\s*(npm|pnpm|yarn|bun)\s+(run\s+)?(test|tests|test:unit|test:e2e|lint|typecheck|type-check|check|format:check|build)\b/,
  /^\s*(pytest|py\.test|tox|nox|mypy|ruff|flake8|black\s+--check|isort\s+--check)\b/,
  /^\s*(go\s+(test|vet|build|list)|cargo\s+(test|check|clippy|build)|dotnet\s+(test|build)|mvn\s+(test|verify)|gradle|\.\/gradlew)\b/,
  /^\s*(npx|pnpm\s+dlx)\s+(tsc|eslint|prettier|jest|vitest)\b/,
  /^\s*node\s+--check\b/,
  /^\s*python3?\s+-m\s+(py_compile|json\.tool|compileall)\b/,
  /^\s*echo\b/,
  // Infrastructure / process-management commands used to start, wait on, and
  // inspect long-running services. These are read-only with respect to the
  // workspace and safe to run under auto-safe even when chained.
  /^\s*(set\b|start\s+\/b\b|timeout\b|netstat\b|findstr\b|tasklist\b|ping\b|curl\b|wget\b)\b/,
];

/** Risky but legitimate commands: always confirmed, even under `auto-safe`. */
const ELEVATED: Rule[] = [
  { re: /\brm\s+-[a-z]*[rf]/i, reason: 'recursive delete' },
  { re: /\bgit\s+(push|reset\s+--hard|checkout\s+--\s|clean)\b/i, reason: 'git history / remote change' },
  { re: /\b(npm|pnpm|yarn|bun)\s+(publish|unpublish|install\s+-g|link)\b/i, reason: 'package manager side effect' },
  { re: /\b(pip|pip3)\s+(install|uninstall)\b/i, reason: 'python package install' },
  { re: /\b(docker|podman)\s+(run|rm|rmi|system\s+prune|volume\s+rm)\b/i, reason: 'container side effect' },
  { re: /\b(kubectl|helm|terraform|aws|gcloud|az)\b/i, reason: 'infrastructure change' },
  { re: /\bchmod\b|\bchown\b/i, reason: 'permission change' },
  { re: /\bmv\b|\brm\b|\btruncate\b/i, reason: 'file move / removal' },
  { re: /\bsudo\b|\bdoas\b/i, reason: 'privilege escalation' },
  { re: /\bcurl\b|\bwget\b/i, reason: 'network access' },
  // Launching application servers / long-running processes is a side effect.
  { re: /\b(java|node|python|python3|ruby|php|dotnet)\s+(-jar|\.|\w+\.js|\w+\.py)\b/i, reason: 'starts a long-running application server' },
  { re: /\b(mvn|maven|gradle|mvnw|gradlew)\b/i, reason: 'build tool that may start a long-running server — use detached: true to avoid blocking' },
];

/** Shell metacharacters that make a "safe" prefix unsafe. */
const SHELL_META = /[;&|><`$()\n]|\|\||&&/;

function firstMatch(rules: Rule[], command: string): Rule | undefined {
  return rules.find((r) => r.re.test(command));
}

/**
 * Decide what to do with a shell command.
 *
 * Order: hard deny-list \u2192 elevated/risky \u2192 read-only allow-list \u2192 policy default.
 */
export function evaluateCommand(
  command: string,
  opts: { policy: CommandPolicy; allowDangerousCommands?: boolean },
): CommandVerdict {
  const cmd = command.trim();
  if (!cmd) return { decision: 'deny', reason: 'empty command' };

  if (opts.policy === 'deny-all') {
    return { decision: 'deny', reason: 'shell tool is disabled by codingHarness.commandPolicy=deny-all' };
  }

  const dangerous = firstMatch(DANGEROUS, cmd);
  if (dangerous) {
    if (opts.allowDangerousCommands) {
      return { decision: 'ask', reason: `dangerous command (${dangerous.reason}) \u2014 explicitly allowed by settings` };
    }
    return { decision: 'deny', reason: `blocked by the safety deny-list: ${dangerous.reason}` };
  }

  const elevated = firstMatch(ELEVATED, cmd);
  if (elevated) return { decision: 'ask', reason: elevated.reason };

  const isSingleCommand = !SHELL_META.test(cmd);
  if (isSingleCommand && SAFE_PATTERNS.some((re) => re.test(cmd))) {
    if (opts.policy === 'auto-safe' || opts.policy === 'auto-all') {
      return { decision: 'allow', reason: 'read-only command' };
    }
    return { decision: 'ask', reason: 'read-only command (policy: ask)' };
  }

  // Compound commands (chained with &&, &, |, ;) where every part matches a
  // safe pattern are treated as safe infrastructure operations under auto-safe.
  // E.g. "start /b ... && timeout /t 12 && netstat ... | findstr ..."
  // Splits on command separators but not on redirection operators like 2>&1.
  const parts = cmd.split(/\s*[;&|]\s*/);
  const allPartsSafe =
    parts.length > 1 &&
    parts.every((p) => {
      const trimmed = p.trim();
      return trimmed.length > 0 && SAFE_PATTERNS.some((re) => re.test(trimmed));
    });
  if (allPartsSafe && (opts.policy === 'auto-safe' || opts.policy === 'auto-all')) {
    return { decision: 'allow', reason: 'infrastructure command chain' };
  }

  switch (opts.policy) {
    case 'auto-all':
      return { decision: 'allow', reason: 'policy: auto-all' };
    case 'auto-safe':
      return { decision: 'ask', reason: 'not on the read-only allow-list' };
    default:
      return { decision: 'ask', reason: 'policy: ask' };
  }
}
