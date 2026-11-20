import { createFileTool, deleteFileTool, listFilesTool, readFileTool, replaceInFileTool, writeFileTool } from './fsTools';
import { getDiagnosticsTool, openFileTool } from './hostTools';
import { searchTextTool } from './searchTools';
import {
  runCommandTool,
  runShellCommand,
  getRunningCommands,
  getRunningCommandOutput,
  killRunningCommand,
  killAllRunningCommands,
  getDetachedProcesses,
  killDetachedProcess,
  killAllDetachedProcesses,
  DETACHED_DEFAULT_TIMEOUT_MS,
  type RunningCommandInfo,
} from './shellTool';
import { taskListTool } from './taskList';
import { taskDecomposeTool } from './taskDecompose';
import { browserTool, type BrowserToolArgs, type BrowserSnapshot } from './browserTool';
import type { Tool, ToolSpec } from '../types';

/**
 * The default tool set. Everything the model can do to the workspace goes
 * through one of these, and each one is independently gate-able and testable.
 * `task_list` is opt-in per project via the agent.md `tools:` list.
 */
export function createDefaultTools(): Tool[] {
  return [
    listFilesTool as Tool,
    readFileTool as Tool,
    searchTextTool as Tool,
    createFileTool as Tool,
    writeFileTool as Tool,
    replaceInFileTool as Tool,
    deleteFileTool as Tool,
    runCommandTool as Tool,
    getDiagnosticsTool as Tool,
    openFileTool as Tool,
    taskListTool as Tool,
    taskDecomposeTool as Tool,
    browserTool as Tool,
  ];
}

export class ToolRegistry {
  private readonly byName = new Map<string, Tool>();

  constructor(tools: Tool[] = createDefaultTools()) {
    for (const tool of tools) {
      if (this.byName.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
      this.byName.set(tool.name, tool);
    }
  }

  get size(): number {
    return this.byName.size;
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  get(name: string): Tool | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  specs(): ToolSpec[] {
    return [...this.byName.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  add(tool: Tool): void {
    if (this.byName.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    this.byName.set(tool.name, tool);
  }

  addAll(tools: Tool[]): void {
    for (const tool of tools) this.add(tool);
  }
}

export { createFileTool, deleteFileTool, listFilesTool, readFileTool, replaceInFileTool, writeFileTool };
export { getDiagnosticsTool, openFileTool };
export { searchTextTool };
export { runCommandTool, runShellCommand };
export {
  getRunningCommands,
  getRunningCommandOutput,
  killRunningCommand,
  killAllRunningCommands,
  getDetachedProcesses,
  killDetachedProcess,
  killAllDetachedProcesses,
  DETACHED_DEFAULT_TIMEOUT_MS,
};
export type { RunningCommandInfo };
export { taskDecomposeTool };
export { browserTool };
export type { BrowserToolArgs, BrowserSnapshot };
export { McpManager, McpClient } from './mcp';
