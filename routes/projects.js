const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');

// Simple disk storage (swap for S3 in production)
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.glb', '.usdz'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// GET /projects — list user's projects
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    'SELECT * FROM projects WHERE user_id=$1 ORDER BY updated_at DESC',
    [req.user.id]
  );
  res.render('projects/list', { user: req.user, projects: rows });
});

// GET /projects/new
router.get('/new', requireAuth, (req, res) => {
  res.render('projects/new', { user: req.user, error: null });
});

// POST /projects — create project
router.post('/', requireAuth, async (req, res) => {
  const { name, address, space_type, area_m2 } = req.body;
  if (!name) return res.render('projects/new', { user: req.user, error: 'Project name is required.' });
  const { rows } = await db.query(
    `INSERT INTO projects (user_id, name, address, space_type, area_m2)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.user.id, name.trim(), address || '', space_type || 'interior', parseFloat(area_m2) || null]
  );
  res.redirect(`/projects/${rows[0].id}`);
});

// GET /projects/:id
router.get('/:id', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    'SELECT * FROM projects WHERE id=$1 AND user_id=$2',
    [req.params.id, req.user.id]
  );
  if (!rows.length) return res.redirect('/projects');
  // Also load any hire requests for this project
  const { rows: requests } = await db.query(
    `SELECT hr.*, u.name AS designer_name, u.avatar_url AS designer_avatar
     FROM hire_requests hr
     JOIN users u ON u.id = hr.designer_id
     WHERE hr.project_id=$1 AND hr.homeowner_id=$2
     ORDER BY hr.created_at DESC`,
    [req.params.id, req.user.id]
  );
  res.render('projects/detail', { user: req.user, project: rows[0], requests });
});

// DELETE /projects/:id
router.post('/:id/delete', requireAuth, async (req, res) => {
  await db.query('DELETE FROM projects WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.redirect('/projects');
});

// POST /projects/:id/sync — iOS app pushes scan/design data here
router.post('/:id/sync', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing API key' });

  // Verify API key maps to a user
  const { rows } = await db.query('SELECT id FROM users WHERE api_key=$1', [apiKey]);
  if (!rows.length) return res.status(401).json({ error: 'Invalid API key' });

  const userId = rows[0].id;
  const { name, address, space_type, area_m2, scan_data, design_data } = req.body;

  const existing = await db.query(
    'SELECT id FROM projects WHERE id=$1 AND user_id=$2',
    [req.params.id, userId]
  );
  if (!existing.rows.length) {
    // Create
    await db.query(
      `INSERT INTO projects (id, user_id, name, address, space_type, area_m2, scan_data, design_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.params.id, userId, name, address, space_type, area_m2,
       scan_data ? JSON.stringify(scan_data) : null,
       design_data ? JSON.stringify(design_data) : null]
    );
  } else {
    await db.query(
      `UPDATE projects SET name=$1, address=$2, space_type=$3, area_m2=$4,
       scan_data=$5, design_data=$6, updated_at=NOW() WHERE id=$7 AND user_id=$8`,
      [name, address, space_type, area_m2,
       scan_data ? JSON.stringify(scan_data) : null,
       design_data ? JSON.stringify(design_data) : null,
       req.params.id, userId]
    );
  }
  res.json({ ok: true });
});

module.exports = router;
