import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@libsql/client';
import { randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_WORKSPACE = process.env.WORKSPACE_PATH || __dirname;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const db = createClient({ url: 'file:agent-hub.db' });
const onlineUsers = {};

// â”€â”€ DB INIT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function initDB() {
  await db.execute(`CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, name TEXT, workspace_path TEXT, active_topic_id TEXT
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY, room_id TEXT, name TEXT, created_at INTEGER, archived INTEGER DEFAULT 0
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, name TEXT, system_prompt TEXT, model TEXT,
    active INTEGER DEFAULT 1, tools_enabled INTEGER DEFAULT 1
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS room_agents (
    room_id TEXT, agent_id TEXT, PRIMARY KEY(room_id, agent_id)
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY, name TEXT, display_name TEXT
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, room_id TEXT, topic_id TEXT,
    sender TEXT, content TEXT, role TEXT, created_at INTEGER, tool_activity TEXT
  )`);

  // Seed default room + topic
  const tid = randomUUID();
  try {
    await db.execute({
      sql: "INSERT OR IGNORE INTO rooms (id, name, workspace_path, active_topic_id) VALUES ('main', 'Main Room', ?, ?)",
      args: [DEFAULT_WORKSPACE, tid]
    });
    const { rows } = await db.execute("SELECT COUNT(*) as c FROM topics WHERE room_id = 'main'");
    if (rows[0].c === 0) {
      await db.execute({
        sql: "INSERT INTO topics (id, room_id, name, created_at) VALUES (?, 'main', 'General', ?)",
        args: [tid, Date.now()]
      });
    }
  } catch (_) {}

  // Safe migrations
  const migrations = [
    ["rooms", "workspace_path TEXT"],
    ["rooms", "active_topic_id TEXT"],
    ["agents", "tools_enabled INTEGER DEFAULT 1"],
    ["messages", "topic_id TEXT"],
    ["messages", "tool_activity TEXT"],
  ];
  for (const [table, col] of migrations) {
    try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch (_) {}
  }
}
initDB();

// â”€â”€ PRESENCE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/presence', (req, res) => {
  const { userName } = req.body;
  if (userName) onlineUsers[userName] = Date.now();
  const now = Date.now();
  res.json(Object.keys(onlineUsers).filter(u => now - onlineUsers[u] < 10000));
});

// â”€â”€ MODELS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/models', async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    const d = await r.json();
    await db.execute("DELETE FROM models");
    for (const m of d.models) {
      await db.execute({
        sql: "INSERT INTO models (id, name, display_name) VALUES (?, ?, ?)",
        args: [randomUUID(), m.name, m.name.replace(':latest', '').toUpperCase()]
      });
    }
  } catch (_) {}
  const { rows } = await db.execute("SELECT * FROM models ORDER BY display_name");
  res.json(rows);
});

// â”€â”€ ROOMS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/rooms', async (req, res) => {
  const { rows } = await db.execute("SELECT * FROM rooms");
  res.json(rows);
});

app.post('/api/rooms', async (req, res) => {
  const id = randomUUID();
  const tid = randomUUID();
  await db.execute({
    sql: "INSERT INTO rooms (id, name, workspace_path, active_topic_id) VALUES (?, ?, ?, ?)",
    args: [id, req.body.name, DEFAULT_WORKSPACE, tid]
  });
  await db.execute({
    sql: "INSERT INTO topics (id, room_id, name, created_at) VALUES (?, ?, 'General', ?)",
    args: [tid, id, Date.now()]
  });
  res.json({ id, activeTopic: tid });
});

// â”€â”€ TOPICS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/topics', async (req, res) => {
  const { roomId } = req.query;
  const { rows } = await db.execute({
    sql: "SELECT * FROM topics WHERE room_id = ? AND archived = 0 ORDER BY created_at ASC",
    args: [roomId]
  });
  res.json(rows);
});

app.post('/api/topics', async (req, res) => {
  const { roomId, name } = req.body;
  const id = randomUUID();
  await db.execute({
    sql: "INSERT INTO topics (id, room_id, name, created_at) VALUES (?, ?, ?, ?)",
    args: [id, roomId, name, Date.now()]
  });
  await db.execute({ sql: "UPDATE rooms SET active_topic_id = ? WHERE id = ?", args: [id, roomId] });
  res.json({ id });
});

app.patch('/api/topics/:id', async (req, res) => {
  const { name, archived } = req.body;
  if (name !== undefined) await db.execute({ sql: "UPDATE topics SET name = ? WHERE id = ?", args: [name, req.params.id] });
  if (archived !== undefined) await db.execute({ sql: "UPDATE topics SET archived = ? WHERE id = ?", args: [archived ? 1 : 0, req.params.id] });
  res.json({ success: true });
});

app.post('/api/rooms/:roomId/active-topic', async (req, res) => {
  const { topicId } = req.body;
  await db.execute({ sql: "UPDATE rooms SET active_topic_id = ? WHERE id = ?", args: [topicId, req.params.roomId] });
  res.json({ success: true });
});

// â”€â”€ TOPIC SEARCH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/topics/search', async (req, res) => {
  const { roomId, query } = req.query;
  if (!query) return res.json([]);
  const { rows } = await db.execute({
    sql: `SELECT m.content, m.sender, m.role, t.name as topic_name
          FROM messages m JOIN topics t ON m.topic_id = t.id
          WHERE m.room_id = ? AND m.role != 'system' AND m.content LIKE ?
          ORDER BY m.created_at DESC LIMIT 12`,
    args: [roomId, `%${query}%`]
  });
  res.json(rows.map(r => ({
    topic: r.topic_name,
    sender: r.sender,
    excerpt: r.content.slice(0, 300)
  })));
});

// â”€â”€ MESSAGES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/messages', async (req, res) => {
  const { roomId, topicId } = req.query;
  const { rows } = await db.execute({
    sql: "SELECT * FROM messages WHERE room_id = ? AND topic_id = ? ORDER BY created_at ASC",
    args: [roomId, topicId]
  });
  res.json(rows.map(r => ({ ...r, tool_activity: r.tool_activity ? JSON.parse(r.tool_activity) : null })));
});

// â”€â”€ SEND MESSAGE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/messages', async (req, res) => {
  const { roomId, content, userName, topicId } = req.body;

  // Resolve active topic
  let activeTopic = topicId;
  if (!activeTopic) {
    const { rows } = await db.execute({ sql: "SELECT active_topic_id FROM rooms WHERE id = ?", args: [roomId] });
    activeTopic = rows[0]?.active_topic_id;
  }

  await db.execute({
    sql: "INSERT INTO messages (id, room_id, topic_id, sender, content, role, created_at) VALUES (?, ?, ?, ?, ?, 'user', ?)",
    args: [randomUUID(), roomId, activeTopic, userName, content, Date.now()]
  });

  res.json({ success: true, topicId: activeTopic });

  // Background: agents respond
  runAgents(roomId, activeTopic, content).catch(err => console.error('Agent error:', err));
});

async function runAgents(roomId, topicId, latestContent) {
  const { rows: roomRows } = await db.execute({ sql: "SELECT * FROM rooms WHERE id = ?", args: [roomId] });
  const workspacePath = roomRows[0]?.workspace_path || DEFAULT_WORKSPACE;

  const { rows: agents } = await db.execute({
    sql: "SELECT a.* FROM agents a JOIN room_agents ra ON a.id = ra.agent_id WHERE ra.room_id = ?",
    args: [roomId]
  });
  if (agents.length === 0) return;

  // Load topic history
  const { rows: history } = await db.execute({
    sql: "SELECT * FROM messages WHERE room_id = ? AND topic_id = ? AND role != 'system' ORDER BY created_at ASC LIMIT 40",
    args: [roomId, topicId]
  });

  const baseHistory = history.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content
  }));

  // Auto-suggest topic name after 3rd user message if still "General"
  const { rows: topicRows } = await db.execute({ sql: "SELECT * FROM topics WHERE id = ?", args: [topicId] });
  const userMsgCount = history.filter(m => m.role === 'user').length;
  if (topicRows[0]?.name === 'General' && userMsgCount === 3) {
    suggestTopicName(roomId, topicId, baseHistory, agents[0]).catch(() => {});
  }

  for (const agent of agents) {
    await runAgentLoop(agent, roomId, topicId, baseHistory, workspacePath);
  }
}

async function runAgentLoop(agent, roomId, topicId, baseHistory, workspacePath) {
  const toolActivity = [];
  const tools = agent.tools_enabled ? TOOL_DEFINITIONS : [];
  let messages = [
    {
      role: 'system',
      content: `${agent.system_prompt || 'You are a helpful assistant.'}\n\nYou can use tools to help users: read/write files, run commands, search the web, and search past conversation topics in this room. Use them when helpful.`
    },
    ...baseHistory
  ];

  let iterations = 0;
  let finalContent = '';

  while (iterations < 8) {
    iterations++;
    const body = { model: agent.model, messages, stream: false };
    if (tools.length > 0) body.tools = tools;

    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    const msg = data.message;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      finalContent = msg.content || '';
      break;
    }

    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });

    for (const tc of msg.tool_calls) {
      const toolName = tc.function.name;
      const args = typeof tc.function.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments;

      let result;
      try {
        if (toolName === 'search_topics') {
          const r = await fetch(`http://localhost:${PORT}/api/topics/search?roomId=${roomId}&query=${encodeURIComponent(args.query)}`);
          result = await r.json();
        } else {
          result = await executeTool(toolName, args, workspacePath);
        }
        toolActivity.push({ tool: toolName, args, status: 'ok', preview: JSON.stringify(result).slice(0, 150) });
      } catch (err) {
        result = { error: err.message };
        toolActivity.push({ tool: toolName, args, status: 'error', preview: err.message });
      }

      messages.push({ role: 'tool', content: JSON.stringify(result) });
    }
  }

  if (finalContent) {
    await db.execute({
      sql: "INSERT INTO messages (id, room_id, topic_id, sender, content, role, created_at, tool_activity) VALUES (?, ?, ?, ?, ?, 'assistant', ?, ?)",
      args: [
        randomUUID(), roomId, topicId, agent.name,
        finalContent, Date.now(),
        toolActivity.length > 0 ? JSON.stringify(toolActivity) : null
      ]
    });
  }
}

async function suggestTopicName(roomId, topicId, history, agent) {
  try {
    const prompt = `Based on this conversation, suggest a concise topic name (3-5 words). Reply with ONLY the topic name.\n\n${history.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 800)}`;
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: agent.model, messages: [{ role: 'user', content: prompt }], stream: false })
    });
    const data = await res.json();
    const suggested = data.message?.content?.trim().replace(/["'.]/g, '').slice(0, 40);
    if (suggested) {
      await db.execute({
        sql: "INSERT INTO messages (id, room_id, topic_id, sender, content, role, created_at) VALUES (?, ?, ?, '__system__', ?, 'system', ?)",
        args: [randomUUID(), roomId, topicId, `TOPIC_SUGGEST:${suggested}`, Date.now()]
      });
    }
  } catch (_) {}
}

// â”€â”€ AGENTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/agents', async (req, res) => {
  const { roomId } = req.query;
  const { rows } = await db.execute({
    sql: "SELECT a.* FROM agents a JOIN room_agents ra ON a.id = ra.agent_id WHERE ra.room_id = ?",
    args: [roomId || 'main']
  });
  res.json(rows);
});

app.post('/api/agents', async (req, res) => {
  const { name, system_prompt, model, roomId, tools_enabled } = req.body;
  const id = randomUUID();
  await db.execute({
    sql: "INSERT INTO agents (id, name, system_prompt, model, active, tools_enabled) VALUES (?, ?, ?, ?, 1, ?)",
    args: [id, name, system_prompt, model, tools_enabled !== false ? 1 : 0]
  });
  await db.execute({ sql: "INSERT INTO room_agents (room_id, agent_id) VALUES (?, ?)", args: [roomId || 'main', id] });
  res.json({ id });
});

app.delete('/api/agents/:id', async (req, res) => {
  await db.execute({ sql: "DELETE FROM agents WHERE id = ?", args: [req.params.id] });
  await db.execute({ sql: "DELETE FROM room_agents WHERE agent_id = ?", args: [req.params.id] });
  res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => console.log(`\nðŸš€ Agent Hub running â†’ http://localhost:${PORT}\n`));
