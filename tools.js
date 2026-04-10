import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { join, resolve, relative, dirname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ── Tool Definitions (Ollama/OpenAI format) ────────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file in the workspace folder.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file within the workspace' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or create a file in the workspace folder. Creates parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file within the workspace' },
          content: { type: 'string', description: 'Content to write to the file' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and folders in a directory within the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to directory. Use "." for the workspace root.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for text content across all files in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to search for (case-insensitive)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a terminal/shell command inside the workspace directory. Use carefully.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch the text content of a web page or URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL to fetch (must start with http:// or https://)' }
        },
        required: ['url']
      }
    }
  }
];

// ── Safety: block path traversal ──────────────────────────────────────────

function safePath(workspacePath, inputPath) {
  const resolved = resolve(join(workspacePath, inputPath));
  if (!resolved.startsWith(resolve(workspacePath))) {
    throw new Error(`Path escape blocked: "${inputPath}" resolves outside workspace`);
  }
  return resolved;
}

// ── Tool Executor ─────────────────────────────────────────────────────────

export async function executeTool(toolName, args, workspacePath) {
  if (!workspacePath) throw new Error('No workspace path configured. Set it in Settings.');

  switch (toolName) {

    case 'read_file': {
      const fullPath = safePath(workspacePath, args.path);
      const content = await readFile(fullPath, 'utf-8');
      return { success: true, path: args.path, content };
    }

    case 'write_file': {
      const fullPath = safePath(workspacePath, args.path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, args.content, 'utf-8');
      return { success: true, message: `Written: ${args.path} (${args.content.length} chars)` };
    }

    case 'list_directory': {
      const fullPath = safePath(workspacePath, args.path);
      const entries = await readdir(fullPath, { withFileTypes: true });
      const items = entries.map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file'
      }));
      return { success: true, path: args.path, items };
    }

    case 'search_files': {
      const results = [];
      async function searchDir(dir) {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            await searchDir(fullPath);
          } else {
            try {
              const content = await readFile(fullPath, 'utf-8');
              if (content.toLowerCase().includes(args.query.toLowerCase())) {
                const lines = content.split('\n');
                const matches = lines
                  .map((text, i) => ({ line: i + 1, text: text.trim() }))
                  .filter(l => l.text.toLowerCase().includes(args.query.toLowerCase()))
                  .slice(0, 4);
                results.push({ file: relative(workspacePath, fullPath), matches });
              }
            } catch (_) {}
          }
        }
      }
      await searchDir(workspacePath);
      return { success: true, query: args.query, results, total: results.length };
    }

    case 'run_command': {
      const { stdout, stderr } = await execAsync(args.command, {
        cwd: workspacePath,
        timeout: 15000,
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
      });
      return {
        success: true,
        command: args.command,
        stdout: stdout.slice(0, 2000),
        stderr: stderr.slice(0, 500)
      };
    }

    case 'fetch_url': {
      if (!args.url.startsWith('http://') && !args.url.startsWith('https://')) {
        throw new Error('URL must start with http:// or https://');
      }
      const res = await fetch(args.url, { signal: AbortSignal.timeout(10000) });
      const text = await res.text();
      const clean = text
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 4000);
      return { success: true, url: args.url, status: res.status, content: clean };
    }

    default:
      throw new Error(`Unknown tool: "${toolName}"`);
  }
}

// ── Tool label for UI display ──────────────────────────────────────────────

export function toolLabel(toolName, args) {
  switch (toolName) {
    case 'read_file':      return `📄 Reading: ${args.path}`;
    case 'write_file':     return `✏️ Writing: ${args.path}`;
    case 'list_directory': return `📁 Listing: ${args.path}`;
    case 'search_files':   return `🔍 Searching: "${args.query}"`;
    case 'run_command':    return `⚡ Running: ${args.command}`;
    case 'fetch_url':      return `🌐 Fetching: ${args.url}`;
    default:               return `🔧 ${toolName}`;
  }
}
