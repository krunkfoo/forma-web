require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const db = require('./db');
const { optionalAuth, requireAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(optionalAuth);  // attach req.user if token present

// Pass user to all templates
app.use((req, res, next) => {
  res.locals.user = req.user || null;
  next();
});

// ── Diagnostic (remove after fix) ───────────────────────────
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ db: 'ok', node_env: process.env.NODE_ENV, has_db_url: !!process.env.DATABASE_URL });
  } catch (err) {
    res.status(500).json({ db: 'error', message: err.message, code: err.code, node_env: process.env.NODE_ENV, has_db_url: !!process.env.DATABASE_URL });
  }
});

// ── Routes ──────────────────────────────────────────────────
app.use('/', require('./routes/auth'));
app.use('/projects', require('./routes/projects'));
app.use('/designers', require('./routes/designers'));
app.use('/', require('./routes/scans'));

// Landing page
app.get('/', (req, res) => {
  res.render('index');
});

// Dashboard
app.get('/dashboard', requireAuth, async (req, res) => {
  const user = req.user;
  let projects = [], requests = [], scans = [];

  if (user.role === 'homeowner') {
    const { rows } = await db.query(
      'SELECT * FROM projects WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 6',
      [user.id]
    );
    projects = rows;

    const { rows: scanRows } = await db.query(
      'SELECT * FROM scans WHERE user_id=$1 ORDER BY created_at DESC LIMIT 6',
      [user.id]
    );
    scans = scanRows;
  } else if (user.role === 'designer') {
    const { rows } = await db.query(
      `SELECT hr.*, u.name AS homeowner_name
       FROM hire_requests hr
       JOIN users u ON u.id = hr.homeowner_id
       WHERE hr.designer_id=$1 AND hr.status='pending'
       ORDER BY hr.created_at DESC LIMIT 5`,
      [user.id]
    );
    requests = rows;
  }

  res.render('dashboard', {
    user,
    projects,
    requests,
    scans,
    hired: req.query.hired === '1',
  });
});

// ── DB init + start ─────────────────────────────────────────
async function start() {
  try {
    // Apply schema on first start (idempotent — uses IF NOT EXISTS)
    const fs = require('fs');
    const schema = fs.readFileSync(path.join(__dirname, 'db/schema.sql'), 'utf8');
    await db.query(schema);
    console.log('✓ Database schema applied');
  } catch (err) {
    console.warn('Schema apply warning (may be fine if already exists):', err.message);
  }

  app.listen(PORT, () => {
    console.log(`✓ Forma web running on http://localhost:${PORT}`);
  });
}

start();
