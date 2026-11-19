import * as fs from 'node:fs';
import * as path from 'node:path';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from '../types';
import { walkFiles } from './walk';

export const taskDecomposeTool: Tool<{
  prompt: string;
}> = {
  name: 'task_decompose',
  description:
    'Create task list items from a prompt by finding project files mentioned in or matching the prompt, then splitting them into context-sized slices. Each slice becomes a task_list item. Only available when task list is enabled in settings.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'Describe what to break down into tasks. Files mentioned by path or matching keywords in the prompt are grouped into slices sized to fit within the context window.',
      },
    },
    required: ['prompt'],
  },
  async run(args, ctx): Promise<ToolResult> {
    if (!ctx.taskList) {
      return fail('Task list is not available for this task.', 'unavailable');
    }

    const prompt = args.prompt?.trim();
    if (!prompt) {
      return fail('"prompt" is required.', 'bad arguments');
    }

    const root = ctx.root;
    const contextWindow = ctx.config.compaction.contextWindowTokens;
    // Reserve 60% of the window for slices; the rest is for system prompt,
    // tool schemas, images, and conversation history.
    const sliceBudget = Math.floor(contextWindow * 0.6);
    if (sliceBudget < 1000) {
      return fail('Context window too small for decomposition.', 'configuration');
    }

    const signal = ctx.signal;

    // Source file extensions considered for decomposition.
    const sourceExts = new Set([
      '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
      '.py', '.go', '.java', '.kt', '.rs', '.rb', '.php', '.cs', '.cpp', '.c', '.h', '.hpp',
      '.swift', '.scala', '.clj', '.hs', '.ml', '.fs', '.vb',
      '.html', '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
      '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
      '.md', '.mdx', '.txt', '.rst',
      '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
      '.sql', '.graphql', '.gql',
      '.dockerfile', '.tf',
    ]);
    const skipNames = new Set([
      'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock',
      'Cargo.lock', 'composer.lock', 'Gemfile.lock', 'Pipfile.lock',
    ]);

    // Collect files relevant to the prompt — no full workspace scan.
    const relevantFiles = new Set<string>();

    // 1. Files explicitly mentioned by path in the prompt (e.g. "src/foo.ts").
    const pathRe = /[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rs|rb|php|cs|cpp|c|h|hpp|swift|scala|clj|hs|ml|fs|vb|html|css|scss|sass|less|vue|svelte|json|yaml|yml|toml|ini|cfg|conf|md|mdx|txt|rst|sh|bash|zsh|fish|ps1|bat|cmd|sql|graphql|gql|tf)\b/gi;
    for (const m of prompt.matchAll(pathRe)) {
      const file = m[0];
      try {
        const abs = path.resolve(root, file);
        const stat = fs.statSync(abs);
        if (stat.isFile()) {
          const ext = path.extname(file.toLowerCase());
          if (sourceExts.has(ext) && !skipNames.has(file.toLowerCase())) {
            relevantFiles.add(file);
          }
        }
      } catch {
        // Mentioned file doesn't exist: skip.
      }
    }

    if (signal?.aborted) return fail('Cancelled.', 'cancelled');

    // 2. Files matching prompt keywords via bounded glob matches.
    const stopWords = new Set([
      'the','and','for','with','from','that','this','have','has','had','but','not','you','are','was','were','been','will','would','could','should','may','might','must','can','about','into','over','under','after','before','between','through','during','without','within','what','which','when','where','who','whom','whose','why','how','all','any','each','every','some','such','no','nor','only','own','same','so','than','too','very','just','now','then','here','there','also','even','still','much','more','most','less','least','few','many','several','both','either','neither','another','other','others','please','help','need','want','make','take','get','set','put','run','use','see','look','show','tell','ask','say','call','try','work','way','time','year','day','week','month','project','code','file','files','thing','things','stuff','issue','bug','fix','add','remove','change','update','create','delete','build','test','run','start','stop','restart','deploy','config','settings','setup','install','upgrade','merge','rebase','commit','push','pull','clone','fork','branch','tag','release','version','new','old','first','last','next','previous','current','recent','later','soon','today','tomorrow','yesterday'
    ]);
    const keywords = prompt
      .split(/[^\w]+/)
      .filter((w) => w.length >= 4 && !stopWords.has(w.toLowerCase()))
      .map((w) => w.toLowerCase());

    for (const keyword of keywords) {
      if (signal?.aborted) return fail('Cancelled.', 'cancelled');
      const glob = `**/*${keyword}*`;
      try {
        const result = walkFiles({
          root,
          glob,
          maxDepth: 8,
          maxEntries: 30,
          maxFileBytes: 256 * 1024,
          signal,
        });
        for (const entry of result.files) {
          const name = entry.rel.toLowerCase();
          const ext = path.extname(name);
          if (sourceExts.has(ext) && !skipNames.has(name)) {
            relevantFiles.add(entry.rel);
          }
        }
      } catch {
        // Glob walk failed: continue with other keywords.
      }
    }

    if (signal?.aborted) return fail('Cancelled.', 'cancelled');
    if (relevantFiles.size === 0) {
      return ok('No relevant project files found for the prompt. Task list was not created.', 'no files', { items: [] });
    }

    // Deterministic ordering.
    const files = Array.from(relevantFiles)
      .map((rel) => {
        const abs = path.resolve(root, rel);
        let size = 0;
        try { size = fs.statSync(abs).size; } catch { /* use 0 */ }
        return { rel, abs, isDirectory: false, size };
      })
      .sort((a, b) => a.rel.localeCompare(b.rel));

    // Estimate tokens per file: roughly 1 token per 4 characters of content,
    // plus a fixed overhead for file path and framing.
    const estimateFileTokens = (entry: { size: number }): number => {
      return Math.max(20, Math.ceil(entry.size / 4));
    };

    // Greedily pack files into slices within the slice budget.
    const slices: { files: string[]; tokens: number }[] = [];
    let current: { files: string[]; tokens: number } = { files: [], tokens: 0 };

    for (const entry of files) {
      const fileTokens = estimateFileTokens(entry);
      if (fileTokens > sliceBudget) {
        if (current.files.length > 0) {
          slices.push(current);
          current = { files: [], tokens: 0 };
        }
        slices.push({ files: [entry.rel], tokens: fileTokens });
        continue;
      }
      if (current.tokens + fileTokens > sliceBudget && current.files.length > 0) {
        slices.push(current);
        current = { files: [], tokens: 0 };
      }
      current.files.push(entry.rel);
      current.tokens += fileTokens;
    }
    if (current.files.length > 0) slices.push(current);

    if (slices.length === 0) {
      return ok('No task slices created.', 'empty', { items: [] });
    }

    // Create task_list items for each slice.
    const created: { id: string; title: string }[] = [];
    for (let i = 0; i < slices.length; i += 1) {
      const slice = slices[i];
      const title = `Slice ${i + 1}/${slices.length}: ${slice.files.length} file(s), ~${slice.tokens.toLocaleString()} tokens`;
      const id = ctx.taskList.add(title);
      created.push({ id, title });
    }

    return ok(
      `Created ${created.length} task item(s). Use task_list to mark items in-progress/done as you work through them.`,
      'created',
      { items: created },
    );
  },
};
