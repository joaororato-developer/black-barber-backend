import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { TokenService } from '../services/TokenService';
import db from '../database/connection';

export interface CheckoutRequest extends Request {
  checkoutCustomerId?: string;
}

export const requireCheckoutToken = async (
  req: CheckoutRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: 'Token not provided' });
  }

  const parts = authHeader.split(' ');
  const scheme = parts[0];
  const token = parts[1];

  try {
    if (scheme === 'Checkout') {
      const decoded = jwt.verify(
        token,
        process.env.CHECKOUT_TOKEN_SECRET as string
      ) as { customerId: string };

      req.checkoutCustomerId = decoded.customerId;
      return next();
    } else if (scheme === 'Bearer') {
      const decoded = TokenService.verifyAccess(token);
      if (decoded.role !== 'customer') {
        return res.status(403).json({ error: 'Only customers can perform checkout' });
      }

      const customer = await db('customers').where({ user_id: decoded.id }).first();
      if (!customer) {
        return res.status(404).json({ error: 'Customer profile not found' });
      }

      req.checkoutCustomerId = customer.id;
      return next();
    } else {
      return res.status(401).json({ error: 'Unsupported authentication scheme' });
    }
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido ou expirado. Refaça o login ou a verificação de e-mail.' });
  }
};
