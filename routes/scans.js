const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');

// Web viewer — renders the scan EJS page
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
