import { Response } from 'express';
import db from '../database/connection';
import { AuthRequest } from '../middlewares/auth';
import { isValidCPF, isValidWhatsapp } from '../utils/validators';
import crypto from 'crypto';
import { MailService } from '../services/MailService';

const generateCode = () => crypto.randomInt(100000, 999999).toString();
const CODE_EXPIRY_MINUTES = 5;

export const CustomerController = {
  async getProfile(req: AuthRequest, res: Response) {
    try {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const customer = await db('customers').where({ user_id: userId }).first();
      if (!customer) return res.status(404).json({ error: 'Customer profile not found' });

      return res.json(customer);
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  async requestEmailChange(req: AuthRequest, res: Response) {
    try {
      const userId = req.userId;
      const { newEmail } = req.body;

      if (!newEmail) return res.status(400).json({ error: 'Novo e-mail é obrigatório.' });

      // Check if email is already in use
      const existingEmail = await db('users').where({ email: newEmail }).first();
      if (existingEmail) {
        return res.status(409).json({ error: 'Este e-mail já está sendo utilizado por outra conta.' });
      }

      const code = generateCode();
      const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);

      await db('email_confirmations').insert({
        email: newEmail,
        code,
        purpose: 'email_change',
        expires_at: expiresAt,
      });

      await MailService.sendConfirmationCode(newEmail, code);

      return res.json({ message: 'Código de verificação enviado para o novo e-mail.' });
    } catch (error) {
      console.error('[CustomerController.requestEmailChange]', error);
      return res.status(500).json({ error: 'Erro interno ao enviar código.' });
    }
  },

  async updateProfile(req: AuthRequest, res: Response) {
    try {
      const userId = req.userId;
      const { name, email, cpf, whatsapp, code } = req.body;

      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      // Find current customer
      const currentCustomer = await db('customers').where({ user_id: userId }).first();
      if (!currentCustomer) return res.status(404).json({ error: 'Customer profile not found' });

      const isChangingEmail = email && email !== currentCustomer.email;

      // VALIDATE EMAIL CHANGE WITH OTP
      if (isChangingEmail) {
        if (!code) {
          return res.status(400).json({ error: 'Código de verificação é obrigatório para alterar o e-mail.' });
        }

        const confirmation = await db('email_confirmations')
          .where({ email, purpose: 'email_change', status: 'pending' })
          .where('expires_at', '>', new Date())
          .orderBy('sent_at', 'desc')
          .first();

        if (!confirmation || confirmation.code !== code) {
          return res.status(400).json({ error: 'Código de verificação inválido ou expirado.' });
        }

        // Mark code as used
        await db('email_confirmations').where({ id: confirmation.id }).update({ status: 'received' });
      }

      if (cpf && !isValidCPF(cpf)) {
        return res.status(400).json({ error: 'CPF inválido.' });
      }

      if (whatsapp && !isValidWhatsapp(whatsapp)) {
        return res.status(400).json({ error: 'WhatsApp inválido.' });
      }

      const cleanCPF = cpf ? cpf.replace(/[^\d]/g, '') : '';

      // Check for CPF duplication (if changing)
      if (cleanCPF && cleanCPF !== currentCustomer.cpf) {
        const existingCPF = await db('customers').where({ cpf: cleanCPF }).first();
        if (existingCPF) {
          return res.status(409).json({ error: 'Este CPF já está cadastrado em outra conta.' });
        }
      }

      await db.transaction(async (trx) => {
        // Update user table if email changed
        if (isChangingEmail) {
          await trx('users').where({ id: userId }).update({ email, updated_at: new Date() });
        }

        // Update customer table
        await trx('customers').where({ user_id: userId }).update({
          name: name || currentCustomer.name,
          email: email || currentCustomer.email,
          cpf: cleanCPF || currentCustomer.cpf,
          whatsapp: whatsapp || currentCustomer.whatsapp,
          updated_at: new Date()
        });
      });

      const updatedCustomer = await db('customers').where({ user_id: userId }).first();
      return res.json({ message: 'Perfil atualizado com sucesso!', customer: updatedCustomer });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
};
