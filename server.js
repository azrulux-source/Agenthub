import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@libsql/client';
import { randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TOOL_DEFINITIONS, executeTool, toolLabel } from './tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const APP_VERSION = process.env.RENDER_GIT_COMMIT?.slice(0, 7) || process.env.APP_VERSION || 'dev';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// ─── Local Database Only (Turso Removed) ─────────────────────────────────────

const db = createClient({
  url: 'file:agent-hub.db', // This forces a local file on your PC
});

async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      model TEXT DEFAULT 'llama3.2',
      color TEXT DEFAULT '#00ff88',
      tools_enabled INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS room_agents (
      room_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (room_id, agent_id)
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      agent_id TEXT,
      agent_name TEXT,
      user_name TEXT,
      color TEXT,
      tool_log TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS room_files (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER DEFAULT 0,
      content_base64 TEXT NOT NULL,
      uploaded_by TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      display_name TEXT,
      description TEXT,
      capabilities TEXT DEFAULT 'chat',
      is_available INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Seed default room
  const { rows: roomRows } = await db.execute('SELECT COUNT(*) as c FROM rooms');
  if (Number(roomRows[0].c) === 0) {
    await db.execute({ sql: 'INSERT INTO rooms (id, name) VALUES (?, ?)', args: ['main', 'Main Room'] });
    console.log('[DB] Created default room: Main Room');
  }

  // Seed default models (Updated for your local Ollama models)
  const { rows: modelRows } = await db.execute('SELECT COUNT(*) as c FROM models');
  if (Number(modelRows[0].c) === 0) {
    const defaultModels = [
      { name: 'llama3.2:latest', display: 'Llama 3.2', desc: 'Fast, great for general chat', caps: 'chat,tools' },
      { name: 'llama3.1:latest', display: 'Llama 3.1 8B', desc: 'Smarter reasoning', caps: 'chat,tools' },
      { name: 'mistral:latest',  display: 'Mistral 7B',  desc: 'Excellent all-rounder', caps: 'chat,tools' },
      { name: 'deepseek-coder:latest', display: 'DeepSeek', desc: 'Top-tier coding', caps: 'chat,code' },
    ];
    for (const m of defaultModels) {
      await db.execute({
        sql: 'INSERT OR IGNORE INTO models (id, name, display_name, description, capabilities) VALUES (?, ?, ?, ?, ?)',
        args: [randomUUID(), m.name, m.display, m.desc, m.caps],
      });
    }
    console.log('[DB] Seeded default models');
  }

  // Ensure room_agents mappings
  await db.execute(`
    INSERT OR IGNORE INTO room_agents (room_id, agent_id, active)
    SELECT rooms.id, agents.id, 1 FROM rooms CROSS JOIN agents
  `);
}

// ─── Ollama + Tool Loop (Omitted for brevity - same as your original) ──────
// [KEEP ALL THE callOllamaWithTools, broadcast, SSE, and Routes logic here]

// ─── Start ────────────────────────────────────────────────────────────────────

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[Agent Hub] Running on http://localhost:${PORT}`);
      console.log(`[Ollama]   Expecting at ${OLLAMA_URL}`);
      console.log(`[DB]       Local file: agent-hub.db`);
    });
  })
  .catch(err => {
    console.error('[DB] Init failed:', err.message);
    process.exit(1);
  });
