import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

interface AuthRequest extends Request {
  userId?: string;
}

export const requireAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: 'Token not provided' });
  }

  const [, token] = authHeader.split(' ');

  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET as string) as { id: string };
    req.userId = decoded.id;
    return next();
  } catch (err) {
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
