import { Response } from 'express';
import db from '../database/connection';
import { AuthRequest } from '../middlewares/auth';
import { CelcoinService } from '../services/CelcoinService';
import { CardService } from '../services/CardService';

const PLAN_RANK: Record<string, number> = {
  plano_barba: 1,
  plano_black: 2,
  plano_premium: 3,
};

function getTodayDateStr(): string {
  const date = new Date();
  const options: Intl.DateTimeFormatOptions = { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' };
  const parts = new Intl.DateTimeFormat('pt-BR', options).formatToParts(date);
  const day = parts.find(p => p.type === 'day')?.value;
  const month = parts.find(p => p.type === 'month')?.value;
  const year = parts.find(p => p.type === 'year')?.value;
  return `${year}-${month}-${day}`;
}

function addMonthToDateStr(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  date.setMonth(date.getMonth() + 1);
  const nextY = date.getFullYear();
  const nextM = String(date.getMonth() + 1).padStart(2, '0');
  const nextD = String(date.getDate()).padStart(2, '0');
  return `${nextY}-${nextM}-${nextD}`;
}

async function getNextBillingDate(celcoinSubscriptionId: string): Promise<string> {
  const info = await CelcoinService.getSubscriptionPaymentInfo(celcoinSubscriptionId);
  const transactions = info.transactions;

  const pending = transactions.filter((t: any) => t.isPending && t.paydayDate);
  if (pending.length > 0) {
    pending.sort((a: any, b: any) => a.paydayDate!.localeCompare(b.paydayDate!));
    return pending[0].paydayDate!.substring(0, 10);
  }

  const paid = transactions.filter((t: any) => t.isPaid && t.paydayDate);
  if (paid.length > 0) {
    paid.sort((a: any, b: any) => b.paydayDate!.localeCompare(a.paydayDate!));
    return addMonthToDateStr(paid[0].paydayDate!.substring(0, 10));
  }

  return addMonthToDateStr(getTodayDateStr());
}

export const SubscriptionController = {
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

      const orderIds = subscriptions.map(s => s.order_id);
      const upsellRows = orderIds.length
        ? await db('order_upsells')
          .join('upsells', 'order_upsells.upsell_id', '=', 'upsells.id')
          .whereIn('order_upsells.order_id', orderIds)
          .select('order_upsells.order_id', 'upsells.key', 'upsells.label', 'upsells.price_cents')
        : [];

      const upsellsByOrder: Record<string, { key: string; label: string; price_cents: number }[]> = {};
      for (const row of upsellRows) {
        if (!upsellsByOrder[row.order_id]) upsellsByOrder[row.order_id] = [];
        upsellsByOrder[row.order_id].push({ key: row.key, label: row.label, price_cents: row.price_cents });
      }

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
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

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

      const eyebrowUpsell = await db('upsells').where({ key: 'additional_eyebrow', active: true }).first();

      const currentPlanDB = await db('plans').where({ name: currentSub.plan }).first();
      let currentPlanPrice = currentPlanDB.price_cents;
      const currentSubHasEyeBrowUpsell =
        await db('order_upsells')
          .join('upsells', 'order_upsells.upsell_id', '=', 'upsells.id')
          .where({ upsell_id: eyebrowUpsell?.id })
          .first();
      const currentTotalMonthlyPriceSubscription = currentPlanPrice + (currentSubHasEyeBrowUpsell?.price_cents ?? 0);

      const planDB = await db('plans').where({ name: newPlan }).first();

      if (!planDB) {
        return res.status(400).json({ error: 'Plano inválido.' });
      }

      const newPlanPrice = planDB.price_cents;
      const newTotalMonthlyPrice = newPlanPrice + (newAdditionalEyebrow ? (eyebrowUpsell?.price_cents ?? 0) : 0);

      const isDowngrade = newTotalMonthlyPrice < currentTotalMonthlyPriceSubscription;

      if (isDowngrade && currentSub.loyalty_until && new Date(currentSub.loyalty_until) > new Date()) {
        return res.status(403).json({
          error: 'Não é possível realizar downgrade do plano durante o período de fidelidade. Você apenas pode realizar upgrade para planos superiores.'
        });
      }

      if (currentSub.payment_status === 'error') {
        return res.status(403).json({ error: 'Não é possível alterar o plano com uma fatura em atraso ou erro. Por favor, regularize o pagamento primeiro.' });
      }

      if (currentSub.celcoin_subscription_id) {
        const payInfo = await CelcoinService.getSubscriptionPaymentInfo(currentSub.celcoin_subscription_id);
        const todayStr = getTodayDateStr();
        const hasOverdue = payInfo.transactions.some((t: any) => t.isPending && t.paydayDate && t.paydayDate < todayStr);
        if (hasOverdue) {
          return res.status(403).json({ error: 'Não é possível alterar o plano com uma fatura em atraso. Por favor, regularize o pagamento primeiro.' });
        }
      }

      let amountToChargeNow: number;
      let firstPayDayDate: string | undefined;
      let effectiveFrom: string;

      if (isDowngrade) {
        firstPayDayDate = await getNextBillingDate(currentSub.celcoin_subscription_id!);
        amountToChargeNow = newTotalMonthlyPrice;
        effectiveFrom = firstPayDayDate;
      }

      if (!isDowngrade) {
        const nextBillingStr = await getNextBillingDate(currentSub.celcoin_subscription_id!);
        const [nextY, nextM, nextD] = nextBillingStr.split('-');
        const nextBilling = new Date(Number(nextY), Number(nextM) - 1, Number(nextD));

        const todayDate = new Date();
        const todayOnly = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate());

        const diffTime = nextBilling.getTime() - todayOnly.getTime();
        let remainingDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        const daysInCurrentMonth = new Date(todayDate.getFullYear(), todayDate.getMonth() + 1, 0).getDate();
        if (daysInCurrentMonth === 31) {
          remainingDays -= 1;
        } else if (daysInCurrentMonth < 30) {
          remainingDays += (30 - daysInCurrentMonth);
        }

        if (remainingDays <= 0) remainingDays = 1;

        const difference = newTotalMonthlyPrice - currentTotalMonthlyPriceSubscription;
        amountToChargeNow = Math.round(difference * (remainingDays / 30));

        const todayDay = todayDate.getDate();
        const nextMonthDate = new Date(todayDate.getFullYear(), todayDate.getMonth() + 1, 1);
        const lastDayNextMonth = new Date(nextMonthDate.getFullYear(), nextMonthDate.getMonth() + 1, 0).getDate();
        nextMonthDate.setDate(Math.min(todayDay, lastDayNextMonth));
        firstPayDayDate = nextMonthDate.toISOString().slice(0, 10);
        effectiveFrom = getTodayDateStr();
      }

      const celcoinPlanId = currentSub.payment_type === 'credit_card'
        ? planDB.celcoin_plan_id_credit_card
        : planDB.celcoin_plan_id_pix;

      const result = await db.transaction(async (trx) => {
        const [newOrder] = await trx('orders').insert({
          customer_id: customer.id,
          plan: newPlan,
          payment_type: currentSub.payment_type,
          payment_status: 'pending',
          order_status: 'payment_pending',
          price_cents: isDowngrade ? newTotalMonthlyPrice : amountToChargeNow,
          effective_from: effectiveFrom,
          effective_until: null,
        }).returning('*');

        if (eyebrowUpsell && newAdditionalEyebrow) {
          await trx('order_upsells').insert({ order_id: newOrder.id, upsell_id: eyebrowUpsell.id });
        }

        const savedCard = await CardService.getCard(customer.id);
        let subData;

        if (currentSub.payment_type === 'credit_card' && savedCard) {
          subData = await CelcoinService.subscribeCreditCard(
            customer.id,
            newTotalMonthlyPrice,
            newOrder.id,
            savedCard,
            celcoinPlanId,
            firstPayDayDate
          );
        } else {
          subData = await CelcoinService.subscribeWithoutCard(
            customer,
            newTotalMonthlyPrice,
            newOrder.id,
            currentSub.payment_type,
            celcoinPlanId,
            firstPayDayDate
          );
        }

        if (!isDowngrade && amountToChargeNow > 0) {
          const chargeResult = await CelcoinService.createProratedCharge(
            customer,
            amountToChargeNow,
            newOrder.id,
            currentSub.payment_type,
            currentSub.payment_type === 'credit_card' ? savedCard ?? undefined : undefined
          );
          await trx('orders')
            .where({ id: newOrder.id })
            .update({ celcoin_prorated_charge_id: chargeResult.chargeId });
        }

        const isAutoPaid = (subData as any).status === 'active' || (!isDowngrade && amountToChargeNow === 0);

        if (currentSub.celcoin_subscription_id) {
          try {
            await CelcoinService.cancelSubscription(currentSub.celcoin_subscription_id);
          } catch (err: any) { }
        }

        await trx('subscriptions').where({ id: currentSub.id }).update({
          status: 'cancelled',
          cancelled_at: new Date(),
          updated_at: new Date()
        });

        await trx('orders').where({ id: currentSub.order_id }).update({
          order_status: 'cancelled',
          effective_until: isDowngrade ? firstPayDayDate : new Date().toISOString().split('T')[0],
          status_updated_at: new Date(),
          updated_at: new Date()
        });

        if (subData.subscriptionId) {
          await trx('orders').where({ id: newOrder.id }).update({
            celcoin_charge_id: subData.subscriptionId,
            updated_at: new Date()
          });
        }

        const [newSub] = await trx('subscriptions').insert({
          order_id: newOrder.id,
          customer_id: customer.id,
          status: 'active',
          loyalty_months: currentSub.loyalty_months,
          loyalty_until: currentSub.loyalty_until,
          payment_status: isAutoPaid ? 'paid' : 'pending',
          celcoin_subscription_id: subData.subscriptionId,
          payment_link: (subData as any).paymentLink ?? null,
        }).returning('*');

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

    } catch (error: any) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  async getPaymentInfo(req: AuthRequest, res: Response) {
    try {
      const customerId = req.userId;
      const subscriptionId = req.params.id;

      const customer = await db('customers').where({ user_id: customerId }).first();
      if (!customer) return res.status(404).json({ error: 'Customer not found.' });

      const subscription = await db('subscriptions')
        .join('orders', 'subscriptions.order_id', '=', 'orders.id')
        .where({ 'subscriptions.id': subscriptionId, 'subscriptions.customer_id': customer.id })
        .select('subscriptions.*', 'orders.payment_type', 'orders.celcoin_prorated_charge_id')
        .first();

      if (!subscription) {
        return res.status(404).json({ error: 'Subscription not found.' });
      }

      if (!subscription.celcoin_subscription_id) {
        return res.json({
          paymentMethod: subscription.payment_type === 'credit_card' ? 'creditcard' : subscription.payment_type,
          status: 'pending',
          paymentLink: null,
          pix: null,
          boleto: null
        });
      }

      const paymentInfo = await CelcoinService.getSubscriptionPaymentInfo(subscription.celcoin_subscription_id);

      if (subscription.celcoin_prorated_charge_id) {
        try {
          const charge = await CelcoinService.getCharge(subscription.celcoin_prorated_charge_id);
          if (charge) {
            const pendingStatuses = new Set(['pending', 'pendingBoleto', 'pendingPix', 'pendingCreditCard', 'waitingPayment', 'notSend', 'denied', 'waitingBoleto', 'waitingPix', 'active']);
            const paidStatuses = new Set(['paid', 'payedBoleto', 'payedPix', 'payedCreditCard', 'confirmed']);

            const firstTrx = charge.Transactions?.[0] ?? charge.transactions?.[0] ?? null;
            const boletoSrc = charge.Boleto ?? firstTrx?.Boleto ?? null;
            const pixSrc = charge.Pix ?? firstTrx?.Pix ?? null;
            const payday = charge.payday ?? charge.paydayDate ?? firstTrx?.payday ?? firstTrx?.paydayDate ?? null;

            const chargeTransaction = {
              transactionId: charge.galaxPayId?.toString() ?? subscription.celcoin_prorated_charge_id,
              status: charge.status,
              isPending: pendingStatuses.has(charge.status),
              isPaid: paidStatuses.has(charge.status),
              value: charge.value,
              paydayDate: payday,
              payday,
              isProrated: true,
              boleto: boletoSrc ? {
                pdf: boletoSrc.pdf,
                bankLine: boletoSrc.bankLine,
                paymentPage: boletoSrc.page ?? boletoSrc.paymentPage ?? null,
              } : null,
              pix: pixSrc ? {
                qrCode: pixSrc.qrCode ?? null,
                paymentLink: pixSrc.paymentLink ?? null,
              } : null,
            };
            paymentInfo.transactions = [chargeTransaction, ...paymentInfo.transactions];
          }
        } catch (err: any) { }
      }

      return res.json(paymentInfo);
    } catch (error: any) {
      return res.status(500).json({ error: error?.response?.data?.error?.message || 'Internal server error' });
    }
  }
};
