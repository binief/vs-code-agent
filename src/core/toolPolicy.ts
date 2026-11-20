import type { SelectedAgentFiles } from './agentFiles';
import type { ToolSpec } from './types';

/** Built-in group names used in agent-file `tools` metadata. */
const GROUPS: Record<string, readonly string[]> = {
  read: ['list_files', 'read_file', 'get_diagnostics', 'open_file'],
  search: ['list_files', 'search_text'],
  edit: ['create_file', 'write_file', 'replace_in_file', 'delete_file'],
  execute: ['run_command'],
  browse: ['browser_tool'],
  subagent: ['delegate_task'],
};

/**
 * Selected files with `tools` grant capabilities by union: tools declared in
 * *any* selected agent file are combined. Files without a `tools:` declaration
 * are neutral — they neither grant nor restrict. Missing metadata does not
 * grant any capabilities. Never interpret prose as a security policy;
 * malformed, unknown or incomplete metadata fails closed.
 */
export function resolveAgentToolPolicy(selected: SelectedAgentFiles, available: readonly ToolSpec[]): {
  tools: ToolSpec[];
  restricted: boolean;
} {
  if (selected.missing.length) throw new Error(`Selected agent file(s) could not be loaded: ${selected.missing.join(', ')}. Restore or explicitly change the selection.`);
  if (selected.enabled && !selected.selection && selected.skipped.length) {
    throw new Error(`Some discovered agent files could not be loaded: ${selected.skipped.map((file) => file.path).join(', ')}. Tool permissions cannot be determined safely.`);
  }
  const names = new Set(available.map((tool) => tool.name));
  let declared = false;
  const granted = new Set<string>();
  for (const file of selected.files) {
    if (file.truncated) throw new Error(`Agent file "${file.displayPath}" is truncated; tool permissions cannot be determined safely.`);
    if (file.toolPolicyError) throw new Error(`Invalid tool policy in "${file.displayPath}": ${file.toolPolicyError}`);
    if (file.tools === undefined) continue;
    declared = true;
    for (const entry of file.tools) {
      if (entry === 'mcp') {
        for (const name of names) if (name.startsWith('mcp_')) granted.add(name);
      } else if (Object.prototype.hasOwnProperty.call(GROUPS, entry)) {
        for (const name of GROUPS[entry]) {
          if (names.has(name)) granted.add(name);
        }
      } else if (names.has(entry)) {
        granted.add(entry);
      } else {
        throw new Error(`Unknown tool or group "${entry}" in "${file.displayPath}".`);
      }
    }
  }
  return { tools: declared ? available.filter((tool) => granted.has(tool.name)) : [], restricted: true };
}
