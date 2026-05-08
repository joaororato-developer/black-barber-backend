import { Router } from 'express';
import { AuthController } from './controllers/AuthController';
import { LeadController } from './controllers/LeadController';
import { OrderController } from './controllers/OrderController';
import { PaymentController } from './controllers/PaymentController';
import { CustomerAuthController } from './controllers/CustomerAuthController';
import { SubscriptionController } from './controllers/SubscriptionController';
import { CustomerController } from './controllers/CustomerController';
import { requireAuth, requireAdmin, requireCustomer, requireMasterKey, requireCelcoinWebhookHash } from './middlewares/auth';
import { requireCheckoutToken } from './middlewares/checkoutAuth';

const routes = Router();

routes.post('/api/leads/email-confirmation', LeadController.emailConfirmation);
routes.post('/api/leads/verify-code', LeadController.verifyCode);

routes.post('/api/orders', requireCheckoutToken, OrderController.createOrder);
routes.get('/api/orders/:id/payment-info', requireCheckoutToken, OrderController.getOrderPaymentInfo);

routes.post('/webhook/celcoin', requireCelcoinWebhookHash, PaymentController.webhook);

routes.post('/api/auth/login', AuthController.login);
routes.post('/api/auth/refresh', AuthController.refresh);
routes.post('/api/auth/register', requireMasterKey, AuthController.register);

routes.post('/api/customer/auth/send-code', CustomerAuthController.sendCode);
routes.post('/api/customer/auth/verify-code', CustomerAuthController.verifyCode);

routes.get('/api/customer/me', requireCustomer, CustomerController.getProfile);
routes.post('/api/customer/me/request-email-change', requireCustomer, CustomerController.requestEmailChange);
routes.put('/api/customer/me', requireCustomer, CustomerController.updateProfile);
routes.post('/api/customer/me/request-data-deletion', requireCustomer, CustomerController.requestDataDeletion);

routes.get('/api/customer/subscriptions', requireCustomer, SubscriptionController.list);
routes.get('/api/customer/subscriptions/:id/payment', requireCustomer, SubscriptionController.getPaymentInfo);
routes.post('/api/customer/subscriptions/:id/change-plan', requireCustomer, SubscriptionController.changePlan);

routes.post('/api/payments/pix', requireCustomer, PaymentController.payWithPix);
routes.post('/api/payments/credit-card', requireCustomer, PaymentController.payWithCreditCard);
routes.post('/api/payments/boleto', requireCustomer, PaymentController.payWithBoleto);

routes.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ id: (req as any).userId });
});
routes.post('/api/auth/logout', requireAuth, AuthController.logout);
routes.get('/api/orders', requireAdmin, OrderController.index);
routes.get('/api/orders/:id/invoices', requireAdmin, OrderController.getAdminInvoices);
routes.patch('/api/orders/:id/erp-status', requireAdmin, OrderController.updateERPStatus);

export default routes;
