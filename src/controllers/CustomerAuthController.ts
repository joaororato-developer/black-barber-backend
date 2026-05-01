import { Request, Response } from 'express';
import db from '../database/connection';
import { MailService } from '../services/MailService';
import { TokenService } from '../services/TokenService';

import crypto from 'crypto';

const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_LOCK_MINUTES = 15;
const CODE_EXPIRY_MINUTES = 5;

const generateCode = () => crypto.randomInt(100000, 999999).toString();

const setRefreshCookie = (res: Response, token: string) => {
  res.cookie('refresh_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
};

export const CustomerAuthController = {
  /**
   * POST /api/customer/auth/send-code
   * Sends a 6-digit OTP to the customer's e-mail for login.
   * Reuses the same email_confirmations table with purpose='login'.
   */
  async sendCode(req: Request, res: Response) {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: 'E-mail é obrigatório.' });

      // Customer must already exist
      const customer = await db('customers').where({ email }).first();
      if (!customer) {
        return res.status(404).json({ error: 'Nenhuma conta encontrada com este e-mail.' });
      }

      // Check for active lock (RN-008)
      const locked = await db('email_confirmations')
        .where({ email, purpose: 'login', status: 'pending' })
        .where('locked_until', '>', new Date())
        .orderBy('sent_at', 'desc')
        .first();

      if (locked) {
        const remaining = Math.ceil(
          (new Date(locked.locked_until).getTime() - Date.now()) / 60000
        );
        return res.status(429).json({
          error: `Muitas tentativas. Aguarde ${remaining} min para tentar novamente.`,
        });
      }

      // Check for email flooding (max 3 codes per 15 minutes)
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
      const recentAttempts = await db('email_confirmations')
        .where({ email, purpose: 'login' })
        .where('sent_at', '>', fifteenMinutesAgo);

      if (recentAttempts.length >= 3) {
        return res.status(429).json({
          error: 'Muitos códigos solicitados. Aguarde 15 minutos antes de solicitar um novo.',
        });
      }

      const code = generateCode();
      const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);

      await db('email_confirmations').insert({
        email,
        code,
        purpose: 'login',
        expires_at: expiresAt,
      });

      await MailService.sendConfirmationCode(email, code);

      return res.json({ message: 'Código enviado para o seu e-mail.' });
    } catch (error) {
      console.error('[CustomerAuth.sendCode]', error);
      return res.status(500).json({ error: 'Erro interno.' });
    }
  },

  /**
   * POST /api/customer/auth/verify-code
   * Validates OTP, returns access_token + refresh_token for the customer.
   * Enforces rate limiting: 5 wrong attempts = 15 min lock (RN-008).
   */
  async verifyCode(req: Request, res: Response) {
    try {
      const { email, code } = req.body;
      if (!email || !code) return res.status(400).json({ error: 'E-mail e código são obrigatórios.' });

      // Find the most recent pending confirmation for login
      const confirmation = await db('email_confirmations')
        .where({ email, purpose: 'login', status: 'pending' })
        .where('expires_at', '>', new Date())
        .orderBy('sent_at', 'desc')
        .first();

      if (!confirmation) {
        return res.status(400).json({ error: 'Código expirado. Solicite um novo.' });
      }

      // Check lock
      if (confirmation.locked_until && new Date(confirmation.locked_until) > new Date()) {
        const remaining = Math.ceil(
          (new Date(confirmation.locked_until).getTime() - Date.now()) / 60000
        );
        return res.status(429).json({
          error: `Conta bloqueada. Aguarde ${remaining} min para tentar novamente.`,
        });
      }

      // Wrong code
      if (confirmation.code !== code) {
        const newAttempts = (confirmation.attempts || 0) + 1;
        const update: Record<string, any> = { attempts: newAttempts };

        if (newAttempts >= RATE_LIMIT_MAX_ATTEMPTS) {
          update.locked_until = new Date(Date.now() + RATE_LIMIT_LOCK_MINUTES * 60 * 1000);
          await db('email_confirmations').where({ id: confirmation.id }).update(update);
          return res.status(429).json({
            error: `Muitas tentativas erradas. Sua conta foi bloqueada por ${RATE_LIMIT_LOCK_MINUTES} minutos.`,
          });
        }

        await db('email_confirmations').where({ id: confirmation.id }).update(update);
        return res.status(400).json({
          error: `Código inválido. ${RATE_LIMIT_MAX_ATTEMPTS - newAttempts} tentativa(s) restante(s).`,
        });
      }

      // Valid code — mark as used
      await db('email_confirmations').where({ id: confirmation.id }).update({ status: 'received' });

      // Get customer + linked user
      const customer = await db('customers').where({ email }).first();
      if (!customer) return res.status(404).json({ error: 'Cliente não encontrado.' });

      const user = await db('users').where({ id: customer.user_id }).first();
      if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

      // Generate tokens
      const payload = { id: user.id, role: 'customer' as const };
      const accessToken = TokenService.generateAccessToken(payload);
      const refreshToken = TokenService.generateRefreshToken(payload);

      setRefreshCookie(res, refreshToken);

      return res.json({
        access_token: accessToken,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          name: customer.name,
          customerId: customer.id,
        },
      });
    } catch (error) {
      console.error('[CustomerAuth.verifyCode]', error);
      return res.status(500).json({ error: 'Erro interno.' });
    }
  },
};
