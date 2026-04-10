import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@libsql/client';
import { randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;
const OLLAMA_URL = 'http://localhost:11434';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const db = createClient({ url: 'file:agent-hub.db' });

// ─── INIT DATABASE ──────────────────────────────────────────────────────────
async function initDB() {
  await db.execute(`CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT, system_prompt TEXT, model TEXT, color TEXT, active INTEGER)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, name TEXT, display_name TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS room_agents (room_id TEXT, agent_id TEXT, active INTEGER, PRIMARY KEY(room_id, agent_id))`);
  
  await db.execute("INSERT OR IGNORE INTO rooms (id, name) VALUES ('main', 'Main Room')");
}
initDB();

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// SYNC MODELS FROM OLLAMA
app.get('/api/models', async (req, res) => {
  try {
    const ollamaRes = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = await ollamaRes.json();
    await db.execute("DELETE FROM models"); 
    for (const m of data.models) {
      await db.execute({
        sql: "INSERT INTO models (id, name, display_name) VALUES (?, ?, ?)",
        args: [randomUUID(), m.name, m.name.split(':')[0].toUpperCase()]
      });
    }
    const { rows } = await db.execute("SELECT * FROM models");
    res.json(rows);
  } catch (err) {
    const { rows } = await db.execute("SELECT * FROM models");
    res.json(rows);
  }
});

app.get('/api/rooms', async (req, res) => {
  const { rows } = await db.execute("SELECT * FROM rooms");
  res.json(rows);
});

app.get('/api/agents', async (req, res) => {
  const { rows } = await db.execute("SELECT * FROM agents");
  res.json(rows);
});

app.post('/api/agents', async (req, res) => {
  const { name, system_prompt, model, roomId } = req.body;
  const id = randomUUID();
  await db.execute({
    sql: "INSERT INTO agents (id, name, system_prompt, model, active) VALUES (?, ?, ?, ?, 1)",
    args: [id, name, system_prompt, model]
  });
  await db.execute({
    sql: "INSERT INTO room_agents (room_id, agent_id, active) VALUES (?, ?, 1)",
    args: [roomId || 'main', id]
  });
  res.json({ id, name });
});

app.post('/api/messages', async (req, res) => {
  const { content, agentId } = req.body;
  try {
    const { rows } = await db.execute({ sql: "SELECT * FROM agents WHERE id = ?", args: [agentId] });
    const agent = rows[0];

    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({
        model: agent.model,
        messages: [{ role: 'system', content: agent.system_prompt }, { role: 'user', content }],
        stream: false
      })
    });
    const data = await response.json();
    res.json({ role: 'assistant', content: data.message.content, sender: agent.name });
  } catch (err) {
    res.status(500).json({ error: "Check if Ollama is running" });
  }
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
