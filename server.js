import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@libsql/client';
import { randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

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
      model TEXT DEFAULT 'llama-3.3-70b-versatile',
      color TEXT DEFAULT '#00ff88',
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch())
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
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);

  // Seed default room if none exist
  const { rows: roomRows } = await db.execute('SELECT COUNT(*) as c FROM rooms');
  if (Number(roomRows[0].c) === 0) {
    await db.execute({
      sql: 'INSERT INTO rooms (id, name) VALUES (?, ?)',
      args: ['main', 'Main Room'],
    });
    console.log('[DB] Created default room: Main Room');
  }

  // Seed default agent if none exist
  const { rows: agentRows } = await db.execute('SELECT COUNT(*) as c FROM agents');
  if (Number(agentRows[0].c) === 0) {
    await db.execute({
      sql: 'INSERT INTO agents (id, name, system_prompt, model, color, active) VALUES (?, ?, ?, ?, ?, 1)',
      args: [
        randomUUID(),
        'Atlas',
        'You are Atlas, a helpful and thoughtful AI assistant. Be concise but thorough. Keep responses focused and avoid unnecessary padding.',
        'llama-3.3-70b-versatile',
        '#00ff88',
      ],
    });
    console.log('[DB] Created default agent: Atlas');
  }
}

// ─── SSE (real-time broadcasts) ───────────────────────────────────────────────
// Map of roomId -> Set of express response objects

const sseClients = new Map();

function broadcast(roomId, event, data) {
  const clients = sseClients.get(roomId);
  if (!clients || clients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach((res) => {
    try {
      res.write(payload);
    } catch (_) {}
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// SSE stream for a room
app.get('/api/rooms/:id/stream', (req, res) => {
  const { id } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!sseClients.has(id)) sseClients.set(id, new Set());
  sseClients.get(id).add(res);

  res.write(`event: connected\ndata: ${JSON.stringify({ roomId: id })}\n\n`);

  // Keep alive ping every 25s
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_) {
      clearInterval(ping);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.get(id)?.delete(res);
  });
});

// List all rooms
app.get('/api/rooms', async (req, res) => {
  try {
    const { rows } = await db.execute('SELECT * FROM rooms ORDER BY created_at ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a room
app.post('/api/rooms', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    const id = randomUUID();
    await db.execute({ sql: 'INSERT INTO rooms (id, name) VALUES (?, ?)', args: [id, name.trim()] });
    res.json({ id, name: name.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get messages for a room (last 100)
app.get('/api/rooms/:id/messages', async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: 'SELECT * FROM messages WHERE room_id=? ORDER BY created_at ASC LIMIT 100',
      args: [req.params.id],
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send a message — triggers all active agents
app.post('/api/rooms/:id/chat', async (req, res) => {
  const roomId = req.params.id;
  const { content, userName = 'Anonymous', userColor = '#a0aec0' } = req.body;

  if (!content?.trim()) return res.status(400).json({ error: 'Content required' });

  try {
    // Save user message
    const userMsgId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await db.execute({
      sql: 'INSERT INTO messages (id, room_id, role, content, user_name, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [userMsgId, roomId, 'user', content.trim(), userName, userColor, now],
    });

    // Broadcast immediately so all users see it right away
    broadcast(roomId, 'message', {
      id: userMsgId,
      room_id: roomId,
      role: 'user',
      content: content.trim(),
      user_name: userName,
      color: userColor,
      created_at: now,
    });

    // Respond to client fast — agents run async
    res.json({ ok: true });

    // Get active agents
    const { rows: agents } = await db.execute('SELECT * FROM agents WHERE active=1 ORDER BY created_at ASC');
    if (agents.length === 0) return;

    // Get recent message history for context
    const { rows: history } = await db.execute({
      sql: 'SELECT * FROM messages WHERE room_id=? ORDER BY created_at DESC LIMIT 60',
      args: [roomId],
    });
    const sortedHistory = history.reverse();

    // Fire all agents in parallel
    await Promise.all(
      agents.map(async (agent) => {
        try {
          // Tell clients this agent is thinking
          broadcast(roomId, 'thinking', { agentId: agent.id, agentName: agent.name, color: agent.color });

          // Build context for this agent:
          // user messages + only this agent's own prior responses
          const contextMessages = sortedHistory
            .filter((m) => m.role === 'user' || m.agent_id === agent.id)
            .map((m) => ({
              role: m.role === 'user' ? 'user' : 'assistant',
              content: m.content,
            }));

          const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            },
            body: JSON.stringify({
              model: agent.model,
              messages: [
                { role: 'system', content: agent.system_prompt },
                ...contextMessages,
              ],
              max_tokens: 1024,
              temperature: 0.7,
            }),
          });

          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Groq ${response.status}: ${errText}`);
          }

          const data = await response.json();
          const reply = data.choices?.[0]?.message?.content?.trim() || '[no response]';

          // Save agent response
          const agentMsgId = randomUUID();
          const agentNow = Math.floor(Date.now() / 1000);
          await db.execute({
            sql: 'INSERT INTO messages (id, room_id, role, content, agent_id, agent_name, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            args: [agentMsgId, roomId, 'assistant', reply, agent.id, agent.name, agent.color, agentNow],
          });

          // Broadcast agent response
          broadcast(roomId, 'message', {
            id: agentMsgId,
            room_id: roomId,
            role: 'assistant',
            content: reply,
            agent_id: agent.id,
            agent_name: agent.name,
            color: agent.color,
            created_at: agentNow,
          });
        } catch (err) {
          console.error(`[Agent ${agent.name}] Error:`, err.message);
          broadcast(roomId, 'agent_error', { agentName: agent.name, error: err.message });
        }
      })
    );
  } catch (err) {
    console.error('[Chat] Error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// List all agents
app.get('/api/agents', async (req, res) => {
  try {
    const { rows } = await db.execute('SELECT * FROM agents ORDER BY created_at ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create an agent
app.post('/api/agents', async (req, res) => {
  try {
    const { name, system_prompt, model = 'llama-3.3-70b-versatile', color = '#00ff88' } = req.body;
    if (!name?.trim() || !system_prompt?.trim()) {
      return res.status(400).json({ error: 'Name and system_prompt required' });
    }
    const id = randomUUID();
    await db.execute({
      sql: 'INSERT INTO agents (id, name, system_prompt, model, color, active) VALUES (?, ?, ?, ?, ?, 1)',
      args: [id, name.trim(), system_prompt.trim(), model, color],
    });
    res.json({ id, name: name.trim(), system_prompt: system_prompt.trim(), model, color, active: 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update an agent
app.put('/api/agents/:id', async (req, res) => {
  try {
    const { name, system_prompt, model, color, active } = req.body;
    await db.execute({
      sql: 'UPDATE agents SET name=?, system_prompt=?, model=?, color=?, active=? WHERE id=?',
      args: [name, system_prompt, model, color, active ? 1 : 0, req.params.id],
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete an agent
app.delete('/api/agents/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM agents WHERE id=?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────

initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`[Agent Hub] Running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('[DB] Init failed:', err.message);
    process.exit(1);
  });
