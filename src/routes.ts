import { Router } from 'express';
import { AuthController } from './controllers/AuthController';
import { LeadController } from './controllers/LeadController';
import { OrderController } from './controllers/OrderController';
import { requireAuth, requireMasterKey, requireCelcoinWebhookHash } from './middlewares/auth';
import { requireCheckoutToken } from './middlewares/checkoutAuth';
import { PaymentController } from './controllers/PaymentController';

const routes = Router();

// ─── PUBLIC: Checkout flow (no auth) ─────────────────────────────────────────
routes.post('/api/leads/email-confirmation', LeadController.emailConfirmation);
routes.post('/api/leads/verify-code', LeadController.verifyCode);

// Order creation requires the signed checkout token (prevents customerId spoofing)
routes.post('/api/orders', requireCheckoutToken, OrderController.createOrder);

routes.post('/api/payments/pix', PaymentController.payWithPix);
routes.post('/api/payments/credit-card', PaymentController.payWithCreditCard);


// ─── PROTECTED: Celcoin webhook ────────────
routes.post('/webhook/celcoin', requireCelcoinWebhookHash, PaymentController.webhook);

// ─── PUBLIC: Auth ─────────────────────────────────────────────────────────────
routes.post('/api/auth/login', AuthController.login);
routes.post('/api/auth/refresh', AuthController.refresh);
routes.post('/api/auth/register', requireMasterKey, AuthController.register);

// ─── PUBLIC: Customer Auth ──────────────────────────────────────────────────
import { CustomerAuthController } from './controllers/CustomerAuthController';
routes.post('/api/customer/auth/send-code', CustomerAuthController.sendCode);
routes.post('/api/customer/auth/verify-code', CustomerAuthController.verifyCode);

// ─── CUSTOMER: Protected routes (requires customer JWT) ─────────────────────
import { requireCustomer } from './middlewares/auth';
import { SubscriptionController } from './controllers/SubscriptionController';
routes.get('/api/customer/subscriptions', requireCustomer, SubscriptionController.list);
routes.get('/api/customer/subscriptions/:id/payment', requireCustomer, SubscriptionController.getPaymentInfo);
routes.post('/api/customer/subscriptions/:id/change-plan', requireCustomer, SubscriptionController.changePlan);

// ─── ADMIN: Protected routes (requires admin JWT) ───────────────────────────
routes.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ id: (req as any).userId });
});
routes.post('/api/auth/logout', requireAuth, AuthController.logout);
routes.get('/api/orders', requireAuth, OrderController.index);
routes.patch('/api/orders/:id/erp-status', requireAuth, OrderController.updateERPStatus);

export default routes;
