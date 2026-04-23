import { Request, Response } from 'express';
import db from '../database/connection';
import { isValidCPF, isValidWhatsapp } from '../utils/validators';
import { MailService } from '../services/MailService';

const generateRandomCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

export const LeadController = {
  async emailConfirmation(req: Request, res: Response) {
    try {
      const { email, isReturning } = req.body;

      if (!email) {
        return res.status(400).json({ error: 'E-mail is required' });
      }

      if (isReturning) {
        const customer = await db('customers').where({ email }).first();
        if (!customer) {
          return res.status(404).json({ error: 'Não encontramos uma conta com este e-mail.' });
        }
      }

      const code = generateRandomCode();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

      await db('email_confirmations').insert({
        email,
        code,
        expires_at: expiresAt
      });

      await MailService.sendConfirmationCode(email, code);

      return res.status(200).json({ message: 'Confirmation code sent' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  async verifyCode(req: Request, res: Response) {
    try {
      const { email, code, name, cpf, whatsapp, isReturning } = req.body;

      if (!email || !code) {
        return res.status(400).json({ error: 'Missing required payload fields' });
      }

      if (!isReturning) {
        if (!name || !cpf || !whatsapp) {
          return res.status(400).json({ error: 'Missing required payload fields' });
        }

        if (!isValidCPF(cpf)) {
          return res.status(400).json({ error: 'Invalid CPF format' });
        }

        if (!isValidWhatsapp(whatsapp)) {
          return res.status(400).json({ error: 'Invalid WhatsApp format' });
        }
      }

      const cleanCPF = cpf ? cpf.replace(/[^\d]/g, '') : '';

      const confirmation = await db('email_confirmations')
        .where({ email, code, status: 'pending' })
        .andWhere('expires_at', '>', new Date())
        .first();

      if (!confirmation) {
        return res.status(400).json({ error: 'Código inválido ou expirado.' });
      }

      await db('email_confirmations')
        .where({ id: confirmation.id })
        .update({ status: 'received' });

      let customer;

      if (isReturning) {
        customer = await db('customers').where({ email }).first();
        if (!customer) {
          return res.status(404).json({ error: 'Conta não encontrada.' });
        }
      } else {
        customer = await db('customers').where({ email }).orWhere({ cpf: cleanCPF }).first();

        if (!customer) {
          const [newCustomer] = await db('customers').insert({
            name,
            email,
            cpf: cleanCPF,
            whatsapp
          }).returning('*');
          customer = newCustomer;
        }
      }

      return res.status(200).json({ 
        message: 'Código verificado com sucesso.',
        customerId: customer.id 
      });
    } catch (error: any) {
      console.error(error);
      if (error.code === '23505') {
        return res.status(400).json({ error: 'E-mail ou CPF já cadastrados por outro usuário.' });
      }
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
};
