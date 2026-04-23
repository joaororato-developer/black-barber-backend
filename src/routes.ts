import { Router } from 'express';
import { AuthController } from './controllers/AuthController';
import { LeadController } from './controllers/LeadController';
import { OrderController } from './controllers/OrderController';
import { requireAuth, requireMasterKey } from './middlewares/auth';

const routes = Router();

routes.post('/api/leads/email-confirmation', LeadController.emailConfirmation);
routes.post('/api/leads/verify-code', LeadController.verifyCode);

routes.post('/api/orders', OrderController.createOrder);

routes.post('/api/auth/login', AuthController.login);
routes.post('/api/auth/refresh', AuthController.refresh);

routes.post('/api/auth/register', requireMasterKey, AuthController.register);

routes.use('/api', requireAuth);

routes.get('/api/auth/me', (req, res) => {
  res.json({ id: (req as any).userId });
});
routes.post('/api/auth/logout', AuthController.logout);

routes.get('/api/orders', OrderController.index);
routes.patch('/api/orders/:id/erp-status', OrderController.updateERPStatus);

export default routes;
