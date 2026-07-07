const router = require('express').Router();
const bcrypt = require('bcryptjs');
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
    // Create designer profile row if designer
    if (validRole === 'designer') {
      await db.query(
        'INSERT INTO designer_profiles (user_id) VALUES ($1)',
        [user.id]
      );
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

module.exports = router;
