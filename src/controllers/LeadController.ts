import { Request, Response } from 'express';
import db from '../database/connection';
import { isValidCPF, isValidWhatsapp, isValidEmail } from '../utils/validators';
import { MailService } from '../services/MailService';
import jwt from 'jsonwebtoken';
import { TokenService } from '../services/TokenService';
import crypto from 'crypto';

const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_LOCK_MINUTES = 15;

const generateRandomCode = () => crypto.randomInt(100000, 999999).toString();

const setRefreshCookie = (res: Response, token: string) => {
  res.cookie('refresh_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
};

export const LeadController = {
  async emailConfirmation(req: Request, res: Response) {
    try {
      const { email, cpf, isReturning } = req.body;

      if (!email) return res.status(400).json({ error: 'E-mail is required' });
      if (!isValidEmail(email)) return res.status(400).json({ error: 'Formato de e-mail inválido.' });

      if (isReturning) {
        const customer = await db('customers').where({ email }).first();
        if (!customer) {
          return res.status(404).json({ error: 'Não encontramos uma conta com este e-mail.' });
        }
      } else {
        if (!cpf) return res.status(400).json({ error: 'CPF é obrigatório.' });
        if (!isValidCPF(cpf)) return res.status(400).json({ error: 'CPF inválido.' });

        const cleanCPF = cpf ? cpf.replace(/[^\d]/g, '') : '';
        const existingCustomer = await db('customers')
          .where({ email })
          .orWhere(function () {
            if (cleanCPF) this.where({ cpf: cleanCPF });
          })
          .first();

        if (existingCustomer) {
          return res.status(409).json({
            error: 'Já existe uma conta vinculada a este CPF ou e-mail. Por favor, realize o login para continuar sua compra.'
          });
        }
      }

      const locked = await db('email_confirmations')
        .where({ email, purpose: 'checkout', status: 'pending' })
        .where('locked_until', '>', new Date())
        .orderBy('sent_at', 'desc')
        .first();

      if (locked) {
        const remaining = Math.ceil(
          (new Date(locked.locked_until).getTime() - Date.now()) / 60000
        );
        return res.status(429).json({
          error: `Muitas tentativas erradas. Aguarde ${remaining} min para tentar novamente.`,
        });
      }

      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
      const recentAttempts = await db('email_confirmations')
        .where({ email, purpose: 'checkout' })
        .where('sent_at', '>', fifteenMinutesAgo);

      if (recentAttempts.length >= 5) {
        return res.status(429).json({
          error: 'Muitos códigos solicitados. Aguarde 15 minutos antes de solicitar um novo.',
        });
      }

      const code = generateRandomCode();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

      await db('email_confirmations').insert({
        email,
        code,
        purpose: 'checkout',
        expires_at: expiresAt,
      });

      await MailService.sendConfirmationCode(email, code);

      return res.status(200).json({ message: 'Confirmation code sent' });
    } catch (error) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  async verifyCode(req: Request, res: Response) {
    try {
      const { email, code, name, cpf, whatsapp, isReturning } = req.body;

      if (!email || !code) return res.status(400).json({ error: 'Missing required payload fields' });

      if (!isReturning) {
        if (!name || !cpf || !whatsapp) return res.status(400).json({ error: 'Missing required payload fields' });
        if (!isValidCPF(cpf)) return res.status(400).json({ error: 'Invalid CPF format' });
        if (!isValidWhatsapp(whatsapp)) return res.status(400).json({ error: 'Invalid WhatsApp format' });
      }

      const cleanCPF = cpf ? cpf.replace(/[^\d]/g, '') : '';

      const confirmation = await db('email_confirmations')
        .where({ email, purpose: 'checkout', status: 'pending' })
        .andWhere('expires_at', '>', new Date())
        .orderBy('sent_at', 'desc')
        .first();

      if (!confirmation) return res.status(400).json({ error: 'Código inválido ou expirado.' });

      if (confirmation.locked_until && new Date(confirmation.locked_until) > new Date()) {
        const remaining = Math.ceil((new Date(confirmation.locked_until).getTime() - Date.now()) / 60000);
        return res.status(429).json({ error: `Muitas tentativas. Aguarde ${remaining} min.` });
      }

      if (confirmation.code !== code) {
        const newAttempts = (confirmation.attempts || 0) + 1;
        const update: Record<string, any> = { attempts: newAttempts };

        if (newAttempts >= RATE_LIMIT_MAX_ATTEMPTS) {
          update.locked_until = new Date(Date.now() + RATE_LIMIT_LOCK_MINUTES * 60 * 1000);
          await db('email_confirmations').where({ id: confirmation.id }).update(update);
          return res.status(429).json({
            error: `Muitas tentativas erradas. Bloqueado por ${RATE_LIMIT_LOCK_MINUTES} minutos.`,
          });
        }

        await db('email_confirmations').where({ id: confirmation.id }).update(update);
        return res.status(400).json({
          error: `Código inválido.`,
        });
      }

      await db('email_confirmations').where({ id: confirmation.id }).update({ status: 'received' });

      let customer: any;

      if (isReturning) {
        customer = await db('customers').where({ email }).first();
        if (!customer) return res.status(404).json({ error: 'Conta não encontrada.' });
      } else {
        customer = await db('customers').where({ email }).orWhere({ cpf: cleanCPF }).first();

        if (customer) {
          if (customer.email !== email) {
            return res.status(409).json({ error: 'Este CPF já está associado a outro e-mail. Faça login ou use outro CPF.' });
          }
        } else {
          const [newCustomer] = await db('customers').insert({
            name,
            email,
            cpf: cleanCPF,
            whatsapp,
          }).returning('*');
          customer = newCustomer;

          const [newUser] = await db('users').insert({
            email,
            password_hash: '',
            role: 'customer',
          }).returning('*');

          await db('customers').where({ id: customer.id }).update({ user_id: newUser.id });
          customer.user_id = newUser.id;
        }
      }

      const activeSubscription = await db('subscriptions')
        .where('customer_id', customer.id)
        .andWhere('status', '!=', 'canceled')
        .first();

      if (activeSubscription) {
        return res.status(409).json({
          error: 'O e-mail informado já possui um plano ativo. Faça login para gerenciar sua assinatura.',
          code: 'ACTIVE_SUBSCRIPTION_EXISTS',
        });
      }

      const checkoutToken = jwt.sign(
        { customerId: customer.id },
        process.env.CHECKOUT_TOKEN_SECRET as string,
        { expiresIn: '2h' }
      );

      let accessToken: string | null = null;
      let refreshToken: string | null = null;

      if (customer.user_id) {
        const payload = { id: customer.user_id, role: 'customer' as const };
        accessToken = TokenService.generateAccessToken(payload);
        refreshToken = TokenService.generateRefreshToken(payload);
        setRefreshCookie(res, refreshToken);
      }

      return res.status(200).json({
        message: 'Código verificado com sucesso.',
        checkoutToken,
        access_token: accessToken,
        user: customer.user_id ? {
          id: customer.user_id,
          email: customer.email,
          role: 'customer',
          name: customer.name,
          customerId: customer.id,
        } : null,
      });
    } catch (error: any) {
      if (error.code === '23505') {
        return res.status(400).json({ error: 'E-mail ou CPF já cadastrados por outro usuário.' });
      }
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
};
