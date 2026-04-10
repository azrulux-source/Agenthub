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

async function initDB() {
  await db.execute(`CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT, system_prompt TEXT, model TEXT, active INTEGER)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS room_agents (room_id TEXT, agent_id TEXT, PRIMARY KEY(room_id, agent_id))`);
  await db.execute(`CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, name TEXT, display_name TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, 
    room_id TEXT, 
    sender TEXT, 
    content TEXT, 
    role TEXT,
    created_at INTEGER
  )`);
  await db.execute("INSERT OR IGNORE INTO rooms (id, name) VALUES ('main', 'Main Room')");
}
initDB();

// --- API ---

app.get('/api/rooms', async (req, res) => {
  const { rows } = await db.execute("SELECT * FROM rooms");
  res.json(rows);
});

app.post('/api/rooms', async (req, res) => {
  const id = randomUUID();
  await db.execute({ sql: "INSERT INTO rooms (id, name) VALUES (?, ?)", args: [id, req.body.name] });
  res.json({ id, name: req.body.name });
});

app.get('/api/messages', async (req, res) => {
  const { roomId } = req.query;
  const { rows } = await db.execute({
    sql: "SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC",
    args: [roomId || 'main']
  });
  res.json(rows);
});

app.post('/api/messages', async (req, res) => {
  const { roomId, content, userName, agentId } = req.body;
  const ts = Date.now();
  
  // Save User Msg
  await db.execute({
    sql: "INSERT INTO messages (id, room_id, sender, content, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    args: [randomUUID(), roomId, userName, content, 'user', ts]
  });

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
    
    // Save AI Msg
    await db.execute({
      sql: "INSERT INTO messages (id, room_id, sender, content, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [randomUUID(), roomId, agent.name, data.message.content, 'assistant', Date.now()]
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Ollama offline" });
  }
});

// Models and Agents
app.get('/api/models', async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    const d = await r.json();
    await db.execute("DELETE FROM models");
    for (const m of d.models) {
      await db.execute({ sql: "INSERT INTO models (id, name, display_name) VALUES (?, ?, ?)", args: [randomUUID(), m.name, m.name.split(':')[0].toUpperCase()] });
    }
  } catch (e) {}
  const { rows } = await db.execute("SELECT * FROM models");
  res.json(rows);
});

app.get('/api/agents', async (req, res) => {
  const { roomId } = req.query;
  const { rows } = await db.execute({
    sql: "SELECT a.* FROM agents a JOIN room_agents ra ON a.id = ra.agent_id WHERE ra.room_id = ?",
    args: [roomId || 'main']
  });
  res.json(rows);
});

app.post('/api/agents', async (req, res) => {
  const { name, system_prompt, model, roomId } = req.body;
  const id = randomUUID();
  await db.execute({ sql: "INSERT INTO agents (id, name, system_prompt, model, active) VALUES (?, ?, ?, ?, 1)", args: [id, name, system_prompt, model] });
  await db.execute({ sql: "INSERT INTO room_agents (room_id, agent_id) VALUES (?, ?)", args: [roomId || 'main', id] });
  res.json({ id });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server: http://localhost:${PORT}`));
