import { Router } from 'express';
import { AuthController } from './controllers/AuthController';
import { CustomerController } from './controllers/CustomerController';
import { requireAuth, requireMasterKey } from './middlewares/auth';

const routes = Router();

routes.post('/api/leads', CustomerController.createLead);
routes.post('/api/auth/login', AuthController.login);
routes.post('/api/auth/refresh', AuthController.refresh);

routes.post('/api/auth/register', requireMasterKey, AuthController.register);

routes.use('/api', requireAuth);

routes.get('/api/auth/me', (req, res) => {
  res.json({ id: (req as any).userId });
});
routes.post('/api/auth/logout', AuthController.logout);

routes.get('/api/customers', CustomerController.index);
routes.patch('/api/customers/:id/erp-status', CustomerController.updateERPStatus);

export default routes;
