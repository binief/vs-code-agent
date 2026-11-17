/**
 * In-memory task list for a single task run.
 *
 * Transient: created when a task starts and dropped when it ends. Not saved
 * to chats or exports. The model maintains it through the `task_list` tool so
 * a long-running task does not lose track of what is done, in progress, or
 * still pending.
 */

export type TaskStatus = 'pending' | 'in-progress' | 'done';

export interface TaskItem {
  /** Stable id within this task run, e.g. `task-1`. */
  id: string;
  title: string;
  status: TaskStatus;
}

/**
 * Task list store. All methods are synchronous and safe to call from the
 * `task_list` tool's `run` method. Items keep insertion order.
 */
export class TaskListStore {
  private readonly items = new Map<string, TaskItem>();
  private counter = 0;

  /** Add a new task item with status `pending`. Returns the assigned id. */
  add(title: string): string {
    const id = `task-${++this.counter}`;
    this.items.set(id, { id, title, status: 'pending' });
    return id;
  }

  /**
   * Update an existing item's title and/or status. Returns `false` when the
   * id is unknown (no change made).
   */
  update(id: string, patch: { title?: string; status?: TaskStatus }): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    this.items.set(id, { ...item, ...patch });
    return true;
  }

  /** Remove an item. Returns `false` when the id is unknown. */
  remove(id: string): boolean {
    return this.items.delete(id);
  }

  /** All items, in insertion order. */
  list(): TaskItem[] {
    return [...this.items.values()];
  }

  /** Remove every item. Used when a task is reset. */
  clear(): void {
    this.items.clear();
    this.counter = 0;
  }

  /** Replace all items with the given ones (used when restoring a saved chat).
   *  Existing ids are preserved; future `add` ids continue after the highest
   *  `task-N` suffix so newly generated ids never collide with restored ones. */
  restore(items: readonly TaskItem[]): void {
    this.items.clear();
    let max = 0;
    for (const item of items) {
      this.items.set(item.id, { ...item });
      const match = /^task-(\d+)$/.exec(item.id);
      if (match) {
        const n = Number(match[1]);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    this.counter = max;
  }

  /** Count of items in each status, for the UI strip. */
  counts(): { pending: number; 'in-progress': number; done: number } {
    let pending = 0;
    let inProgress = 0;
    let done = 0;
    for (const item of this.items.values()) {
      if (item.status === 'pending') pending++;
      else if (item.status === 'in-progress') inProgress++;
      else done++;
    }
    return { pending, 'in-progress': inProgress, done };
  }
}
