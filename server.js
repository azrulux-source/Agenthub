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
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const db = createClient({
  url: 'file:agent-hub.db',
});

// ─── INIT DATABASE ──────────────────────────────────────────────────────────
async function initDB() {
  await db.execute(`CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT, system_prompt TEXT, model TEXT, color TEXT, active INTEGER)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, name TEXT, display_name TEXT)`);
  
  // Seed Main Room
  await db.execute("INSERT OR IGNORE INTO rooms (id, name) VALUES ('main', 'Main Room')");
}
initDB();

// ─── ROUTES ──────────────────────────────────────────────────────────────────

app.get('/api/rooms', async (req, res) => {
  const { rows } = await db.execute("SELECT * FROM rooms");
  res.json(rows);
});

app.get('/api/models', async (req, res) => {
  const { rows } = await db.execute("SELECT * FROM models");
  res.json(rows);
});

app.get('/api/agents', async (req, res) => {
  const { rows } = await db.execute("SELECT * FROM agents");
  res.json(rows);
});

// THIS WAS THE MISSING PIECE CAUSING THE 404
app.post('/api/messages', async (req, res) => {
  const { roomId, content, userName, agentId } = req.body;

  try {
    // 1. Get the Agent details
    const { rows } = await db.execute({
      sql: "SELECT * FROM agents WHERE id = ?",
      args: [agentId]
    });
    const agent = rows[0];

    // 2. Talk to Local Ollama
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({
        model: agent.model || 'llama3.2',
        messages: [
          { role: 'system', content: agent.system_prompt },
          { role: 'user', content: content }
        ],
        stream: false
      })
    });

    const data = await response.json();
    res.json({
      role: 'assistant',
      content: data.message.content,
      agentId: agent.id,
      sender: agent.name
    });

  } catch (err) {
    console.error("CHAT ERROR:", err);
    res.status(500).json({ error: "Ollama connection failed" });
  }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
