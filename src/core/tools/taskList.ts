import { fail, ok, type Tool, type ToolContext, type ToolResult } from '../types';
import type { TaskItem } from '../taskList';

export const taskListTool: Tool<{
  action: 'add' | 'update' | 'list' | 'remove';
  id?: string;
  title?: string;
  status?: 'pending' | 'in-progress' | 'done';
}> = {
  name: 'task_list',
  description:
    'Keep a task list for the current long-running task. Use it to track what ' +
    'has been done, what is in progress, and what is still pending. The list is ' +
    'in-memory for this task only and is not saved to chats or exports.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'update', 'list', 'remove'],
        description: 'What to do with the task list.',
      },
      id: { type: 'string', description: 'Task item id (required for update and remove).' },
      title: { type: 'string', description: 'Task item title (required for add).' },
      status: {
        type: 'string',
        enum: ['pending', 'in-progress', 'done'],
        description: 'New status (for update).',
      },
    },
    required: ['action'],
  },
  async run(args, ctx): Promise<ToolResult> {
    const store = ctx.taskList;
    if (!store) {
      return fail('Task list is not available for this task.', 'unavailable');
    }

    switch (args.action) {
      case 'add': {
        if (!args.title) return fail('"title" is required for add.', 'bad arguments');
        const id = store.add(args.title);
        return ok(
          `Added task item ${id}: ${args.title}`,
          'added',
          { id, title: args.title, status: 'pending' } as Record<string, unknown>,
        );
      }
      case 'update': {
        if (!args.id) return fail('"id" is required for update.', 'bad arguments');
        const patch: Record<string, unknown> = {};
        if (args.title !== undefined) patch.title = args.title;
        if (args.status !== undefined) patch.status = args.status;
        if (Object.keys(patch).length === 0) return fail('Nothing to update.', 'bad arguments');
        const updated = store.update(args.id, patch as { title?: string; status?: 'pending' | 'in-progress' | 'done' });
        if (!updated) {
          const available = store.list().map((i) => i.id).join(', ');
          return fail(`Unknown task item id "${args.id}". Available: ${available || 'none'}.`, 'not found');
        }
        return ok(`Updated task item ${args.id}.`, 'updated');
      }
      case 'list': {
        const items = store.list();
        if (items.length === 0) return ok('Task list is empty.', 'empty');
        const lines = items.map((item: TaskItem) => {
          const mark = item.status === 'done' ? '[x]' : item.status === 'in-progress' ? '[•]' : '[ ]';
          return `${mark} ${item.id} ${item.title}`;
        });
        return ok(lines.join('\n'), `${items.length} item(s)`, { items } as Record<string, unknown>);
      }
      case 'remove': {
        if (!args.id) return fail('"id" is required for remove.', 'bad arguments');
        const removed = store.remove(args.id);
        if (!removed) {
          const available = store.list().map((i) => i.id).join(', ');
          return fail(`Unknown task item id "${args.id}". Available: ${available || 'none'}.`, 'not found');
        }
        return ok(`Removed task item ${args.id}.`, 'removed');
      }
      default:
        return fail(`Unknown action "${args.action}".`, 'bad arguments');
    }
  },
};
