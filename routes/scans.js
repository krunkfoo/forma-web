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

module.exports = router;
