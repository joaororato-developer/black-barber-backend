import { Request, Response } from 'express';
import db from '../database/connection';
import { CheckoutRequest } from '../middlewares/checkoutAuth';
import { CelcoinService } from '../services/CelcoinService';
import { MailService } from '../services/MailService';

function extractIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    ?? (req.socket as any)?.remoteAddress
    ?? req.ip
    ?? 'unknown';
}

export const OrderController = {
  async createOrder(req: CheckoutRequest, res: Response) {
    try {
      const customerId = req.checkoutCustomerId;
      const { plan, additionalEyebrow, paymentType, consentText, consentVersion } = req.body;

      if (!customerId || !plan || !paymentType) {
        return res.status(400).json({ error: 'Missing required payload fields' });
      }

      if (!consentText || !consentVersion) {
        return res.status(400).json({ error: 'Consentimento obrigatório.' });
      }

      const activeSubscription = await db('subscriptions')
        .where({ customer_id: customerId })
        .andWhere('status', '!=', 'canceled')
        .first();

      if (activeSubscription) {
        return res.status(403).json({
          error: 'Você já possui uma assinatura vinculada a esta conta. Para alterar seu plano ou forma de pagamento, acesse o painel "Minha Conta".'
        });
      }

      const ip = extractIp(req);
      const userAgent = req.headers['user-agent'] ?? null;

      const existingOrder = await db('orders')
        .where({
          customer_id: customerId,
          payment_status: 'pending',
          order_status: 'payment_pending'
        })
        .first();

      if (existingOrder) {
        await db('orders')
          .where({ id: existingOrder.id })
          .update({ plan, payment_type: paymentType, updated_at: new Date() });

        await db('order_upsells').where({ order_id: existingOrder.id }).delete();

        if (additionalEyebrow) {
          const upsell = await db('upsells').where({ key: 'additional_eyebrow', active: true }).first();
          if (upsell) {
            await db('order_upsells').insert({ order_id: existingOrder.id, upsell_id: upsell.id });
          }
        }

        await db('consent_logs').insert({
          customer_id: customerId,
          order_id: existingOrder.id,
          consent_version: consentVersion,
          consent_text: consentText,
          ip_address: ip,
          user_agent: userAgent,
        });

        return res.status(200).json({
          message: 'Existing pending order updated and returned',
          orderId: existingOrder.id
        });
      }

      const orderId = await db.transaction(async (trx) => {
        const [order] = await trx('orders').insert({
          customer_id: customerId,
          plan,
          payment_type: paymentType,
          payment_status: 'pending',
          order_status: 'payment_pending'
        }).returning('*');

        if (additionalEyebrow) {
          const upsell = await trx('upsells').where({ key: 'additional_eyebrow', active: true }).first();
          if (upsell) {
            await trx('order_upsells').insert({ order_id: order.id, upsell_id: upsell.id });
          }
        }

        const loyaltyMonths = paymentType === 'credit_card' ? 0 : 3;
        let loyaltyUntil = null;
        if (loyaltyMonths > 0) {
          const d = new Date();
          d.setMonth(d.getMonth() + loyaltyMonths);
          loyaltyUntil = d;
        }

        await trx('subscriptions').insert({
          order_id: order.id,
          customer_id: customerId,
          status: 'active',
          loyalty_months: loyaltyMonths,
          loyalty_until: loyaltyUntil,
          payment_status: 'pending',
        });

        await trx('consent_logs').insert({
          customer_id: customerId,
          order_id: order.id,
          consent_version: consentVersion,
          consent_text: consentText,
          ip_address: ip,
          user_agent: userAgent,
        });

        return order.id;
      });

      return res.status(201).json({ message: 'Order created successfully', orderId });
    } catch (error) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  async getAdminInvoices(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const order = await db('orders').where({ id }).first();
      if (!order) return res.status(404).json({ error: 'Order not found' });

      const pendingStatuses = new Set([
        'pending', 'pendingBoleto', 'pendingPix', 'pendingCreditCard',
        'waitingPayment', 'notSend', 'denied', 'waitingBoleto', 'waitingPix',
      ]);
      const paidStatuses = new Set([
        'paid', 'payedBoleto', 'payedPix', 'payedCreditCard', 'confirmed',
      ]);

      const nowParts = new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(new Date());
      const todayStr = `${nowParts.find(p => p.type === 'year')!.value}-${nowParts.find(p => p.type === 'month')!.value}-${nowParts.find(p => p.type === 'day')!.value}`;

      let paymentMethod: string | null = null;
      const allTransactions: any[] = [];

      if (order.celcoin_charge_id) {
        try {
          const info = await CelcoinService.getSubscriptionPaymentInfo(order.celcoin_charge_id);
          paymentMethod = info.paymentMethod;
          for (const t of info.transactions) {
            allTransactions.push({ ...t, isProrated: false });
          }
        } catch { /* ignore */ }
      }

      if (order.celcoin_prorated_charge_id) {
        try {
          const charge = await CelcoinService.getCharge(order.celcoin_prorated_charge_id);
          if (charge) {
            allTransactions.push({
              transactionId: charge.galaxPayId?.toString() ?? null,
              status: charge.status,
              isPending: pendingStatuses.has(charge.status),
              isPaid: paidStatuses.has(charge.status),
              isProrated: true,
              value: charge.value,
              paydayDate: charge.paydayDate ?? null,
              payday: charge.payday ?? null,
              boleto: charge.Boleto ? {
                pdf: charge.Boleto.pdf ?? null,
                bankLine: charge.Boleto.bankLine ?? null,
                paymentPage: charge.Boleto.page ?? null,
              } : null,
              pix: charge.Pix ? {
                qrCode: charge.Pix.qrCode ?? null,
                paymentLink: charge.Pix.paymentLink ?? null,
              } : null,
            });
          }
        } catch { /* ignore */ }
      }

      const isOverdue = allTransactions.some(t => {
        if (!t.isPending) return false;
        const date = t.paydayDate || t.payday;
        return date && date < todayStr;
      });

      return res.json({ paymentMethod, isOverdue, transactions: allTransactions });
    } catch (error) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  async index(req: Request, res: Response) {
    try {
      const { name, date, paymentStatus, erpStatus } = req.query;

      let query = db('orders')
        .join('customers', 'orders.customer_id', '=', 'customers.id')
        .join('plans', 'orders.plan', '=', 'plans.name')
        .select(
          'orders.id as order_id',
          'customers.id as customer_id',
          'customers.name',
          'customers.email',
          'customers.whatsapp as phone',
          'plans.label as plan',
          'orders.payment_type',
          'orders.payment_status',
          'orders.order_status',
          'orders.celcoin_charge_id',
          'orders.created_at',
          'orders.updated_at'
        );

      if (name) query = query.where('customers.name', 'ilike', `%${name}%`);
      if (date) {
        query = query.whereRaw("DATE(orders.created_at AT TIME ZONE 'America/Sao_Paulo') = ?", [date as unknown as Buffer<ArrayBufferLike>]);
      }
      if (paymentStatus && paymentStatus !== 'all') query = query.where('orders.payment_status', paymentStatus);
      if (erpStatus && erpStatus !== 'all') {
        if (erpStatus === 'pending') {
          query = query.whereIn('orders.order_status', ['pending', 'payment_pending']);
        } else {
          query = query.where('orders.order_status', erpStatus);
        }
      }

      const orders = await query.orderBy('orders.created_at', 'desc');

      const orderIds = orders.map(o => o.order_id);
      const upsellRows = orderIds.length
        ? await db('order_upsells')
            .join('upsells', 'order_upsells.upsell_id', '=', 'upsells.id')
            .whereIn('order_upsells.order_id', orderIds)
            .select('order_upsells.order_id', 'upsells.key', 'upsells.label')
        : [];

      const upsellsByOrder: Record<string, { key: string; label: string }[]> = {};
      for (const row of upsellRows) {
        if (!upsellsByOrder[row.order_id]) upsellsByOrder[row.order_id] = [];
        upsellsByOrder[row.order_id].push({ key: row.key, label: row.label });
      }

      const mappedOrders = orders.map(o => ({
        id: o.order_id,
        name: o.name,
        email: o.email,
        phone: o.phone,
        plan: o.plan,
        upsells: upsellsByOrder[o.order_id] ?? [],
        paymentMethod: o.payment_type,
        paymentStatus: o.payment_status,
        erpStatus: o.order_status === 'payment_pending' || o.order_status === 'pending' ? 'pending' : o.order_status,
        celcoinChargeId: o.celcoin_charge_id ?? null,
        createdAt: o.created_at,
        updatedAt: o.updated_at
      }));

      return res.json(mappedOrders);
    } catch (error) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  async updateERPStatus(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { erp_status, password, email } = req.body;

      if (!erp_status || !['pending', 'registered'].includes(erp_status)) {
        return res.status(400).json({ error: 'Invalid ERP status' });
      }

      const order = await db('orders')
        .join('customers', 'orders.customer_id', '=', 'customers.id')
        .select('orders.id', 'customers.name', 'customers.email')
        .where('orders.id', id)
        .first();

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      await db('orders')
        .where({ id })
        .update({ order_status: erp_status, status_updated_at: db.fn.now(), updated_at: db.fn.now() });

      if (erp_status === 'registered') {
        const sendTo = (email as string | undefined) || order.email;
        MailService.sendWelcomeEmail(sendTo, order.name, password ?? null).catch(() => undefined);
      }

      return res.json({ message: 'ERP status updated properly' });
    } catch (error) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  async getOrderPaymentInfo(req: Request, res: Response) {
    try {
      const { id } = req.params;

      const order = await db('orders')
        .join('customers', 'orders.customer_id', '=', 'customers.id')
        .join('plans', 'orders.plan', '=', 'plans.name')
        .select(
          'orders.*',
          'plans.celcoin_plan_id_pix',
          'plans.price_cents as plan_price_cents',
          'customers.name', 'customers.email', 'customers.whatsapp', 'customers.cpf',
          'customers.zip_code', 'customers.street', 'customers.street_number', 'customers.neighborhood', 'customers.city', 'customers.state'
        )
        .where('orders.id', id)
        .first();

      if (!order) return res.status(404).json({ error: 'Order not found' });

      if (!order.celcoin_charge_id) {
        if (order.payment_type === 'pix') {
          return res.status(400).json({ error: 'Pagamento via PIX não é mais suportado para assinaturas.' });
        }

        if (order.payment_type === 'boleto') {
          await CelcoinService.registerCustomer({
            id: order.customer_id,
            name: order.name,
            cpf: order.cpf,
            email: order.email,
            whatsapp: order.whatsapp,
          });

          const orderUpsells = await db('order_upsells')
            .join('upsells', 'order_upsells.upsell_id', '=', 'upsells.id')
            .where('order_upsells.order_id', order.id)
            .select('upsells.price_cents');

          const upsellsTotal = orderUpsells.reduce((sum, u) => sum + u.price_cents, 0);
          const totalCents = (order.price_cents || order.plan_price_cents) + upsellsTotal;

          let celcoinSubId: string | null = null;

          if (!order.zip_code || !order.street || !order.street_number) {
            return res.status(400).json({
              error: 'Endereço completo é obrigatório para pagamento via boleto.',
              requiresAddress: true
            });
          }

          const subData = await CelcoinService.subscribeBoleto(
            order.customer_id,
            totalCents,
            order.id,
            order.celcoin_plan_id_pix
          );
          celcoinSubId = subData.subscriptionId;

          if (celcoinSubId) {
            await db('orders').where({ id: order.id }).update({
              celcoin_charge_id: celcoinSubId,
              updated_at: new Date()
            });
            order.celcoin_charge_id = celcoinSubId;
          }
        } else if (order.payment_type === 'credit_card') {
          return res.json({
            paymentMethod: 'creditcard',
            status: 'pending',
            message: 'Aguardando dados do cartão'
          });
        }
      }

      const paymentInfo = await CelcoinService.getSubscriptionPaymentInfo(order.celcoin_charge_id!);
      return res.json(paymentInfo);
    } catch (error: any) {
      return res.status(500).json({ error: error?.response?.data?.error?.message || 'Internal server error' });
    }
  }
};
