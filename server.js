import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_WORKSPACE = process.env.WORKSPACE_PATH || __dirname;
const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
const AGENT_ROUNDS = parseInt(process.env.AGENT_ROUNDS || '2'); // inter-agent conversation rounds

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// â”€â”€ DATABASE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const db = new Database('agent-hub.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, name TEXT, workspace_path TEXT, active_topic_id TEXT
  );
  CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY, room_id TEXT, name TEXT, created_at INTEGER, archived INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, name TEXT, system_prompt TEXT, model TEXT,
    active INTEGER DEFAULT 1, tools_enabled INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS room_agents (
    room_id TEXT, agent_id TEXT, PRIMARY KEY(room_id, agent_id)
  );
  CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY, name TEXT, display_name TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, room_id TEXT, topic_id TEXT,
    sender TEXT, content TEXT, role TEXT, created_at INTEGER,
    tool_activity TEXT, embedding TEXT, is_agent_chat INTEGER DEFAULT 0
  );
`);

// Safe migrations for existing DBs
for (const [table, col] of [
  ["rooms", "workspace_path TEXT"],
  ["rooms", "active_topic_id TEXT"],
  ["agents", "tools_enabled INTEGER DEFAULT 1"],
  ["messages", "topic_id TEXT"],
  ["messages", "tool_activity TEXT"],
  ["messages", "embedding TEXT"],
  ["messages", "is_agent_chat INTEGER DEFAULT 0"],
]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch (_) {}
}

// Seed default room + topic
if (!db.prepare("SELECT id FROM rooms WHERE id = 'main'").get()) {
  const tid = randomUUID();
  db.prepare("INSERT INTO rooms (id, name, workspace_path, active_topic_id) VALUES ('main', 'Main Room', ?, ?)").run(DEFAULT_WORKSPACE, tid);
  db.prepare("INSERT INTO topics (id, room_id, name, created_at) VALUES (?, 'main', 'General', ?)").run(tid, Date.now());
}

const onlineUsers = {};

// â”€â”€ VECTOR UTILITIES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Generate embedding vector from Ollama
async function getEmbedding(text) {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 2000) })
    });
    const data = await res.json();
    return data.embedding || null;
  } catch (_) {
    return null;
  }
}

// Cosine similarity between two vectors
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

// Save message and generate embedding in background
function saveMessage({ id, roomId, topicId, sender, content, role, toolActivity = null, isAgentChat = 0 }) {
  db.prepare(`
    INSERT INTO messages (id, room_id, topic_id, sender, content, role, created_at, tool_activity, is_agent_chat)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, roomId, topicId, sender, content, role, Date.now(), toolActivity, isAgentChat);

  // Generate and store embedding asynchronously
  getEmbedding(content).then(embedding => {
    if (embedding) {
      db.prepare("UPDATE messages SET embedding = ? WHERE id = ?").run(JSON.stringify(embedding), id);
    }
  }).catch(() => {});
}

// Semantic search across topics
async function semanticSearch(roomId, query, limit = 10) {
  const queryEmbedding = await getEmbedding(query);

  const rows = db.prepare(`
    SELECT m.content, m.sender, m.role, m.embedding, t.name as topic_name
    FROM messages m JOIN topics t ON m.topic_id = t.id
    WHERE m.room_id = ? AND m.role NOT IN ('system') AND m.content IS NOT NULL
  `).all(roomId);

  if (queryEmbedding) {
    // Vector similarity search
    const scored = rows
      .map(row => {
        const emb = row.embedding ? JSON.parse(row.embedding) : null;
        return { ...row, score: cosineSimilarity(queryEmbedding, emb) };
      })
      .filter(r => r.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (scored.length > 0) {
      return scored.map(r => ({
        topic: r.topic_name,
        sender: r.sender,
        excerpt: r.content.slice(0, 300),
        relevance: Math.round(r.score * 100) + '%'
      }));
    }
  }

  // Fallback: keyword search
  return rows
    .filter(r => r.content.toLowerCase().includes(query.toLowerCase()))
    .slice(0, limit)
    .map(r => ({ topic: r.topic_name, sender: r.sender, excerpt: r.content.slice(0, 300), relevance: 'keyword' }));
}

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
    db.exec("DELETE FROM models");
    const insert = db.prepare("INSERT INTO models (id, name, display_name) VALUES (?, ?, ?)");
    for (const m of d.models) {
      // Skip embedding models from the chat model list
      if (m.name.includes('embed')) continue;
      insert.run(randomUUID(), m.name, m.name.replace(':latest', '').toUpperCase());
    }
  } catch (_) {}
  res.json(db.prepare("SELECT * FROM models ORDER BY display_name").all());
});

// â”€â”€ ROOMS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/rooms', (req, res) => {
  res.json(db.prepare("SELECT * FROM rooms").all());
});

app.post('/api/rooms', (req, res) => {
  const id = randomUUID();
  const tid = randomUUID();
  db.prepare("INSERT INTO rooms (id, name, workspace_path, active_topic_id) VALUES (?, ?, ?, ?)").run(id, req.body.name, DEFAULT_WORKSPACE, tid);
  db.prepare("INSERT INTO topics (id, room_id, name, created_at) VALUES (?, ?, 'General', ?)").run(tid, id, Date.now());
  res.json({ id, activeTopic: tid });
});

app.post('/api/rooms/:roomId/active-topic', (req, res) => {
  db.prepare("UPDATE rooms SET active_topic_id = ? WHERE id = ?").run(req.body.topicId, req.params.roomId);
  res.json({ success: true });
});

// â”€â”€ TOPICS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/topics', (req, res) => {
  res.json(db.prepare("SELECT * FROM topics WHERE room_id = ? AND archived = 0 ORDER BY created_at ASC").all(req.query.roomId));
});

app.post('/api/topics', (req, res) => {
  const { roomId, name } = req.body;
  const id = randomUUID();
  db.prepare("INSERT INTO topics (id, room_id, name, created_at) VALUES (?, ?, ?, ?)").run(id, roomId, name, Date.now());
  db.prepare("UPDATE rooms SET active_topic_id = ? WHERE id = ?").run(id, roomId);
  res.json({ id });
});

app.patch('/api/topics/:id', (req, res) => {
  const { name, archived } = req.body;
  if (name !== undefined) db.prepare("UPDATE topics SET name = ? WHERE id = ?").run(name, req.params.id);
  if (archived !== undefined) db.prepare("UPDATE topics SET archived = ? WHERE id = ?").run(archived ? 1 : 0, req.params.id);
  res.json({ success: true });
});

// â”€â”€ TOPIC SEARCH (semantic) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/topics/search', async (req, res) => {
  const { roomId, query } = req.query;
  if (!query) return res.json([]);
  res.json(await semanticSearch(roomId, query));
});

// â”€â”€ MESSAGES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/messages', (req, res) => {
  const { roomId, topicId } = req.query;
  const rows = db.prepare(`
    SELECT id, room_id, topic_id, sender, content, role, created_at, tool_activity, is_agent_chat
    FROM messages WHERE room_id = ? AND topic_id = ? ORDER BY created_at ASC
  `).all(roomId, topicId);
  res.json(rows.map(r => ({
    ...r,
    tool_activity: r.tool_activity ? JSON.parse(r.tool_activity) : null
  })));
});

// â”€â”€ SEND MESSAGE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/messages', async (req, res) => {
  const { roomId, content, userName, topicId } = req.body;

  let activeTopic = topicId;
  if (!activeTopic) {
    const room = db.prepare("SELECT active_topic_id FROM rooms WHERE id = ?").get(roomId);
    activeTopic = room?.active_topic_id;
  }

  const msgId = randomUUID();
  saveMessage({ id: msgId, roomId, topicId: activeTopic, sender: userName, content, role: 'user' });

  res.json({ success: true, topicId: activeTopic });

  runAgents(roomId, activeTopic).catch(err => console.error('Agent error:', err));
});

// â”€â”€ AGENT ORCHESTRATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function runAgents(roomId, topicId) {
  const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
  const workspacePath = room?.workspace_path || DEFAULT_WORKSPACE;

  const agents = db.prepare(
    "SELECT a.* FROM agents a JOIN room_agents ra ON a.id = ra.agent_id WHERE ra.room_id = ? AND a.active = 1"
  ).all(roomId);
  if (agents.length === 0) return;

  // â”€â”€ Round 0: Each agent responds to the user â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log(`\n[Round 0] ${agents.length} agent(s) responding to user...`);
  for (const agent of agents) {
    const history = getTopicHistory(roomId, topicId, 40);
    await runAgentLoop({ agent, roomId, topicId, history, workspacePath, isAgentChat: false });
  }

  // â”€â”€ Inter-agent rounds: agents respond to each other â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (agents.length > 1) {
    for (let round = 1; round <= AGENT_ROUNDS; round++) {
      console.log(`\n[Round ${round}] Inter-agent conversation...`);
      let anyResponded = false;

      for (const agent of agents) {
        const history = getTopicHistory(roomId, topicId, 40);
        const lastMsg = history[history.length - 1];

        // Skip if the last message was from this agent (avoid talking to itself)
        if (lastMsg?.sender === agent.name) continue;

        // Check if there's a recent agent message this agent hasn't responded to
        const recentAgentMsgs = history
          .slice(-6)
          .filter(m => m.role === 'assistant' && m.sender !== agent.name);

        if (recentAgentMsgs.length === 0) continue;

        const responded = await runAgentLoop({
          agent, roomId, topicId, history, workspacePath,
          isAgentChat: true,
          interAgentRound: round
        });
        if (responded) anyResponded = true;
      }

      // If no agent had anything to add, stop early
      if (!anyResponded) break;
    }
  }

  // â”€â”€ Auto topic suggestion â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const topic = db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId);
  const userCount = db.prepare("SELECT COUNT(*) as c FROM messages WHERE topic_id = ? AND role = 'user'").get(topicId)?.c || 0;
  if (topic?.name === 'General' && userCount === 3) {
    suggestTopicName(topicId, getTopicHistory(roomId, topicId, 10), agents[0]).catch(() => {});
  }
}

function getTopicHistory(roomId, topicId, limit = 40) {
  return db.prepare(`
    SELECT * FROM messages
    WHERE room_id = ? AND topic_id = ? AND role != 'system'
    ORDER BY created_at ASC LIMIT ?
  `).all(roomId, topicId, limit);
}

// Run a single agent's tool loop, returns true if it produced a response
async function runAgentLoop({ agent, roomId, topicId, history, workspacePath, isAgentChat, interAgentRound }) {
  const toolActivity = [];
  const tools = agent.tools_enabled ? TOOL_DEFINITIONS : [];

  // Build system prompt â€” add inter-agent context if needed
  let systemContent = agent.system_prompt || 'You are a helpful assistant.';
  if (agent.tools_enabled) {
    systemContent += '\n\nYou have tools available: read/write files, run commands, fetch URLs, search workspace files, and search past conversation topics by meaning (semantic search).';
  }
  if (isAgentChat) {
    systemContent += `\n\nYou are in a collaborative multi-agent discussion. Other AI agents have responded above. Add to the conversation only if you have something genuinely useful to contribute â€” a different perspective, correction, or important addition. If you agree and have nothing to add, reply with exactly: [PASS]`;
  }

  const messages = [
    { role: 'system', content: systemContent },
    ...history.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      // Label agent messages so agents know who said what
      content: m.role === 'assistant' ? `[${m.sender}]: ${m.content}` : m.content
    }))
  ];

  let iterations = 0;
  let finalContent = '';

  while (iterations < 8) {
    iterations++;
    const body = { model: agent.model, messages, stream: false };
    if (tools.length > 0) body.tools = tools;

    let data;
    try {
      const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      data = await res.json();
    } catch (err) {
      console.error(`[${agent.name}] Ollama error:`, err.message);
      return false;
    }

    const msg = data.message;
    if (!msg) break;

    // No tool calls â€” this is the final response
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      finalContent = (msg.content || '').trim();
      break;
    }

    // Execute tool calls
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });

    for (const tc of msg.tool_calls) {
      const toolName = tc.function.name;
      const args = typeof tc.function.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments;

      let result;
      try {
        if (toolName === 'search_topics') {
          result = await semanticSearch(roomId, args.query);
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

  // Skip [PASS] responses (agent had nothing to add)
  if (!finalContent || finalContent === '[PASS]' || finalContent.toLowerCase().startsWith('[pass]')) {
    console.log(`  [${agent.name}] passed (nothing to add)`);
    return false;
  }

  // Skip very short/agreement-only responses in inter-agent rounds
  if (isAgentChat && finalContent.length < 20) {
    console.log(`  [${agent.name}] response too short, skipping`);
    return false;
  }

  console.log(`  [${agent.name}] responded (${finalContent.length} chars)`);

  saveMessage({
    id: randomUUID(),
    roomId, topicId,
    sender: agent.name,
    content: finalContent,
    role: 'assistant',
    toolActivity: toolActivity.length > 0 ? JSON.stringify(toolActivity) : null,
    isAgentChat: isAgentChat ? 1 : 0
  });

  return true;
}

// â”€â”€ AUTO TOPIC SUGGESTION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function suggestTopicName(topicId, history, agent) {
  try {
    const prompt = `Based on this conversation, suggest a concise topic name (3-5 words max). Reply with ONLY the topic name, nothing else.\n\n${history.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 800)}`;
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: agent.model, messages: [{ role: 'user', content: prompt }], stream: false })
    });
    const data = await res.json();
    const suggested = data.message?.content?.trim().replace(/["'.]/g, '').slice(0, 40);
    if (suggested) {
      const { room_id } = db.prepare("SELECT room_id FROM topics WHERE id = ?").get(topicId) || {};
      if (room_id) {
        saveMessage({
          id: randomUUID(), roomId: room_id, topicId,
          sender: '__system__', content: `TOPIC_SUGGEST:${suggested}`, role: 'system'
        });
      }
    }
  } catch (_) {}
}

// â”€â”€ AGENTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/agents', (req, res) => {
  res.json(db.prepare(
    "SELECT a.* FROM agents a JOIN room_agents ra ON a.id = ra.agent_id WHERE ra.room_id = ?"
  ).all(req.query.roomId || 'main'));
});

app.post('/api/agents', (req, res) => {
  const { name, system_prompt, model, roomId, tools_enabled } = req.body;
  const id = randomUUID();
  db.prepare("INSERT INTO agents (id, name, system_prompt, model, active, tools_enabled) VALUES (?, ?, ?, ?, 1, ?)").run(id, name, system_prompt, model, tools_enabled !== false ? 1 : 0);
  db.prepare("INSERT INTO room_agents (room_id, agent_id) VALUES (?, ?)").run(roomId || 'main', id);
  res.json({ id });
});

app.delete('/api/agents/:id', (req, res) => {
  db.prepare("DELETE FROM agents WHERE id = ?").run(req.params.id);
  db.prepare("DELETE FROM room_agents WHERE agent_id = ?").run(req.params.id);
  res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nðŸš€ Agent Hub â†’ http://localhost:${PORT}`);
  console.log(`ðŸ“¡ Ollama â†’ ${OLLAMA_URL}`);
  console.log(`ðŸ§  Embed model â†’ ${EMBED_MODEL}`);
  console.log(`ðŸ’¬ Inter-agent rounds â†’ ${AGENT_ROUNDS}\n`);
});
