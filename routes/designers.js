const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireDesigner } = require('../middleware/auth');

// GET /designers — marketplace browse
router.get('/', async (req, res) => {
  const { specialty, q } = req.query;
  let sql = `
    SELECT u.id, u.name, u.avatar_url, dp.bio, dp.specialties,
           dp.location, dp.rate_per_hr, dp.rating, dp.review_count, dp.available
    FROM designer_profiles dp
    JOIN users u ON u.id = dp.user_id
    WHERE dp.available = TRUE
  `;
  const params = [];
  if (specialty) {
    params.push(specialty);
    sql += ` AND $${params.length} = ANY(dp.specialties)`;
  }
  if (q) {
    params.push(`%${q}%`);
    sql += ` AND (u.name ILIKE $${params.length} OR dp.bio ILIKE $${params.length} OR dp.location ILIKE $${params.length})`;
  }
  sql += ' ORDER BY dp.rating DESC, dp.review_count DESC';

  const { rows } = await db.query(sql, params);
  res.render('designers/list', { user: req.user, designers: rows, specialty: specialty || '', q: q || '' });
});

// GET /designers/:id — designer public profile
router.get('/:id', async (req, res) => {
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.avatar_url, u.created_at,
            dp.bio, dp.specialties, dp.location, dp.rate_per_hr,
            dp.rating, dp.review_count, dp.portfolio, dp.available
     FROM designer_profiles dp
     JOIN users u ON u.id = dp.user_id
     WHERE u.id=$1`,
    [req.params.id]
  );
  if (!rows.length) return res.redirect('/designers');

  const { rows: reviews } = await db.query(
    `SELECT r.rating, r.comment, r.created_at, u.name AS reviewer_name
     FROM reviews r JOIN users u ON u.id = r.reviewer_id
     WHERE r.designer_id=$1 ORDER BY r.created_at DESC LIMIT 10`,
    [req.params.id]
  );

  // Load homeowner's projects for hire form
  let projects = [];
  if (req.user?.role === 'homeowner') {
    const { rows: projs } = await db.query(
      'SELECT id, name FROM projects WHERE user_id=$1 ORDER BY updated_at DESC',
      [req.user.id]
    );
    projects = projs;
  }

  res.render('designers/profile', {
    user: req.user,
    designer: rows[0],
    reviews,
    projects,
    hired: false,
  });
});

// POST /designers/:id/hire — homeowner sends hire request
router.post('/:id/hire', requireAuth, async (req, res) => {
  if (req.user.role !== 'homeowner') return res.redirect(`/designers/${req.params.id}`);
  const { project_id, message, budget } = req.body;

  // Prevent duplicate pending request
  const existing = await db.query(
    `SELECT id FROM hire_requests
     WHERE homeowner_id=$1 AND designer_id=$2 AND status='pending'`,
    [req.user.id, req.params.id]
  );
  if (!existing.rows.length) {
    await db.query(
      `INSERT INTO hire_requests (homeowner_id, designer_id, project_id, message, budget)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.user.id, req.params.id,
       project_id || null,
       message || '', parseFloat(budget) || null]
    );
  }
  res.redirect('/dashboard?hired=1');
});

// GET /designers/me/edit — designer edits own profile
router.get('/me/edit', requireDesigner, async (req, res) => {
  const { rows } = await db.query(
    'SELECT * FROM designer_profiles WHERE user_id=$1', [req.user.id]
  );
  res.render('designers/edit', { user: req.user, profile: rows[0] || {}, error: null });
});

// POST /designers/me/edit
router.post('/me/edit', requireDesigner, async (req, res) => {
  const { bio, specialties, location, rate_per_hr, available } = req.body;
  const specialtyArr = Array.isArray(specialties)
    ? specialties
    : (specialties || '').split(',').map(s => s.trim()).filter(Boolean);

  await db.query(
    `UPDATE designer_profiles
     SET bio=$1, specialties=$2, location=$3, rate_per_hr=$4, available=$5
     WHERE user_id=$6`,
    [bio, specialtyArr, location, parseFloat(rate_per_hr) || null,
     available === 'on' || available === 'true', req.user.id]
  );
  res.redirect('/dashboard');
});

// GET /designers/me/requests — designer sees incoming requests
router.get('/me/requests', requireDesigner, async (req, res) => {
  const { rows } = await db.query(
    `SELECT hr.*, u.name AS homeowner_name, u.email AS homeowner_email,
            p.name AS project_name, p.space_type, p.area_m2
     FROM hire_requests hr
     JOIN users u ON u.id = hr.homeowner_id
     LEFT JOIN projects p ON p.id = hr.project_id
     WHERE hr.designer_id=$1
     ORDER BY hr.created_at DESC`,
    [req.user.id]
  );
  res.render('designers/requests', { user: req.user, requests: rows });
});

// POST /designers/me/requests/:id/respond
router.post('/me/requests/:id/respond', requireDesigner, async (req, res) => {
  const { action } = req.body; // 'accept' | 'decline'
  if (!['accept', 'decline'].includes(action)) return res.redirect('/designers/me/requests');
  await db.query(
    `UPDATE hire_requests SET status=$1 WHERE id=$2 AND designer_id=$3`,
    [action === 'accept' ? 'accepted' : 'declined', req.params.id, req.user.id]
  );
  res.redirect('/designers/me/requests');
});

module.exports = router;
