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

// ─── Database ────────────────────────────────────────────────────────────────

const db = createClient({
  url: process.env.TURSO_URL || 'file:agent-hub.db',
  authToken: process.env.TURSO_TOKEN,
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

  // Seed default agent
  const { rows: agentRows } = await db.execute('SELECT COUNT(*) as c FROM agents');
  if (Number(agentRows[0].c) === 0) {
    await db.execute({
      sql: 'INSERT INTO agents (id, name, system_prompt, model, color, tools_enabled) VALUES (?, ?, ?, ?, ?, ?)',
      args: [
        randomUUID(),
        'Atlas',
        'You are Atlas, a helpful and thoughtful AI assistant. Be concise but thorough. You have access to tools to read/write files, search, run commands, and fetch URLs — use them when helpful.',
        'llama3.2',
        '#00ff88',
        1,
      ],
    });
    console.log('[DB] Created default agent: Atlas');
  }

  // Seed default models
  const { rows: modelRows } = await db.execute('SELECT COUNT(*) as c FROM models');
  if (Number(modelRows[0].c) === 0) {
    const defaultModels = [
      { name: 'llama3.2',      display: 'Llama 3.2',         desc: 'Fast, great for general chat and tool use',       caps: 'chat,tools' },
      { name: 'llama3.1:8b',   display: 'Llama 3.1 8B',      desc: 'Smarter, better tool use and reasoning',          caps: 'chat,tools' },
      { name: 'mistral',       display: 'Mistral 7B',         desc: 'Excellent all-rounder, strong at instructions',   caps: 'chat,tools' },
      { name: 'codellama',     display: 'Code Llama',         desc: 'Specialized for code generation and review',      caps: 'chat,code'  },
      { name: 'deepseek-coder',display: 'DeepSeek Coder',     desc: 'Top-tier coding model, great at complex code',    caps: 'chat,code'  },
      { name: 'phi3',          display: 'Phi-3 Mini',         desc: 'Tiny but surprisingly capable, very fast',        caps: 'chat'       },
      { name: 'gemma2:9b',     display: 'Gemma 2 9B',         desc: 'Great at following instructions and analysis',    caps: 'chat,tools' },
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

// ─── Ollama + Tool Loop ───────────────────────────────────────────────────────

async function getWorkspacePath() {
  try {
    const { rows } = await db.execute({ sql: "SELECT value FROM config WHERE key='workspace_path'", args: [] });
    return rows[0]?.value || null;
  } catch (_) { return null; }
}

async function callOllamaWithTools(agent, contextMessages, broadcast, roomId) {
  const workspacePath = await getWorkspacePath();
  const useTools = Number(agent.tools_enabled) === 1 && !!workspacePath;
  const toolLog = [];
  const MAX_ITERATIONS = 6;

  let messages = contextMessages.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
  }));

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const body = {
      model: agent.model,
      messages: [{ role: 'system', content: agent.system_prompt }, ...messages],
      stream: false,
    };

    if (useTools) body.tools = TOOL_DEFINITIONS;

    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const msg = data.message;

    // No tool calls — we have our final answer
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { reply: msg.content?.trim() || '[no response]', toolLog };
    }

    // Push assistant message with tool calls
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });

    // Execute each tool call
    for (const call of msg.tool_calls) {
      const toolName = call.function?.name;
      let args = call.function?.arguments || {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch (_) { args = {}; }
      }

      const label = toolLabel(toolName, args);
      toolLog.push(label);

      // Broadcast tool usage to chat in real time
      broadcast(roomId, 'tool_use', {
        agentId: agent.id,
        agentName: agent.name,
        color: agent.color,
        label,
      });

      let result;
      try {
        result = await executeTool(toolName, args, workspacePath);
      } catch (err) {
        result = { success: false, error: err.message };
      }

      messages.push({
        role: 'tool',
        content: JSON.stringify(result),
      });
    }
  }

  return { reply: '[Max tool iterations reached]', toolLog };
}

// ─── SSE ─────────────────────────────────────────────────────────────────────

const sseClients = new Map();
const roomPresence = new Map();

function broadcast(roomId, event, data) {
  const clients = sseClients.get(roomId);
  if (!clients || clients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach((res) => { try { res.write(payload); } catch (_) {} });
}

function broadcastPresence(roomId) {
  const users = Array.from(roomPresence.get(roomId)?.values() || []);
  broadcast(roomId, 'presence', { users });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/rooms/:id/stream', (req, res) => {
  const { id } = req.params;
  const clientId = randomUUID();
  const userName = String(req.query.userName || 'Anonymous').trim().slice(0, 32) || 'Anonymous';
  const userColor = String(req.query.userColor || '#a0aec0').trim().slice(0, 16) || '#a0aec0';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!sseClients.has(id)) sseClients.set(id, new Set());
  sseClients.get(id).add(res);
  if (!roomPresence.has(id)) roomPresence.set(id, new Map());
  roomPresence.get(id).set(clientId, { id: clientId, name: userName, color: userColor });

  res.write(`event: connected\ndata: ${JSON.stringify({ roomId: id })}\n\n`);
  broadcastPresence(id);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.get(id)?.delete(res);
    roomPresence.get(id)?.delete(clientId);
    if (roomPresence.get(id)?.size === 0) roomPresence.delete(id);
    broadcastPresence(id);
  });
});

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(join(__dirname, 'index.html'));
});

app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION, now: new Date().toISOString() });
});

// ── Config ────────────────────────────────────────────────────────────────────

app.get('/api/config', async (req, res) => {
  try {
    const { rows } = await db.execute('SELECT key, value FROM config');
    const cfg = {};
    rows.forEach(r => { cfg[r.key] = r.value; });
    res.json(cfg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agents', async (req, res) => {
  try {
    const { name, system_prompt, model = 'llama3.2', color = '#00ff88', tools_enabled = 1, roomId } = req.body;
    
    // Safety: If roomId is missing, use 'main' instead of crashing
    const targetRoom = roomId || 'main'; 

    if (!name?.trim() || !system_prompt?.trim()) {
      return res.status(400).json({ error: 'Name and system_prompt required' });
    }
    
    const id = randomUUID();
    await db.execute({
      sql: 'INSERT INTO agents (id, name, system_prompt, model, color, tools_enabled) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, name.trim(), system_prompt.trim(), model, color, tools_enabled ? 1 : 0],
    });

    await db.execute({
      sql: 'INSERT OR IGNORE INTO room_agents (room_id, agent_id, active) VALUES (?, ?, 1)',
      args: [targetRoom, id],
    });

    res.json({ id, name: name.trim(), system_prompt: system_prompt.trim(), model, color, tools_enabled, active: 1 });
  } catch (err) { 
    console.error("DETAILED SERVER ERROR:", err); // This prints the REAL error to your terminal
    res.status(500).json({ error: err.message }); 
  }
});

// ── Models ────────────────────────────────────────────────────────────────────

app.get('/api/models', async (req, res) => {
  try {
    const { rows } = await db.execute('SELECT * FROM models ORDER BY created_at ASC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/models', async (req, res) => {
  try {
    const { name, display_name, description, capabilities = 'chat' } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    const id = randomUUID();
    await db.execute({
      sql: 'INSERT OR REPLACE INTO models (id, name, display_name, description, capabilities) VALUES (?, ?, ?, ?, ?)',
      args: [id, name.trim(), display_name || name.trim(), description || '', capabilities],
    });
    res.json({ ok: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/models/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM models WHERE id=?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Rooms ─────────────────────────────────────────────────────────────────────

app.get('/api/rooms', async (req, res) => {
  try {
    const { rows } = await db.execute('SELECT * FROM rooms ORDER BY created_at ASC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/rooms', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    const id = randomUUID();
    await db.execute({ sql: 'INSERT INTO rooms (id, name) VALUES (?, ?)', args: [id, name.trim()] });
    res.json({ id, name: name.trim() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/rooms/:id', async (req, res) => {
  try {
    const roomId = req.params.id;
    if (roomId === 'main') return res.status(400).json({ error: 'Main Room cannot be deleted' });
    await db.execute({ sql: 'DELETE FROM messages WHERE room_id=?', args: [roomId] });
    await db.execute({ sql: 'DELETE FROM room_agents WHERE room_id=?', args: [roomId] });
    await db.execute({ sql: 'DELETE FROM room_files WHERE room_id=?', args: [roomId] });
    await db.execute({ sql: 'DELETE FROM rooms WHERE id=?', args: [roomId] });
    sseClients.get(roomId)?.forEach(r => { try { r.end(); } catch (_) {} });
    sseClients.delete(roomId);
    roomPresence.delete(roomId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/rooms/:id/presence', (req, res) => {
  const users = Array.from(roomPresence.get(req.params.id)?.values() || []);
  res.json({ users });
});

app.get('/api/rooms/:id/messages', async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: 'SELECT * FROM messages WHERE room_id=? ORDER BY created_at ASC LIMIT 100',
      args: [req.params.id],
    });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Files ─────────────────────────────────────────────────────────────────────

app.get('/api/rooms/:id/files', async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: 'SELECT id, room_id, name, mime_type, size_bytes, uploaded_by, created_at FROM room_files WHERE room_id=? ORDER BY created_at DESC LIMIT 100',
      args: [req.params.id],
    });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/rooms/:id/files', async (req, res) => {
  try {
    const roomId = req.params.id;
    const { name, mimeType = 'application/octet-stream', contentBase64, uploadedBy = 'Anonymous' } = req.body || {};
    if (!name || !contentBase64) return res.status(400).json({ error: 'name and contentBase64 required' });
    const sizeBytes = Math.floor((contentBase64.length * 3) / 4);
    if (sizeBytes > 5 * 1024 * 1024) return res.status(400).json({ error: 'File too large (max 5MB)' });
    const id = randomUUID();
    await db.execute({
      sql: 'INSERT INTO room_files (id, room_id, name, mime_type, size_bytes, content_base64, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [id, roomId, name, mimeType, sizeBytes, contentBase64, uploadedBy],
    });
    res.json({ ok: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/files/:id', async (req, res) => {
  try {
    const { rows } = await db.execute({ sql: 'SELECT * FROM room_files WHERE id=?', args: [req.params.id] });
    const file = rows[0];
    if (!file) return res.status(404).send('File not found');
    const buffer = Buffer.from(file.content_base64, 'base64');
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
    res.send(buffer);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Chat ──────────────────────────────────────────────────────────────────────

app.post('/api/rooms/:id/chat', async (req, res) => {
  const roomId = req.params.id;
  const { content, userName = 'Anonymous', userColor = '#a0aec0' } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Content required' });

  try {
    const userMsgId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await db.execute({
      sql: 'INSERT INTO messages (id, room_id, role, content, user_name, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [userMsgId, roomId, 'user', content.trim(), userName, userColor, now],
    });

    broadcast(roomId, 'message', {
      id: userMsgId, room_id: roomId, role: 'user',
      content: content.trim(), user_name: userName, color: userColor, created_at: now,
    });

    res.json({ ok: true });

    const { rows: agents } = await db.execute({
      sql: `SELECT a.*, ra.active FROM agents a
            JOIN room_agents ra ON ra.agent_id = a.id
            WHERE ra.room_id = ? AND ra.active = 1
            ORDER BY a.created_at ASC`,
      args: [roomId],
    });
    if (agents.length === 0) return;

    const { rows: history } = await db.execute({
      sql: 'SELECT * FROM messages WHERE room_id=? ORDER BY created_at DESC LIMIT 60',
      args: [roomId],
    });
    const sortedHistory = history.reverse();

    await Promise.all(agents.map(async (agent) => {
      try {
        broadcast(roomId, 'thinking', { agentId: agent.id, agentName: agent.name, color: agent.color });

        const contextMessages = sortedHistory
          .filter(m => m.role === 'user' || m.agent_id === agent.id)
          .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));

        const { reply, toolLog } = await callOllamaWithTools(agent, contextMessages, broadcast, roomId);

        const agentMsgId = randomUUID();
        const agentNow = Math.floor(Date.now() / 1000);
        await db.execute({
          sql: 'INSERT INTO messages (id, room_id, role, content, agent_id, agent_name, color, tool_log, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          args: [agentMsgId, roomId, 'assistant', reply, agent.id, agent.name, agent.color, JSON.stringify(toolLog), agentNow],
        });

        broadcast(roomId, 'message', {
          id: agentMsgId, room_id: roomId, role: 'assistant',
          content: reply, agent_id: agent.id, agent_name: agent.name,
          color: agent.color, tool_log: toolLog, created_at: agentNow,
        });
      } catch (err) {
        console.error(`[Agent ${agent.name}] Error:`, err.message);
        broadcast(roomId, 'agent_error', { agentName: agent.name, error: err.message });
      }
    }));
  } catch (err) {
    console.error('[Chat] Error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ── Agents ────────────────────────────────────────────────────────────────────

app.get('/api/agents', async (req, res) => {
  try {
    const roomId = req.query.roomId;
    if (!roomId) return res.status(400).json({ error: 'roomId query param required' });
    const { rows } = await db.execute({
      sql: `SELECT a.*, ra.active FROM agents a
            JOIN room_agents ra ON ra.agent_id = a.id
            WHERE ra.room_id = ? ORDER BY a.created_at ASC`,
      args: [roomId],
    });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agents', async (req, res) => {
  try {
    const { name, system_prompt, model = 'llama3.2', color = '#00ff88', tools_enabled = 1, roomId } = req.body;
    if (!name?.trim() || !system_prompt?.trim()) return res.status(400).json({ error: 'Name and system_prompt required' });
    if (!roomId) return res.status(400).json({ error: 'roomId required' });
    const id = randomUUID();
    await db.execute({
      sql: 'INSERT INTO agents (id, name, system_prompt, model, color, tools_enabled) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, name.trim(), system_prompt.trim(), model, color, tools_enabled ? 1 : 0],
    });
    await db.execute({
      sql: 'INSERT INTO room_agents (room_id, agent_id, active) VALUES (?, ?, 1)',
      args: [roomId, id],
    });
    res.json({ id, name: name.trim(), system_prompt: system_prompt.trim(), model, color, tools_enabled, active: 1 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/agents/:id', async (req, res) => {
  try {
    const { name, system_prompt, model, color, active, tools_enabled, roomId } = req.body;
    if (!roomId) return res.status(400).json({ error: 'roomId required' });
    await db.execute({
      sql: 'UPDATE agents SET name=?, system_prompt=?, model=?, color=?, tools_enabled=? WHERE id=?',
      args: [name, system_prompt, model, color, tools_enabled ? 1 : 0, req.params.id],
    });
    await db.execute({
      sql: 'UPDATE room_agents SET active=? WHERE room_id=? AND agent_id=?',
      args: [active ? 1 : 0, roomId, req.params.id],
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/agents/:id', async (req, res) => {
  try {
    const roomId = req.query.roomId;
    if (!roomId) return res.status(400).json({ error: 'roomId query param required' });
    await db.execute({ sql: 'DELETE FROM room_agents WHERE room_id=? AND agent_id=?', args: [roomId, req.params.id] });
    const { rows } = await db.execute({ sql: 'SELECT COUNT(*) AS c FROM room_agents WHERE agent_id=?', args: [req.params.id] });
    if (Number(rows[0].c) === 0) {
      await db.execute({ sql: 'DELETE FROM agents WHERE id=?', args: [req.params.id] });
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Export ────────────────────────────────────────────────────────────────────

app.get('/api/rooms/:id/export.txt', async (req, res) => {
  try {
    const roomId = req.params.id;
    const { rows } = await db.execute({
      sql: 'SELECT * FROM messages WHERE room_id=? ORDER BY created_at ASC',
      args: [roomId],
    });
    const lines = rows.map(m => {
      const t = new Date((m.created_at || 0) * 1000).toISOString();
      const who = m.role === 'user' ? (m.user_name || 'User') : (m.agent_name || 'Agent');
      const tools = m.tool_log ? ` [tools: ${JSON.parse(m.tool_log).join(', ')}]` : '';
      return `[${t}] ${who}${tools}: ${m.content}`;
    });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="room-${roomId}-transcript.txt"`);
    res.send(lines.join('\n\n'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Start ────────────────────────────────────────────────────────────────────

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[Agent Hub] Running on http://localhost:${PORT}`);
      console.log(`[Ollama]    Expecting at ${OLLAMA_URL}`);
    });
  })
  .catch(err => {
    console.error('[DB] Init failed:', err.message);
    process.exit(1);
  });
