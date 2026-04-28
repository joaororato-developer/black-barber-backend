import { Request, Response, NextFunction } from 'express';
import { TokenService } from '../services/TokenService';

export interface AuthRequest extends Request {
  userId?: string;
  userRole?: 'admin' | 'customer';
}

export const requireAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Token not provided' });

  const [, token] = authHeader.split(' ');
  try {
    const decoded = TokenService.verifyAccess(token);
    req.userId = decoded.id;
    req.userRole = decoded.role;
    return next();
  } catch {
    return res.status(401).json({ error: 'Token invalid or expired' });
  }
};

export const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Token not provided' });

  const [, token] = authHeader.split(' ');
  try {
    const decoded = TokenService.verifyAccess(token);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    req.userId = decoded.id;
    req.userRole = decoded.role;
    return next();
  } catch {
    return res.status(401).json({ error: 'Token invalid or expired' });
  }
};

export const requireCustomer = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Token not provided' });

  const [, token] = authHeader.split(' ');
  try {
    const decoded = TokenService.verifyAccess(token);
    if (decoded.role !== 'customer') return res.status(403).json({ error: 'Customer access required' });
    req.userId = decoded.id;
    req.userRole = decoded.role;
    return next();
  } catch {
    return res.status(401).json({ error: 'Token invalid or expired' });
  }
};

export const requireMasterKey = (req: Request, res: Response, next: NextFunction) => {
  const secretKey = req.headers['x-master-key'];
  if (!secretKey || secretKey !== process.env.MASTER_CLIENT_SECRET_KEY) {
    return res.status(403).json({ error: 'Forbidden: Invalid Master Key' });
  }
  return next();
};

export const requireCelcoinWebhookHash = (req: Request, res: Response, next: NextFunction) => {
  const incomingHash = req.headers['webhook-hash'] || req.headers['x-webhook-hash'];
  const expectedHash = process.env.CELCOIN_WEBHOOK_HASH;

  if (!expectedHash) {
    return res.status(500).json({ error: 'Webhook Hash not configured on server' });
  }

  if (!incomingHash || incomingHash !== expectedHash) {
    return res.status(403).json({ error: 'Forbidden: Invalid Webhook Hash' });
  }

  return next();
};
