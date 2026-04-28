import jwt from 'jsonwebtoken';

export interface TokenPayload {
  id: string;     // user.id
  role: 'admin' | 'customer';
}

export const TokenService = {
  generateAccessToken(payload: TokenPayload): string {
    return jwt.sign(payload, process.env.JWT_ACCESS_SECRET as string, { expiresIn: '1h' });
  },

  generateRefreshToken(payload: TokenPayload): string {
    return jwt.sign(payload, process.env.JWT_REFRESH_SECRET as string, { expiresIn: '7d' });
  },

  verifyAccess(token: string): TokenPayload {
    return jwt.verify(token, process.env.JWT_ACCESS_SECRET as string) as TokenPayload;
  },

  verifyRefresh(token: string): TokenPayload {
    return jwt.verify(token, process.env.JWT_REFRESH_SECRET as string) as TokenPayload;
  },
};
