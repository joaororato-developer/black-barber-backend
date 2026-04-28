import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface CheckoutRequest extends Request {
  checkoutCustomerId?: string;
}

/**
 * Validates the short-lived checkout token issued after email verification.
 * Extracts customerId from the token and attaches it to req.checkoutCustomerId.
 *
 * The frontend sends this as: Authorization: Checkout <token>
 */
export const requireCheckoutToken = (
  req: CheckoutRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Checkout ')) {
    return res.status(401).json({ error: 'Checkout token not provided' });
  }

  const token = authHeader.slice('Checkout '.length);

  try {
    const decoded = jwt.verify(
      token,
      process.env.CHECKOUT_TOKEN_SECRET as string
    ) as { customerId: string };

    req.checkoutCustomerId = decoded.customerId;
    return next();
  } catch {
    return res.status(401).json({ error: 'Checkout token inválido ou expirado. Refaça a verificação de e-mail.' });
  }
};
