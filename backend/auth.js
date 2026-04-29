const jwt = require('jsonwebtoken');
const db = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-this';

function generateToken(agent) {
  return jwt.sign({ id: agent.id, username: agent.username, name: agent.name, role: agent.role }, JWT_SECRET, { expiresIn: '24h' });
}

function verifyCredentials(username, password) {
  return db.getAgentByCredentials(username, password);
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token tidak ditemukan' });
  }
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token tidak valid atau expired' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Hanya admin yang bisa mengakses' });
  }
  next();
}

module.exports = { generateToken, verifyCredentials, authMiddleware, adminOnly };
