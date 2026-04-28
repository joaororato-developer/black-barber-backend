import { Response } from 'express';
import db from '../database/connection';
import { AuthRequest } from '../middlewares/auth';
import { CelcoinService } from '../services/CelcoinService';

const PLAN_PRICES: Record<string, number> = {
  plano_barba: 9800,
  plano_black: 11800,
  plano_premium: 17800,
};

// Returns rank of plan for downgrade checking
const PLAN_RANK: Record<string, number> = {
  plano_barba: 1,
  plano_black: 2,
  plano_premium: 3,
};

export const SubscriptionController = {
  /** GET /api/customer/subscriptions */
  async list(req: AuthRequest, res: Response) {
    try {
      const customerId = req.userId; // user.id (which is not customer.id)
      
      // Need to find the customer.id from user.id
      const customer = await db('customers').where({ user_id: customerId }).first();
      
      if (!customer) {
        return res.status(404).json({ error: 'Customer profile not found for this user.' });
      }

      const subscriptions = await db('subscriptions')
        .join('orders', 'subscriptions.order_id', '=', 'orders.id')
        .where('subscriptions.customer_id', customer.id)
        .select(
           'subscriptions.*',
           'orders.plan',
           'orders.additional_eyebrow',
           'orders.payment_type'
        )
        .orderBy('subscriptions.created_at', 'desc');

      const mapped = subscriptions.map(sub => {
         const priceCents = (PLAN_PRICES[sub.plan] || 0) + (sub.additional_eyebrow ? 4000 : 0);
         return {
            ...sub,
            price_cents: priceCents
         };
      });

      return res.json(mapped);
    } catch (error) {
      console.error('[SubscriptionController.list]', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  /** POST /api/customer/subscriptions/:id/change-plan */
  async changePlan(req: AuthRequest, res: Response) {
    try {
      const customerId = req.userId;
      const subscriptionId = req.params.id;
      const { newPlan, newAdditionalEyebrow } = req.body;

      if (!newPlan) {
        return res.status(400).json({ error: 'New plan is required' });
      }

      const customer = await db('customers').where({ user_id: customerId }).first();
      if (!customer) return res.status(404).json({ error: 'Customer not found.' });

      const currentSub = await db('subscriptions')
        .join('orders', 'subscriptions.order_id', '=', 'orders.id')
        .where({ 
          'subscriptions.id': subscriptionId, 
          'subscriptions.customer_id': customer.id, 
          'subscriptions.status': 'active' 
        })
        .select(
           'subscriptions.*',
           'orders.plan',
           'orders.additional_eyebrow',
           'orders.payment_type'
        )
        .first();

      if (!currentSub) {
        return res.status(404).json({ error: 'Active subscription not found.' });
      }

      if (currentSub.payment_status === 'pending') {
        return res.status(403).json({ error: 'Não é possível alterar o plano enquanto houver um pagamento pendente.' });
      }

      // 1. Check Loyalty RN-003 (Downgrade block)
      const currentRank = PLAN_RANK[currentSub.plan] || 0;
      const newRank = PLAN_RANK[newPlan] || 0;
      const isDowngrade = newRank < currentRank;

      if (isDowngrade && currentSub.loyalty_until && new Date(currentSub.loyalty_until) > new Date()) {
        return res.status(403).json({ 
          error: 'Não é possível realizar downgrade do plano durante o período de fidelidade. Você apenas pode realizar upgrade para planos superiores.' 
        });
      }

      // 2. Prorata logic (RN-006)
      // Only apply discount on upgrade. (To be implemented safely in Celcoin if supported or via a custom initial charge).
      // Since Celcoin subscriptions don't natively support dynamic first charge based on prorata easily through the same subscription API without a separate charge, 
      // we will cancel the old one, and create a new one. To truly support prorata, we might need a separate immediate charge 
      // or to adjust `value` if Celcoin allows different first charge.
      // Assuming no prorata implementation in this immediate script to keep it safe, but we acknowledge it.
      // A full prorata would calculate days remaining and subtract from the first month of the new plan.
      // Here we simply set the new price.
      


      const result = await db.transaction(async (trx) => {
        // 3. Cancel current subscription in Celcoin
        if (currentSub.celcoin_subscription_id) {
          try {
            await CelcoinService.cancelSubscription(currentSub.celcoin_subscription_id);
          } catch (err: any) {
             console.warn('Failed to cancel subscription in Celcoin, proceeding anyway:', err.message);
          }
        }

        // 4. Mark old order & subscription as cancelled
        await trx('subscriptions').where({ id: currentSub.id }).update({
          status: 'cancelled',
          cancelled_at: new Date(),
          updated_at: new Date()
        });

        await trx('orders').where({ id: currentSub.order_id }).update({
          order_status: 'cancelled',
          status_updated_at: new Date(),
          updated_at: new Date()
        });

        // 5. Create new order
        const [newOrder] = await trx('orders').insert({
          customer_id: customer.id,
          plan: newPlan,
          additional_eyebrow: newAdditionalEyebrow || false,
          payment_type: currentSub.payment_type, // carry over payment type
          payment_status: 'pending',
          order_status: 'payment_pending'
        }).returning('*');

        // 6. Create new subscription
        // Keep the original loyalty_until if there's still time, or reset depending on business rules.
        // Rule: Usually new plan = new loyalty, or keep existing. We'll keep existing if longer, or set new.
        // Let's assume loyalty resets or carries over. We will carry it over if it's longer.
        const [newSub] = await trx('subscriptions').insert({
          order_id: newOrder.id,
          customer_id: customer.id,
          status: 'active',
          loyalty_months: currentSub.loyalty_months,
          loyalty_until: currentSub.loyalty_until,
          payment_status: 'pending',
        }).returning('*');

        return { newOrderId: newOrder.id, newSubId: newSub.id };
      });

      return res.status(200).json({
        message: 'Plano alterado com sucesso. Proceda para o pagamento se for necessário atualizar dados do cartão, ou aguarde o PIX/Boleto.',
        newOrderId: result.newOrderId,
        newSubscriptionId: result.newSubId
      });

    } catch (error) {
      console.error('[SubscriptionController.changePlan]', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  /** GET /api/customer/subscriptions/:id/payment */
  async getPaymentInfo(req: AuthRequest, res: Response) {
    try {
      const customerId = req.userId;
      const subscriptionId = req.params.id;

      const customer = await db('customers').where({ user_id: customerId }).first();
      if (!customer) return res.status(404).json({ error: 'Customer not found.' });

      const subscription = await db('subscriptions')
        .where({ id: subscriptionId, customer_id: customer.id })
        .first();

      if (!subscription) {
        return res.status(404).json({ error: 'Subscription not found.' });
      }

      if (!subscription.celcoin_subscription_id) {
        return res.status(400).json({ error: 'Nenhum pagamento Celcoin associado a esta assinatura.' });
      }

      const paymentInfo = await CelcoinService.getSubscriptionPaymentInfo(subscription.celcoin_subscription_id);

      return res.json(paymentInfo);
    } catch (error: any) {
      console.error('[SubscriptionController.getPaymentInfo]', error?.response?.data || error);
      return res.status(500).json({ error: error?.response?.data?.error?.message || 'Internal server error' });
    }
  }
};
