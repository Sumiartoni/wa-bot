const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-this';
const TOKEN_EXPIRY = '24h';

/**
 * Generate JWT token for admin login
 */
function generateToken(username) {
  return jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

/**
 * Verify admin credentials
 */
function verifyCredentials(username, password) {
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  return username === adminUser && password === adminPass;
}

/**
 * Express middleware to protect routes
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token tidak ditemukan' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token tidak valid atau sudah expired' });
  }
}

module.exports = {
  generateToken,
  verifyCredentials,
  authMiddleware
};
