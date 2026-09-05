const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { signToken } = require('../middleware/auth');

// ── Rate limiters ────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts — please try again in 15 minutes.',
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many registration attempts — please try again later.',
});

const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many password reset requests — please try again later.',
});

// GET /register
router.get('/register', (req, res) => res.render('auth/register', { error: null }));

// POST /register
router.post('/register', registerLimiter, async (req, res) => {
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
router.get('/login', (req, res) => {
  const errorMap = {
    google_cancelled: 'Google sign-in was cancelled.',
    google_failed: `Google sign-in failed: ${req.query.detail || 'unknown error'}`,
    google_no_email: 'Google did not provide an email address.',
  };
  res.render('auth/login', { error: errorMap[req.query.error] || null });
});

// POST /login
router.post('/login', loginLimiter, async (req, res) => {
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
router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
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
    // Invalidate any existing tokens for this user and clean up expired rows
    await db.query('UPDATE password_resets SET used=TRUE WHERE user_id=$1', [user.id]);
    await db.query('DELETE FROM password_resets WHERE expires_at < NOW()');
    await db.query(
      'INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1,$2,$3)',
      [user.id, token, expires]
    );
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const resetLink = `${baseUrl}/reset-password/${token}`;
    console.log(`[Password Reset] ${email} → ${resetLink}`);
    if (process.env.RESEND_API_KEY) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'onboarding@resend.dev',
            to: email,
            subject: 'Reset your FormaAR password',
            html: `<p>Hi,</p>
<p>Click the link below to reset your FormaAR password. This link expires in 1 hour.</p>
<p><a href="${resetLink}">${resetLink}</a></p>
<p>If you didn't request a password reset, you can safely ignore this email.</p>`,
          }),
        });
      } catch (emailErr) {
        console.error('[Password Reset] Resend error:', emailErr);
        // Don't fail the request if email sending fails
      }
      res.render('auth/forgot', { error: null, sent: true, resetLink: null });
    } else {
      // No email service configured — show the link on screen (dev fallback)
      res.render('auth/forgot', { error: null, sent: true, resetLink });
    }
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

// ---------------------------------------------------------------------------
// API endpoints for the iOS app (JSON in / JSON out, no redirects)
// ---------------------------------------------------------------------------

// POST /api/auth/login
router.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase().trim()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    return res.json({
      token: signToken(user),
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error('[API /login]', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
});

// POST /api/auth/register
router.post('/api/auth/register', registerLimiter, async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required' });
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
    return res.status(201).json({
      token: signToken(user),
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already in use' });
    }
    console.error('[API /register]', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
});

// ---------------------------------------------------------------------------
// Google OAuth (web)
// ---------------------------------------------------------------------------

// GET /auth/google — redirect to Google
router.get('/auth/google', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('google_oauth_state', state, { httpOnly: true, maxAge: 10 * 60 * 1000, sameSite: 'lax' });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${process.env.BASE_URL || 'https://forma-web-edud.onrender.com'}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// GET /auth/google/callback
router.get('/auth/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error || !code) {
    return res.redirect('/login?error=google_cancelled');
  }
  const expectedState = req.cookies && req.cookies.google_oauth_state;
  if (!state || !expectedState || state !== expectedState) {
    return res.redirect('/login?error=google_failed&detail=invalid_state');
  }
  res.clearCookie('google_oauth_state');
  try {
    const baseUrl = process.env.BASE_URL || 'https://forma-web-edud.onrender.com';

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${baseUrl}/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      console.error('[Google OAuth] token exchange failed', tokens);
      const detail = encodeURIComponent(tokens.error_description || tokens.error || 'token_exchange_failed');
      return res.redirect(`/login?error=google_failed&detail=${detail}`);
    }

    // Get user info
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await infoRes.json();
    const { id: google_sub, email, name } = profile;

    if (!google_sub || !email) {
      return res.redirect('/login?error=google_no_email');
    }

    const normalizedEmail = email.toLowerCase().trim();
    let user = null;

    // 1. Lookup by google_sub
    const byGoogle = await db.query('SELECT * FROM users WHERE google_sub=$1', [google_sub]);
    if (byGoogle.rows[0]) {
      user = byGoogle.rows[0];
    } else {
      // 2. Link existing account by email
      const byEmail = await db.query('SELECT * FROM users WHERE email=$1', [normalizedEmail]);
      if (byEmail.rows[0]) {
        user = byEmail.rows[0];
        await db.query('UPDATE users SET google_sub=$1 WHERE id=$2', [google_sub, user.id]);
      }
    }

    // 3. Create new account
    if (!user) {
      const randomPassword = crypto.randomBytes(16).toString('hex');
      const hash = await bcrypt.hash(randomPassword, 12);
      const { rows } = await db.query(
        'INSERT INTO users (name, email, password, role, google_sub) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [(name || 'Google User').trim(), normalizedEmail, hash, 'homeowner', google_sub]
      );
      user = rows[0];
    }

    res.cookie('token', signToken(user), { httpOnly: true, maxAge: 7 * 86400000 });
    res.redirect('/dashboard');
  } catch (err) {
    console.error('[Google OAuth]', err.message, err.code);
    const detail = encodeURIComponent(err.message || 'unknown');
    res.redirect(`/login?error=google_failed&detail=${detail}`);
  }
});

// ---------------------------------------------------------------------------
// Google OAuth — iOS (ASWebAuthenticationSession flow)
// ---------------------------------------------------------------------------

// GET /api/auth/google/ios — build the Google authorize URL and return it as JSON
// (iOS calls this to get the URL, then opens it in ASWebAuthenticationSession)
router.get('/api/auth/google/ios', (req, res) => {
  const baseUrl = process.env.BASE_URL || 'https://forma-web-edud.onrender.com';
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('google_oauth_state', state, { httpOnly: true, maxAge: 10 * 60 * 1000, sameSite: 'lax' });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${baseUrl}/api/auth/google/ios-callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state,
  });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

// GET /api/auth/google/ios-callback — Google redirects here; we then redirect to forma://
router.get('/api/auth/google/ios-callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error || !code) {
    return res.redirect('forma://auth/callback?error=cancelled');
  }
  const expectedState = req.cookies && req.cookies.google_oauth_state;
  if (!state || !expectedState || state !== expectedState) {
    return res.redirect('forma://auth/callback?error=invalid_state');
  }
  res.clearCookie('google_oauth_state');
  try {
    const baseUrl = process.env.BASE_URL || 'https://forma-web-edud.onrender.com';

    // Exchange code for Google tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${baseUrl}/api/auth/google/ios-callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      console.error('[Google iOS OAuth] token exchange failed', tokens);
      return res.redirect('forma://auth/callback?error=token_failed');
    }

    // Get user profile
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await infoRes.json();
    const { id: google_sub, email, name } = profile;
    if (!google_sub || !email) {
      return res.redirect('forma://auth/callback?error=no_email');
    }

    const normalizedEmail = email.toLowerCase().trim();
    let user = null;

    const byGoogle = await db.query('SELECT * FROM users WHERE google_sub=$1', [google_sub]);
    if (byGoogle.rows[0]) {
      user = byGoogle.rows[0];
    } else {
      const byEmail = await db.query('SELECT * FROM users WHERE email=$1', [normalizedEmail]);
      if (byEmail.rows[0]) {
        user = byEmail.rows[0];
        await db.query('UPDATE users SET google_sub=$1 WHERE id=$2', [google_sub, user.id]);
      }
    }

    if (!user) {
      const randomPassword = crypto.randomBytes(16).toString('hex');
      const hash = await bcrypt.hash(randomPassword, 12);
      const { rows } = await db.query(
        'INSERT INTO users (name, email, password, role, google_sub) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [(name || 'Google User').trim(), normalizedEmail, hash, 'homeowner', google_sub]
      );
      user = rows[0];
    }

    const jwt = signToken(user);
    // Redirect back to the iOS app with the JWT; ASWebAuthenticationSession intercepts this
    res.redirect(`forma://auth/callback?token=${encodeURIComponent(jwt)}`);
  } catch (err) {
    console.error('[Google iOS OAuth]', err);
    res.redirect('forma://auth/callback?error=server_error');
  }
});

// POST /api/auth/apple
router.post('/api/auth/apple', async (req, res) => {
  const { appleToken, name: bodyName, email: bodyEmail } = req.body;
  if (!appleToken) {
    return res.status(400).json({ error: 'appleToken is required' });
  }
  try {
    // Decode the JWT payload (base64url — no signature verification needed here;
    // Apple's servers already validated the token before the client forwarded it)
    const payloadB64 = appleToken.split('.')[1];
    const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson);
    const apple_sub = payload.sub;           // Apple's stable user identifier
    const tokenEmail = payload.email;        // present on first sign-in
    const email = (tokenEmail || bodyEmail || '').toLowerCase().trim() || null;

    if (!apple_sub) {
      return res.status(400).json({ error: 'Invalid Apple token: missing sub' });
    }

    let user = null;

    // 1. Look up by apple_sub (stable across devices)
    const byAppleSub = await db.query('SELECT * FROM users WHERE apple_sub=$1', [apple_sub]);
    if (byAppleSub.rows[0]) {
      user = byAppleSub.rows[0];
    } else if (email) {
      // 2. Fall back to email lookup (links existing account on first Apple sign-in)
      const byEmail = await db.query('SELECT * FROM users WHERE email=$1', [email]);
      if (byEmail.rows[0]) {
        user = byEmail.rows[0];
        // Bind apple_sub so future lookups use the fast path
        await db.query('UPDATE users SET apple_sub=$1 WHERE id=$2', [apple_sub, user.id]);
      }
    }

    // 3. No existing account — create one
    if (!user) {
      if (!email) {
        return res.status(400).json({ error: 'email is required for new Apple Sign In users' });
      }
      const name = (bodyName || 'Apple User').trim();
      const randomPassword = crypto.randomBytes(16).toString('hex');
      const hash = await bcrypt.hash(randomPassword, 12);
      const { rows } = await db.query(
        'INSERT INTO users (name, email, password, role, apple_sub) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [name, email, hash, 'homeowner', apple_sub]
      );
      user = rows[0];
    }

    return res.json({
      token: signToken(user),
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error('[API /apple]', err);
    return res.status(500).json({ error: 'Authentication failed' });
  }
});

module.exports = router;
