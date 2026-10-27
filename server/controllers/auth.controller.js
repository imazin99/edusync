const asyncHandler = require('../utils/asyncHandler');
const { SESSION_COOKIE_NAME } = require('../config/session');
function createAuthController({ models, authService } = {}) {
  const resolvedModels = models || require('../models');
  const { User } = resolvedModels;
  const auth = authService || require('../services/AuthService');
  function serializeUser(user, profile, kind) {
    const base = {
      id: user._id.toString(),
      username: user.username,
      role: user.role,
      hasPassword: !!user.passwordHash,
      lastLoginAt: user.lastLoginAt,
    };

    if (kind === 'student' && profile) {
      base.student = {
        studentCode: profile.studentCode,
        fullName: profile.fullName,
        group: profile.group,
      };
    } else if (kind === 'doctor' && profile) {
      base.doctor = { fullName: profile.fullName };
    } else if (kind === 'ta' && profile) {
      base.ta = { fullName: profile.fullName };
    } else if (kind === 'leader' && profile) {
      base.leader = { slot: profile.slot };
    }

    return base;
  }

  const login = asyncHandler(async (req, res) => {
    const { identifier, password } = req.body || {};
    const user = await auth.login({ identifier, password });
    const { kind, profile } = await auth.loadProfileForUser(user);

    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });
    req.session.userId = user._id.toString();
    req.session.role = user.role;
    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    res.status(200).json({ success: true, user: serializeUser(user, profile, kind) });
  });

  const logout = asyncHandler(async (req, res) => {
    if (req.session) {
      await new Promise((resolve) => req.session.destroy(() => resolve()));
    }
    res.clearCookie(SESSION_COOKIE_NAME);
    res.status(200).json({ success: true, message: 'Logged out' });
  });

  const me = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).select('+passwordHash');
    const { kind, profile } = await auth.loadProfileForUser(user);
    res.status(200).json({ success: true, user: serializeUser(user, profile, kind) });
  });

  const forgotPassword = asyncHandler(async (req, res) => {
    const { identifier } = req.body || {};
    await auth.requestPasswordReset({ identifier });
    res.status(200).json({
      success: true,
      message:
        'If an account matches that identifier, a password reset request has been sent to the Admin.',
    });
  });

  const createPassword = asyncHandler(async (req, res) => {
    const { password } = req.body || {};
    await auth.createPassword({ userId: req.user.id, password });
    res.status(201).json({ success: true, message: 'Password created.' });
  });

  const removePassword = asyncHandler(async (req, res) => {
    await auth.removePassword({ userId: req.user.id });
    res.status(200).json({
      success: true,
      message: 'Password removed. You can now log in with your Student Code only.',
    });
  });

  return { serializeUser, login, logout, me, forgotPassword, createPassword, removePassword };
}

const defaultAuthController = createAuthController();

module.exports = { createAuthController, ...defaultAuthController };
