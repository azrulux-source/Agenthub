# Agent Hub — Full Setup Guide
Multi-agent AI chat, shared rooms, persistence via Turso, deployed on Render.

---

## BEFORE YOU START — Things You Need

1. **Groq API key** → https://console.groq.com (free, you already have this)
2. **Turso account** → https://turso.tech (free tier is fine)
3. **Render account** → https://render.com (free tier is fine)
4. **Node.js 18+** installed on your machine

---

## STEP 1 — Create the project folder

```bash
mkdir agent-hub
cd agent-hub
```

Copy all the files from this pack into that folder:
```
agent-hub/
├── server.js
├── package.json
├── .env            ← you create this (see Step 2)
└── public/
    └── index.html
```

---

## STEP 2 — Create your .env file

Create a file called `.env` in the agent-hub folder.
Copy `.env.example` and fill it in:

```
GROQ_API_KEY=your_groq_key_here
TURSO_URL=libsql://your-db.turso.io
TURSO_TOKEN=your_turso_token_here
PORT=3000
```

How to get Turso credentials:

```bash
# Install Turso CLI
curl -sSfL https://get.tur.so/install.sh | bash

# Login
turso auth login

# Create your database
turso db create agent-hub

# Get the URL
turso db show agent-hub

# Get the token
turso db tokens create agent-hub
```

Paste those into your .env.

---

## STEP 3 — Install dependencies

```bash
npm install
```

---

## STEP 4 — Run locally

```bash
node server.js
```

You should see:
```
Agent Hub running on port 3000
```

Open http://localhost:3000 in your browser.

- Enter your name
- You'll land in "Main Room" with one agent called Atlas ready to go
- Chat with Atlas, create new rooms, add more agents

---

## STEP 5 — Test with your sister (local network)

If you're both on the same WiFi, find your local IP:
```bash
# Mac/Linux
ipconfig getifaddr en0

# Windows
ipconfig
```

She can open `http://YOUR_LOCAL_IP:3000` and join the same room.

---

## STEP 6 — Deploy to Render

1. Push the project to a GitHub repo:
```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USERNAME/agent-hub.git
git push -u origin main
```

Make sure `.gitignore` has:
```
node_modules
.env
```

2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Environment:** Node
5. Add environment variables (the same as your .env):
   - `GROQ_API_KEY`
   - `TURSO_URL`
   - `TURSO_TOKEN`
6. Click Deploy

Render gives you a URL like `https://agent-hub-xxxx.onrender.com`
Share that URL with your sister — she just opens it and enters her name.

---

## STEP 7 — Adding Agents

In the app, click **⚙ Agents** to open the agent panel.

Click **+ New Agent** and fill in:
- **Name** — whatever you want (e.g. "Sage", "Dev", "Critic")
- **System Prompt** — this is the agent's personality/job
- **Model** — pick a Groq model (see list below)
- **Color** — pick a distinct color so you can tell them apart

### Groq Models (free tier)
| Model | Good For |
|---|---|
| `llama-3.3-70b-versatile` | General purpose, smart |
| `llama-3.1-8b-instant` | Fast, lightweight |
| `mixtral-8x7b-32768` | Long context, good reasoning |
| `gemma2-9b-it` | Good at instructions |

### Example Agent Prompts

**Developer:**
```
You are Dev, a senior software engineer. You write clean, practical code.
You prefer minimal dependencies and always explain your reasoning briefly.
When reviewing code, be direct about problems.
```

**Critic:**
```
You are Critic. Your job is to challenge ideas and find weaknesses.
Be respectful but honest. Don't agree just to be agreeable.
Always ask "but what about..." and "have you considered...".
```

**Planner:**
```
You are Sage, a strategic thinker. You help break down complex problems
into clear steps. You ask clarifying questions before diving into solutions.
You think in systems and consider second-order effects.
```

---

## HOW IT WORKS

When you send a message:
1. Your message saves to Turso and broadcasts via SSE to everyone in the room
2. ALL active agents receive the message simultaneously
3. Each agent builds its own response using the conversation history
4. Responses stream back as they arrive (Groq is fast, usually 1-3 seconds)
5. Everything saves to Turso — history persists across refreshes and deploys

Your sister sees everything in real time via SSE — same as how Stockroom's
shipment updates work.

---

## ADDING MORE ROOMS

Click **+ New Room** in the sidebar. Rooms are isolated — agents respond
independently in each room. You could have:
- `Main` — general chat
- `Stockroom Help` — agents focused on your app
- `Brainstorm` — creative agents only

---

## TROUBLESHOOTING

**"Cannot connect to Turso"**
→ Check TURSO_URL starts with `libsql://` not `https://`
→ Check your token hasn't expired: `turso db tokens create agent-hub`

**"Groq 401 error"**
→ Your API key is wrong or missing from .env / Render env vars

**Agents not responding**
→ Check browser console for SSE errors
→ Check Render logs for API errors
→ Make sure agents have `active = 1` (toggle in the agent panel)

**Sister can't connect**
→ On Render: check the service is running (not sleeping — free tier sleeps)
→ Click the Render URL yourself first to wake it up
→ Upgrade to a paid Render instance ($7/mo) if you need it always-on

---

## WHAT'S NEXT (when you want to expand)

- **Ollama support**: add a provider field to agents, route to `localhost:11434` when provider = 'ollama'
- **Image support**: add file upload, pass images to vision models
- **Agent-to-agent**: let agents see each other's responses (currently each agent only sees user messages + its own history)
- **Webhooks**: trigger a room message from external events (e.g. Stockroom alerts)
- **Auth**: add simple password per room so it's not fully public
