import { Response } from 'express';
import db from '../database/connection';
import { AuthRequest } from '../middlewares/auth';
import { CelcoinService } from '../services/CelcoinService';
import { CardService } from '../services/CardService';

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
      const customerId = req.userId;

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
          'orders.payment_type'
        )
        .orderBy('subscriptions.created_at', 'desc');

      // Batch-load upsells for all fetched orders
      const orderIds = subscriptions.map(s => s.order_id);
      const upsellRows = orderIds.length
        ? await db('order_upsells')
          .join('upsells', 'order_upsells.upsell_id', '=', 'upsells.id')
          .whereIn('order_upsells.order_id', orderIds)
          .select('order_upsells.order_id', 'upsells.key', 'upsells.label', 'upsells.price_cents')
        : [];

      // Group by order_id
      const upsellsByOrder: Record<string, { key: string; label: string; price_cents: number }[]> = {};
      for (const row of upsellRows) {
        if (!upsellsByOrder[row.order_id]) upsellsByOrder[row.order_id] = [];
        upsellsByOrder[row.order_id].push({ key: row.key, label: row.label, price_cents: row.price_cents });
      }

      // Get plan prices
      const allPlans = await db('plans').select('name', 'price_cents');
      const planPrices: Record<string, number> = {};
      allPlans.forEach(p => planPrices[p.name] = p.price_cents);

      const mapped = subscriptions.map(sub => {
        const orderUpsells = upsellsByOrder[sub.order_id] ?? [];
        const upsellsTotal = orderUpsells.reduce((sum, u) => sum + u.price_cents, 0);
        return {
          ...sub,
          upsells: orderUpsells,
          price_cents: (planPrices[sub.plan] || 0) + upsellsTotal,
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

      // 2. Check the new plan in the database and calculate new price
      const planDB = await db('plans').where({ name: newPlan }).first();
      if (!planDB) {
        return res.status(400).json({ error: 'Plano inválido.' });
      }

      // Get current plan price for pro-rata calculation
      const currentPlanDB = await db('plans').where({ name: currentSub.plan }).first();
      if (currentSub.payment_type === 'pix') {
        return res.status(400).json({ error: 'Assinaturas via PIX não podem mais ser alteradas. Por favor, entre em contato com o suporte para migrar para Cartão de Crédito ou Boleto.' });
      }

      const currentPrice = currentPlanDB.price_cents;

      // Resolve upsell for the new order
      let eyebrowUpsell: { id: number; price_cents: number } | undefined;
      if (newAdditionalEyebrow) {
        eyebrowUpsell = await db('upsells').where({ key: 'additional_eyebrow', active: true }).first();
      }

      const newBasePrice = planDB.price_cents;
      const newTotalMonthlyPrice = newBasePrice + (eyebrowUpsell?.price_cents ?? 0);

      // Pro-rata logic: if upgrade, charge only the difference proportional to remaining days
      let amountToChargeNow = newTotalMonthlyPrice;
      if (newTotalMonthlyPrice > currentPrice) {
        const today = new Date();
        const dayOfMonth = today.getDate();
        const daysInMonth = 30; // Standard cycle simplification
        const remainingDays = Math.max(1, daysInMonth - dayOfMonth);

        const difference = newTotalMonthlyPrice - currentPrice;
        amountToChargeNow = Math.round(difference * (remainingDays / daysInMonth));

        // Ensure minimum value (e.g. 1 BRL) to avoid Celcoin errors on very small amounts
        if (amountToChargeNow < 100) amountToChargeNow = 100;

        console.log(`[SubscriptionController.changePlan] Pro-rata upgrade: ${currentPrice} -> ${newTotalMonthlyPrice}. Days remaining: ${remainingDays}. Charging: ${amountToChargeNow}`);
      }

      // Determine correct Celcoin Plan ID based on payment type
      const celcoinPlanId = currentSub.payment_type === 'credit_card'
        ? planDB.celcoin_plan_id_credit_card
        : planDB.celcoin_plan_id_pix;

      const result = await db.transaction(async (trx) => {
        // 3. Create new order
        const [newOrder] = await trx('orders').insert({
          customer_id: customer.id,
          plan: newPlan,
          payment_type: currentSub.payment_type,
          payment_status: 'pending',
          order_status: 'payment_pending',
          price_cents: amountToChargeNow // Store the actual amount being charged now
        }).returning('*');

        // Insert upsell if selected
        if (eyebrowUpsell) {
          await trx('order_upsells').insert({ order_id: newOrder.id, upsell_id: eyebrowUpsell.id });
        }

        // 4. Create new subscription in Celcoin
        const savedCard = await CardService.getCard(customer.id);
        let subData;

        if (currentSub.payment_type === 'credit_card' && savedCard) {
          console.log(`[SubscriptionController.changePlan] Attempting automatic upgrade with saved card for customer ${customer.id}`);
          subData = await CelcoinService.subscribeCreditCard(
            customer.id,
            newTotalMonthlyPrice,
            newOrder.id,
            savedCard,
            celcoinPlanId,
            amountToChargeNow // Pro-rata for the first month
          );
        } else {
          subData = await CelcoinService.subscribeWithoutCard(
            customer.id,
            amountToChargeNow,
            newTotalMonthlyPrice,
            newOrder.id,
            currentSub.payment_type,
            celcoinPlanId
          );
        }

        const isAutoPaid = subData.status === 'active';

        // 5. Cancel current subscription in Celcoin
        if (currentSub.celcoin_subscription_id) {
          try {
            await CelcoinService.cancelSubscription(currentSub.celcoin_subscription_id);
          } catch (err: any) {
            console.warn('Failed to cancel subscription in Celcoin, proceeding anyway:', err.message);
          }
        }

        // 6. Mark old order & subscription as cancelled in DB
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

        // 7. Update new order with celcoin ID
        if (subData.subscriptionId) {
          await trx('orders').where({ id: newOrder.id }).update({
            celcoin_charge_id: subData.subscriptionId,
            updated_at: new Date()
          });
        }

        // 8. Create new subscription
        const [newSub] = await trx('subscriptions').insert({
          order_id: newOrder.id,
          customer_id: customer.id,
          status: 'active',
          loyalty_months: currentSub.loyalty_months,
          loyalty_until: currentSub.loyalty_until,
          payment_status: isAutoPaid ? 'paid' : 'pending',
          celcoin_subscription_id: subData.subscriptionId,
          payment_link: subData.paymentLink,
        }).returning('*');

        // Update order status if autopaid
        if (isAutoPaid) {
          await trx('orders').where({ id: newOrder.id }).update({
            payment_status: 'paid',
            order_status: 'registered'
          });
        }

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

  /** POST /api/customer/subscriptions/:id/change-payment-method */
  async changePaymentMethod(req: AuthRequest, res: Response) {
    try {
      const userId = req.userId;
      const subscriptionId = req.params.id;
      const { newPaymentMethod, address } = req.body; // 'credit_card', 'pix', 'boleto', 'address'

      if (!['credit_card', 'pix', 'boleto'].includes(newPaymentMethod)) {
        return res.status(400).json({ error: 'Método de pagamento inválido.' });
      }

      let customer = await db('customers').where({ user_id: userId }).first();
      if (!customer) return res.status(404).json({ error: 'Cliente não encontrado.' });

      // Se enviou endereço agora, atualiza no banco
      if (address) {
        await db('customers').where({ id: customer.id }).update({
          address: typeof address === 'string' ? address : JSON.stringify(address),
          updated_at: new Date()
        });
        // Recarregar customer com o novo endereço
        customer = await db('customers').where({ id: customer.id }).first();
      }

      const subscription = await db('subscriptions')
        .where({ id: subscriptionId, customer_id: customer.id })
        .first();

      if (!subscription) return res.status(404).json({ error: 'Assinatura não encontrada.' });

      const order = await db('orders').where({ id: subscription.order_id }).first();
      if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });

      // Só permite alterar se o pagamento não estiver confirmado
      if (subscription.payment_status === 'paid' || subscription.payment_status === 'confirmed') {
        return res.status(400).json({ error: 'Este pagamento já foi confirmado e não pode ser alterado.' });
      }

      console.log(`[SubscriptionController.changePaymentMethod] Alterando pagamento da sub ${subscriptionId} para ${newPaymentMethod}`);

      // 1. Cancelar assinatura atual na Celcoin
      if (subscription.celcoin_subscription_id) {
        try {
          await CelcoinService.cancelSubscription(subscription.celcoin_subscription_id);
        } catch (err: any) {
          console.warn('[SubscriptionController.changePaymentMethod] Falha ao cancelar assinatura antiga na Celcoin:', err.message);
        }
      }

      // 2. Buscar o plano para obter os IDs do Celcoin
      const planDB = await db('plans').where({ name: order.plan }).first();
      if (!planDB) return res.status(404).json({ error: 'Plano não encontrado no banco de dados.' });

      const celcoinPlanId = newPaymentMethod === 'credit_card'
        ? planDB.celcoin_plan_id_credit_card
        : planDB.celcoin_plan_id_pix;

      // --- O SEGREDO ESTÁ AQUI ---
      // Criamos um identificador único anexando o timestamp. 
      // Isso engana a Celcoin e permite recriar a assinatura ligada ao mesmo pedido interno.
      const uniqueOrderId = `${order.id}_${Date.now()}`;

      // Validação de endereço para Boleto/Pix (obrigatório na Celcoin)
      if (newPaymentMethod !== 'credit_card' && !customer.address) {
        return res.status(400).json({ error: 'ADDRESS_REQUIRED', message: 'Endereço é obrigatório para pagamento via Boleto ou PIX.' });
      }

      // 3. Criar nova assinatura na Celcoin
      const subData = await CelcoinService.subscribeWithoutCard(
        customer,
        order.price_cents,
        order.price_cents,
        uniqueOrderId, // Enviamos o ID único em vez do order.id puro
        newPaymentMethod,
        celcoinPlanId
      );

      // 4. Atualizar DB
      await db.transaction(async (trx) => {
        await trx('orders').where({ id: order.id }).update({
          payment_type: newPaymentMethod,
          celcoin_charge_id: subData.subscriptionId, // <-- CORREÇÃO: Necessário para o Webhook achar o pedido depois!
          updated_at: new Date()
        });

        await trx('subscriptions').where({ id: subscription.id }).update({
          celcoin_subscription_id: subData.subscriptionId,
          payment_link: subData.paymentLink,
          updated_at: new Date()
        });
      });

      return res.json({
        message: 'Forma de pagamento alterada com sucesso!',
        paymentMethod: newPaymentMethod,
        paymentLink: subData.paymentLink
      });

    } catch (error: any) {
      console.error('[SubscriptionController.changePaymentMethod]', error?.response?.data || error);
      return res.status(500).json({ error: 'Erro ao alterar forma de pagamento.' });
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
        .join('orders', 'subscriptions.order_id', '=', 'orders.id')
        .where({ 'subscriptions.id': subscriptionId, 'subscriptions.customer_id': customer.id })
        .select('subscriptions.*', 'orders.payment_type')
        .first();

      if (!subscription) {
        return res.status(404).json({ error: 'Subscription not found.' });
      }

      if (!subscription.celcoin_subscription_id) {
        // If it's a credit card or other method that allows retrospective payment, return info based on DB
        return res.json({
          paymentMethod: subscription.payment_type === 'credit_card' ? 'creditcard' : subscription.payment_type,
          status: 'pending',
          paymentLink: null,
          pix: null,
          boleto: null
        });
      }

      const paymentInfo = await CelcoinService.getSubscriptionPaymentInfo(subscription.celcoin_subscription_id);

      return res.json(paymentInfo);
    } catch (error: any) {
      console.error('[SubscriptionController.getPaymentInfo]', error?.response?.data || error);
      return res.status(500).json({ error: error?.response?.data?.error?.message || 'Internal server error' });
    }
  }
};
