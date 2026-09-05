const router = require('express').Router();
const db     = require('../db');
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { requireAuth, requireApiAuth } = require('../middleware/auth');

const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const thumbStorage = multer.diskStorage({
  destination: uploadDir,
  filename: (_, file, cb) => cb(null, `thumb-${Date.now()}${path.extname(file.originalname)}`)
});
const videoStorage = multer.diskStorage({
  destination: uploadDir,
  filename: (_, file, cb) => cb(null, `video-${Date.now()}${path.extname(file.originalname)}`)
});
const uploadThumb = multer({ storage: thumbStorage, limits: { fileSize: 5 * 1024 * 1024 } });
const uploadVideo = multer({ storage: videoStorage, limits: { fileSize: 500 * 1024 * 1024 } });

// ── API: create scan (called from iOS) ────────────────────────────────────────
router.post('/api/scans', requireApiAuth, async (req, res) => {
  try {
    const { name, space_type, area_m2, room_snapshot, site_plan, scan_metadata } = req.body;
    const { rows } = await db.query(
      `INSERT INTO scans (user_id, name, space_type, area_m2, room_snapshot, site_plan, scan_metadata, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'completed')
       RETURNING id, name, space_type, area_m2, created_at`,
      [req.user.id, name, space_type, area_m2 || null,
       room_snapshot ? JSON.stringify(room_snapshot) : null,
       site_plan     ? JSON.stringify(site_plan)     : null,
       scan_metadata ? JSON.stringify(scan_metadata) : null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('POST /api/scans error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── API: list scans ────────────────────────────────────────────────────────────
router.get('/api/scans', requireApiAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id,name,space_type,area_m2,thumbnail_url,status,created_at FROM scans WHERE user_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── API: get scan ──────────────────────────────────────────────────────────────
router.get('/api/scans/:id', requireApiAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM scans WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── API: upload thumbnail ──────────────────────────────────────────────────────
router.post('/api/scans/:id/thumbnail', requireApiAuth, uploadThumb.single('thumbnail'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const thumbUrl = `/uploads/${req.file.filename}`;
    await db.query('UPDATE scans SET thumbnail_url=$1 WHERE id=$2 AND user_id=$3',
      [thumbUrl, req.params.id, req.user.id]);
    res.json({ thumbnail_url: thumbUrl });
  } catch (err) {
    console.error('thumbnail upload error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── API: upload video ──────────────────────────────────────────────────────────
router.post('/api/scans/:id/video', requireApiAuth, uploadVideo.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const videoUrl = `/uploads/${req.file.filename}`;
    await db.query('UPDATE scans SET video_url=$1 WHERE id=$2 AND user_id=$3',
      [videoUrl, req.params.id, req.user.id]);
    // Create processing job for LingBot-Map
    const { rows } = await db.query(
      `INSERT INTO processing_jobs (scan_id, type, status) VALUES ($1,'lingbot_map','queued') RETURNING id`,
      [req.params.id]
    );
    res.json({ video_url: videoUrl, job_id: rows[0].id });
  } catch (err) {
    console.error('video upload error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── API: get processing job status ────────────────────────────────────────────
router.get('/api/scans/:id/job', requireApiAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM processing_jobs WHERE scan_id=$1 ORDER BY created_at DESC LIMIT 1',
      [req.params.id]
    );
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});


// ── API: update scan (plan editor save) ───────────────────────────────────────
router.patch('/api/scans/:id', requireApiAuth, async (req, res) => {
  try {
    const { room_snapshot, site_plan } = req.body;
    const updates = [];
    const vals = [];
    let idx = 1;
    if (room_snapshot !== undefined) { updates.push(`room_snapshot=$${idx++}`); vals.push(JSON.stringify(room_snapshot)); }
    if (site_plan     !== undefined) { updates.push(`site_plan=$${idx++}`);     vals.push(JSON.stringify(site_plan)); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id, req.user.id);
    await db.query(
      `UPDATE scans SET ${updates.join(',')} WHERE id=$${idx} AND user_id=$${idx+1}`,
      vals
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /api/scans/:id error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Web viewer ─────────────────────────────────────────────────────────────────
router.get('/:id/view', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM scans WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).send('Scan not found');
    res.render('scan', { scan: rows[0], user: req.user });
  } catch (err) {
    console.error('GET /scans/:id/view error', err);
    res.status(500).send('Server error');
  }
});


// ── AI design assistant ───────────────────────────────────────────────────────
router.post('/api/scans/:id/suggest', requireApiAuth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });

    const { rows } = await db.query(
      'SELECT name, space_type, area_m2, room_snapshot, site_plan FROM scans WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const scan = rows[0];

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'AI not configured' });

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    // Build context from scan data
    let context = `Space: ${scan.name}, Type: ${scan.space_type}`;
    if (scan.area_m2) context += `, Area: ${Math.round(scan.area_m2)} m²`;

    if (scan.space_type === 'interior' && scan.room_snapshot) {
      const snap = scan.room_snapshot;
      context += `\nWalls: ${(snap.walls||[]).length}`;
      context += `\nCeiling height: ${snap.ceilingHeightM ? snap.ceilingHeightM.toFixed(1) + 'm' : 'unknown'}`;
      if (snap.furniture && snap.furniture.length) {
        const items = snap.furniture.map(f => `${f.label||f.type} (${f.width?.toFixed(1)}m × ${f.depth?.toFixed(1)||f.height?.toFixed(1)}m)`).join(', ');
        context += `\nFurniture detected: ${items}`;
      }
      if (snap.openings && snap.openings.length) {
        const doors = snap.openings.filter(o => (o.kind||o.type||'').includes('door')).length;
        const windows = snap.openings.filter(o => (o.kind||o.type||'').includes('window')).length;
        context += `\nDoors: ${doors}, Windows: ${windows}`;
      }
    }

    if (scan.space_type === 'outdoor' && scan.site_plan) {
      const plan = scan.site_plan;
      if (plan.features && plan.features.length) {
        const featureSummary = plan.features.reduce((acc, f) => {
          const t = f.type || f.label || 'unknown';
          acc[t] = (acc[t] || 0) + 1;
          return acc;
        }, {});
        context += `\nOutdoor features: ${Object.entries(featureSummary).map(([k,v]) => `${v} ${k}`).join(', ')}`;
      }
    }

    const systemPrompt = `You are an expert interior and landscape designer. The user has scanned their space using LiDAR and you have access to the actual measurements and detected objects. Give specific, actionable advice based on the real data provided. Be concise — 2-4 sentences max unless the user asks for more detail. Use metric measurements.

Scan data:
${context}`;

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }]
    });

    res.json({ reply: response.content[0].text });
  } catch (err) {
    console.error('AI suggest error', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

module.exports = router;
