const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { signToken } = require('../middleware/auth');

// GET /register
router.get('/register', (req, res) => res.render('auth/register', { error: null }));

// POST /register
router.post('/register', async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) {
    return res.render('auth/register', { error: 'All fields are required.' });
  }
  const validRole = ['homeowner', 'designer'].includes(role) ? role : 'homeowner';
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await db.query(
      'INSERT INTO users (name, email, password, role) VALUES ($1,$2,$3,$4) RETURNING *',
      [name.trim(), email.toLowerCase().trim(), hash, validRole]
    );
    const user = rows[0];
    if (validRole === 'designer') {
      await db.query('INSERT INTO designer_profiles (user_id) VALUES ($1)', [user.id]);
    }
    res.cookie('token', signToken(user), { httpOnly: true, maxAge: 7 * 86400000 });
    res.redirect('/dashboard');
  } catch (err) {
    if (err.code === '23505') {
      return res.render('auth/register', { error: 'Email already in use.' });
    }
    console.error(err);
    res.render('auth/register', { error: 'Something went wrong. Please try again.' });
  }
});

// GET /login
router.get('/login', (req, res) => res.render('auth/login', { error: null }));

// POST /login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.render('auth/login', { error: 'Enter your email and password.' });
  }
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase().trim()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.render('auth/login', { error: 'Invalid email or password.' });
    }
    res.cookie('token', signToken(user), { httpOnly: true, maxAge: 7 * 86400000 });
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.render('auth/login', { error: 'Something went wrong.' });
  }
});

// POST /logout
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.redirect('/');
});

// GET /forgot-password
router.get('/forgot-password', (req, res) => {
  res.render('auth/forgot', { error: null, sent: false, resetLink: null });
});

// POST /forgot-password
router.post('/forgot-password', async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  if (!email) {
    return res.render('auth/forgot', { error: 'Enter your email address.', sent: false, resetLink: null });
  }
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE email=$1', [email]);
    if (!rows[0]) {
      // Don't reveal whether the email exists
      return res.render('auth/forgot', { error: null, sent: true, resetLink: null });
    }
    const user = rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    // Invalidate any existing tokens for this user
    await db.query('UPDATE password_resets SET used=TRUE WHERE user_id=$1', [user.id]);
    await db.query(
      'INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1,$2,$3)',
      [user.id, token, expires]
    );
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const resetLink = `${baseUrl}/reset-password/${token}`;
    console.log(`[Password Reset] ${email} → ${resetLink}`);
    // Show reset link directly (no email service yet — add Resend/SendGrid later)
    res.render('auth/forgot', { error: null, sent: true, resetLink });
  } catch (err) {
    console.error(err);
    res.render('auth/forgot', { error: 'Something went wrong. Please try again.', sent: false, resetLink: null });
  }
});

// GET /reset-password/:token
router.get('/reset-password/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const { rows } = await db.query(
      'SELECT * FROM password_resets WHERE token=$1 AND used=FALSE AND expires_at > NOW()',
      [token]
    );
    if (!rows[0]) {
      return res.render('auth/reset', { error: 'This reset link is invalid or has expired.', token: null, success: false });
    }
    res.render('auth/reset', { error: null, token, success: false });
  } catch (err) {
    console.error(err);
    res.render('auth/reset', { error: 'Something went wrong.', token: null, success: false });
  }
});

// POST /reset-password/:token
router.post('/reset-password/:token', async (req, res) => {
  const { token } = req.params;
  const { password, confirm } = req.body;
  if (!password || password.length < 8) {
    return res.render('auth/reset', { error: 'Password must be at least 8 characters.', token, success: false });
  }
  if (password !== confirm) {
    return res.render('auth/reset', { error: 'Passwords do not match.', token, success: false });
  }
  try {
    const { rows } = await db.query(
      'SELECT * FROM password_resets WHERE token=$1 AND used=FALSE AND expires_at > NOW()',
      [token]
    );
    if (!rows[0]) {
      return res.render('auth/reset', { error: 'This reset link is invalid or has expired.', token: null, success: false });
    }
    const reset = rows[0];
    const hash = await bcrypt.hash(password, 12);
    await db.query('UPDATE users SET password=$1 WHERE id=$2', [hash, reset.user_id]);
    await db.query('UPDATE password_resets SET used=TRUE WHERE id=$1', [reset.id]);
    res.render('auth/reset', { error: null, token: null, success: true });
  } catch (err) {
    console.error(err);
    res.render('auth/reset', { error: 'Something went wrong.', token, success: false });
  }
});

module.exports = router;
