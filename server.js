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
const APP_VERSION = process.env.RENDER_GIT_COMMIT?.slice(0, 7) || process.env.APP_VERSION || 'dev';

app.use(cors());
app.use(express.json());
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
      model TEXT DEFAULT 'llama-3.3-70b-versatile',
      color TEXT DEFAULT '#00ff88',
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
      sql: 'INSERT INTO agents (id, name, system_prompt, model, color) VALUES (?, ?, ?, ?, ?)',
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

  // Ensure each room has mapping rows for existing agents
  await db.execute(`
    INSERT OR IGNORE INTO room_agents (room_id, agent_id, active)
    SELECT rooms.id, agents.id, 1
    FROM rooms
    CROSS JOIN agents
  `);
}

// ─── SSE (real-time broadcasts) ───────────────────────────────────────────────
// Map of roomId -> Set of express response objects

const sseClients = new Map();
const roomPresence = new Map();

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

function broadcastPresence(roomId) {
  const users = Array.from(roomPresence.get(roomId)?.values() || []);
  broadcast(roomId, 'presence', { users });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// SSE stream for a room
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
    roomPresence.get(id)?.delete(clientId);
    if (roomPresence.get(id)?.size === 0) roomPresence.delete(id);
    broadcastPresence(id);
  });
});

// Serve SPA shell
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(join(__dirname, 'index.html'));
});

app.get('/api/version', (req, res) => {
  res.json({
    version: APP_VERSION,
    now: new Date().toISOString(),
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

// Delete a room
app.delete('/api/rooms/:id', async (req, res) => {
  try {
    const roomId = req.params.id;
    if (roomId === 'main') return res.status(400).json({ error: 'Main Room cannot be deleted' });
    await db.execute({ sql: 'DELETE FROM messages WHERE room_id=?', args: [roomId] });
    await db.execute({ sql: 'DELETE FROM room_agents WHERE room_id=?', args: [roomId] });
    await db.execute({ sql: 'DELETE FROM room_files WHERE room_id=?', args: [roomId] });
    await db.execute({ sql: 'DELETE FROM rooms WHERE id=?', args: [roomId] });
    sseClients.get(roomId)?.forEach((r) => {
      try { r.end(); } catch (_) {}
    });
    sseClients.delete(roomId);
    roomPresence.delete(roomId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Presence snapshot (fallback when SSE is flaky on mobile)
app.get('/api/rooms/:id/presence', (req, res) => {
  const users = Array.from(roomPresence.get(req.params.id)?.values() || []);
  res.json({ users });
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

// List files for a room
app.get('/api/rooms/:id/files', async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: `
        SELECT id, room_id, name, mime_type, size_bytes, uploaded_by, created_at
        FROM room_files
        WHERE room_id=?
        ORDER BY created_at DESC
        LIMIT 100
      `,
      args: [req.params.id],
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload file to room
app.post('/api/rooms/:id/files', async (req, res) => {
  try {
    const roomId = req.params.id;
    const { name, mimeType = 'application/octet-stream', contentBase64, uploadedBy = 'Anonymous' } = req.body || {};
    if (!name || !contentBase64) return res.status(400).json({ error: 'name and contentBase64 required' });
    const sizeBytes = Math.floor((contentBase64.length * 3) / 4);
    if (sizeBytes > 5 * 1024 * 1024) return res.status(400).json({ error: 'File too large (max 5MB)' });
    const id = randomUUID();
    await db.execute({
      sql: `
        INSERT INTO room_files (id, room_id, name, mime_type, size_bytes, content_base64, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      args: [id, roomId, name, mimeType, sizeBytes, contentBase64, uploadedBy],
    });
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download file
app.get('/api/files/:id', async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: 'SELECT * FROM room_files WHERE id=?',
      args: [req.params.id],
    });
    const file = rows[0];
    if (!file) return res.status(404).send('File not found');
    const buffer = Buffer.from(file.content_base64, 'base64');
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename=\"${file.name}\"`);
    res.send(buffer);
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
    const { rows: agents } = await db.execute({
      sql: `
        SELECT a.*, ra.active
        FROM agents a
        JOIN room_agents ra ON ra.agent_id = a.id
        WHERE ra.room_id = ? AND ra.active = 1
        ORDER BY a.created_at ASC
      `,
      args: [roomId],
    });
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
    const roomId = req.query.roomId;
    if (!roomId) return res.status(400).json({ error: 'roomId query param required' });
    const { rows } = await db.execute({
      sql: `
        SELECT a.*, ra.active
        FROM agents a
        JOIN room_agents ra ON ra.agent_id = a.id
        WHERE ra.room_id = ?
        ORDER BY a.created_at ASC
      `,
      args: [roomId],
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create an agent
app.post('/api/agents', async (req, res) => {
  try {
    const { name, system_prompt, model = 'llama-3.3-70b-versatile', color = '#00ff88', roomId } = req.body;
    if (!name?.trim() || !system_prompt?.trim()) {
      return res.status(400).json({ error: 'Name and system_prompt required' });
    }
    if (!roomId) return res.status(400).json({ error: 'roomId required' });
    const id = randomUUID();
    await db.execute({
      sql: 'INSERT INTO agents (id, name, system_prompt, model, color) VALUES (?, ?, ?, ?, ?)',
      args: [id, name.trim(), system_prompt.trim(), model, color],
    });
    await db.execute({
      sql: 'INSERT INTO room_agents (room_id, agent_id, active) VALUES (?, ?, 1)',
      args: [roomId, id],
    });
    res.json({ id, name: name.trim(), system_prompt: system_prompt.trim(), model, color, active: 1, roomId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update an agent
app.put('/api/agents/:id', async (req, res) => {
  try {
    const { name, system_prompt, model, color, active, roomId } = req.body;
    if (!roomId) return res.status(400).json({ error: 'roomId required' });
    await db.execute({
      sql: 'UPDATE agents SET name=?, system_prompt=?, model=?, color=? WHERE id=?',
      args: [name, system_prompt, model, color, req.params.id],
    });
    await db.execute({
      sql: 'UPDATE room_agents SET active=? WHERE room_id=? AND agent_id=?',
      args: [active ? 1 : 0, roomId, req.params.id],
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete an agent
app.delete('/api/agents/:id', async (req, res) => {
  try {
    const roomId = req.query.roomId;
    if (!roomId) return res.status(400).json({ error: 'roomId query param required' });
    await db.execute({ sql: 'DELETE FROM room_agents WHERE room_id=? AND agent_id=?', args: [roomId, req.params.id] });
    const { rows } = await db.execute({
      sql: 'SELECT COUNT(*) AS c FROM room_agents WHERE agent_id=?',
      args: [req.params.id],
    });
    if (Number(rows[0].c) === 0) {
      await db.execute({ sql: 'DELETE FROM agents WHERE id=?', args: [req.params.id] });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download room transcript
app.get('/api/rooms/:id/export.txt', async (req, res) => {
  try {
    const roomId = req.params.id;
    const { rows } = await db.execute({
      sql: 'SELECT * FROM messages WHERE room_id=? ORDER BY created_at ASC',
      args: [roomId],
    });
    const lines = rows.map((m) => {
      const t = new Date((m.created_at || 0) * 1000).toISOString();
      const who = m.role === 'user' ? (m.user_name || 'User') : (m.agent_name || 'Agent');
      return `[${t}] ${who}: ${m.content}`;
    });
    const body = lines.join('\n\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=\"room-${roomId}-transcript.txt\"`);
    res.send(body);
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
