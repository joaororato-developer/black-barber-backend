import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import db from '../database/connection';
import { TokenService } from '../services/TokenService';

const setRefreshCookie = (res: Response, token: string) => {
  res.cookie('refresh_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
};

export const AuthController = {
  async register(req: Request, res: Response) {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      const existingUser = await db('users').where({ email }).first();
      if (existingUser) {
        return res.status(400).json({ error: 'User already exists' });
      }

      const password_hash = await bcrypt.hash(password, 12);
      const [newUser] = await db('users').insert({
        email,
        password_hash,
        role: 'admin',
      }).returning(['id', 'email', 'role']);

      return res.status(201).json({ user: newUser });
    } catch (error) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  async login(req: Request, res: Response) {
    try {
      const { email, password } = req.body;
      const user = await db('users').where({ email, role: 'admin' }).first();

      if (!user) return res.status(401).json({ error: 'Invalid credentials' });

      const isValidPassword = await bcrypt.compare(password, user.password_hash);
      if (!isValidPassword) return res.status(401).json({ error: 'Invalid credentials' });

      const payload = { id: user.id, role: 'admin' as const };
      const accessToken = TokenService.generateAccessToken(payload);
      const refreshToken = TokenService.generateRefreshToken(payload);

      setRefreshCookie(res, refreshToken);
      return res.json({
        user: { id: user.id, email: user.email, role: user.role },
        access_token: accessToken,
      });
    } catch (error) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  async refresh(req: Request, res: Response) {
    try {
      const refreshToken = req.cookies.refresh_token;
      if (!refreshToken) return res.status(401).json({ error: 'Refresh token not found' });

      try {
        const decoded = TokenService.verifyRefresh(refreshToken);
        const user = await db('users').where({ id: decoded.id }).first();
        if (!user) return res.status(404).json({ error: 'User not found' });

        const newAccessToken = TokenService.generateAccessToken({ id: user.id, role: user.role });
        return res.json({ access_token: newAccessToken });
      } catch {
        return res.status(403).json({ error: 'Invalid refresh token' });
      }
    } catch (error) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  async logout(_req: Request, res: Response) {
    res.clearCookie('refresh_token');
    return res.json({ message: 'Logged out successfully' });
  },
};
