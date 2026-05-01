import { Request, Response } from 'express';
import axios from 'axios';
import db from '../database/connection';
import { CelcoinService } from '../services/CelcoinService';

import { AuthRequest } from '../middlewares/auth';

/**
 * Helper: fetches the order+customer+plan data needed for payment.
 */
async function getOrderForPayment(orderId: string) {
  return db('orders')
    .join('customers', 'orders.customer_id', '=', 'customers.id')
    .join('plans', 'orders.plan', '=', 'plans.name')
    .select(
      'orders.id as order_id',
      'orders.celcoin_charge_id',
      'orders.payment_type',
      'orders.payment_status',
      'orders.plan as plan_key',
      'plans.price_cents',
      'plans.label as plan_label',
      'plans.celcoin_plan_id_pix',
      'plans.celcoin_plan_id_credit_card',
      'customers.id as customer_id',
      'customers.user_id',
      'customers.name',
      'customers.cpf',
      'customers.email',
      'customers.whatsapp',
      'customers.zip_code',
      'customers.street',
      'customers.street_number',
      'customers.neighborhood',
      'customers.city',
      'customers.state',
      'customers.complement'
    )
    .where('orders.id', orderId)
    .first();
}

export const PaymentController = {
  /**
   * POST /api/payments/pix
   * Creates a monthly PIX subscription.
   * - First QR Code is generated immediately (for today).
   * - Celcoin automatically generates a new PIX link every month.
   */
  async payWithPix(req: AuthRequest, res: Response) {
    try {
      const { orderId } = req.body;
      if (!orderId) return res.status(400).json({ error: 'orderId is required' });

      const order = await getOrderForPayment(orderId);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (order.user_id !== req.userId) {
        return res.status(403).json({ error: 'Você não tem permissão para pagar este pedido.' });
      }
      if (order.payment_status === 'confirmed' || order.payment_status === 'paid') {
        return res.status(400).json({ error: 'Este pedido já foi pago com sucesso.' });
      }

      if (order.celcoin_charge_id) {
        console.log(`[PaymentController] Retrying payment for order ${orderId}. Cancelling old sub ${order.celcoin_charge_id}`);
        try {
          await CelcoinService.cancelSubscription(order.celcoin_charge_id);
        } catch (e) {
          console.warn(`[PaymentController] Could not cancel old sub ${order.celcoin_charge_id}:`, e);
        }
      }

      // Register/upsert customer in Celcoin (idempotent)
      await CelcoinService.registerCustomer({
        id: order.customer_id,
        name: order.name,
        cpf: order.cpf,
        email: order.email,
        whatsapp: order.whatsapp,
      });

      // Load upsells from order_upsells table
      const orderUpsells = await db('order_upsells')
        .join('upsells', 'order_upsells.upsell_id', '=', 'upsells.id')
        .where('order_upsells.order_id', orderId)
        .where('upsells.active', true)
        .select('upsells.id', 'upsells.price_cents');

      const upsellsTotal = orderUpsells.reduce((sum: number, u: any) => sum + u.price_cents, 0);
      const totalCents = order.price_cents + upsellsTotal;

      // Create recurring monthly subscription via PIX (quantity=3 = loyalty period)
      console.log('[PaymentController.payWithPix] Sending to Celcoin:', {
        customerId: order.customer_id, totalCents, orderId: order.order_id, quantity: 3, planGalaxPayId: order.celcoin_plan_id_pix
      });
      const subData = await CelcoinService.subscribePix(
        order.customer_id,
        totalCents,
        order.order_id,
        3,
        order.celcoin_plan_id_pix
      );
      console.log('[PaymentController.payWithPix] Celcoin response:', subData);

      // Persist subscription + upsell registrations atomically
      await db.transaction(async (trx) => {
        await trx('orders').where({ id: orderId }).update({
          celcoin_charge_id: subData.subscriptionId,
          updated_at: new Date(),
        });

        await trx('subscriptions').where({ order_id: orderId }).update({
          celcoin_subscription_id: subData.subscriptionId,
          payment_link: subData.paymentPage,
          updated_at: new Date(),
        });

        if (orderUpsells.length > 0) {
          await trx('order_upsells')
            .insert(orderUpsells.map((u: any) => ({ order_id: orderId, upsell_id: u.id })))
            .onConflict(['order_id', 'upsell_id']).ignore();
        }
      });

      return res.json({
        subscriptionId: subData.subscriptionId,
        qrCodeImage: subData.qrCodeImage,  // URL to QR Code image
        qrCodeText: subData.qrCodeText,    // EMV copy-paste stringp
        paymentPage: subData.paymentPage,
      });
    } catch (error: any) {
      console.error('[PaymentController.payWithPix]', error?.response?.data ?? error);
      return res.status(500).json({ error: 'Failed to create PIX subscription' });
    }
  },

  /**
   * POST /api/payments/credit-card
   * Creates a monthly Credit Card subscription.
   * - First charge happens immediately (today).
   * - Celcoin automatically debits the card every month.
   */
  async payWithCreditCard(req: AuthRequest, res: Response) {
    try {
      const { orderId, card } = req.body;
      if (!orderId || !card) return res.status(400).json({ error: 'orderId and card are required' });

      const order = await getOrderForPayment(orderId);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (order.user_id !== req.userId) {
        return res.status(403).json({ error: 'Você não tem permissão para pagar este pedido.' });
      }
      if (order.payment_status === 'confirmed' || order.payment_status === 'paid') {
        return res.status(400).json({ error: 'Este pedido já foi pago com sucesso.' });
      }

      if (order.celcoin_charge_id) {
        console.log(`[PaymentController] Retrying payment for order ${orderId}. Cancelling old sub ${order.celcoin_charge_id}`);
        try {
          await CelcoinService.cancelSubscription(order.celcoin_charge_id);
        } catch (e) {
          console.warn(`[PaymentController] Could not cancel old sub ${order.celcoin_charge_id}:`, e);
        }
      }

      await CelcoinService.registerCustomer({
        id: order.customer_id,
        name: order.name,
        cpf: order.cpf,
        email: order.email,
        whatsapp: order.whatsapp,
      });

      // Load upsells from order_upsells table
      const orderUpsells = await db('order_upsells')
        .join('upsells', 'order_upsells.upsell_id', '=', 'upsells.id')
        .where('order_upsells.order_id', orderId)
        .where('upsells.active', true)
        .select('upsells.id', 'upsells.price_cents');

      const upsellsTotal = orderUpsells.reduce((sum: number, u: any) => sum + u.price_cents, 0);
      const totalCents = order.price_cents + upsellsTotal;

      // Create recurring monthly subscription via credit card
      const result = await CelcoinService.subscribeCreditCard(
        order.customer_id,
        totalCents,
        order.order_id,
        card,
        order.celcoin_plan_id_credit_card
      );

      const paymentStatus = result.status === 'active' ? 'confirmed' : 'analysing';
      const orderStatus = result.status === 'active' ? 'registered' : 'analysing_payment';

      await db.transaction(async (trx) => {
        await trx('orders').where({ id: orderId }).update({
          celcoin_charge_id: result.subscriptionId,
          payment_status: paymentStatus,
          order_status: orderStatus,
          updated_at: new Date(),
        });

        await trx('subscriptions').where({ order_id: orderId }).update({
          celcoin_subscription_id: result.subscriptionId,
          payment_status: paymentStatus,
          status: result.status === 'active' ? 'active' : 'pending',
          updated_at: new Date(),
        });

        if (orderUpsells.length > 0) {
          await trx('order_upsells')
            .insert(orderUpsells.map((u: any) => ({ order_id: orderId, upsell_id: u.id })))
            .onConflict(['order_id', 'upsell_id']).ignore();
        }
      });

      return res.json({ subscriptionId: result.subscriptionId, status: result.status });
    } catch (error: any) {
      console.error('[PaymentController.payWithCreditCard]', error?.response?.data ?? error);
      return res.status(500).json({ error: 'Failed to create credit card subscription' });
    }
  },

  /**
   * POST /api/payments/boleto
   * Creates a monthly Boleto subscription.
   * - Celcoin generates the boleto immediately.
   * - quantity=3 (loyalty period)
   */
  async payWithBoleto(req: AuthRequest, res: Response) {
    try {
      const { orderId, address } = req.body;
      if (!orderId) return res.status(400).json({ error: 'orderId is required' });

      const order = await getOrderForPayment(orderId);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (order.user_id !== req.userId) {
        return res.status(403).json({ error: 'Você não tem permissão para pagar este pedido.' });
      }
      if (order.payment_status === 'confirmed' || order.payment_status === 'paid') {
        return res.status(400).json({ error: 'Este pedido já foi pago com sucesso.' });
      }

      if (order.celcoin_charge_id) {
        console.log(`[PaymentController.payWithBoleto] Retrying payment for order ${orderId}. Cancelling old sub ${order.celcoin_charge_id}`);
        try {
          await CelcoinService.cancelSubscription(order.celcoin_charge_id);
        } catch (e) {
          console.warn(`[PaymentController.payWithBoleto] Could not cancel old sub ${order.celcoin_charge_id}:`, e);
        }
      }

      let finalAddress = address;

      if (!finalAddress) {
        if (order.zip_code && order.street && order.street_number && order.neighborhood && order.city && order.state) {
          finalAddress = {
            zipCode: order.zip_code,
            street: order.street,
            number: order.street_number,
            neighborhood: order.neighborhood,
            city: order.city,
            state: order.state,
            complement: order.complement,
          };
        } else {
          return res.status(400).json({ error: 'Endereço completo é obrigatório para pagamento via boleto.' });
        }
      } else {
        if (!finalAddress?.zipCode || !finalAddress?.street || !finalAddress?.number || !finalAddress?.neighborhood || !finalAddress?.city || !finalAddress?.state) {
          return res.status(400).json({ error: 'Endereço completo é obrigatório para pagamento via boleto.' });
        }

        // Save new address to customer record
        await db('customers').where({ id: order.customer_id }).update({
          zip_code: finalAddress.zipCode.replace(/\D/g, ''),
          street: finalAddress.street,
          street_number: finalAddress.number,
          neighborhood: finalAddress.neighborhood,
          city: finalAddress.city,
          state: finalAddress.state,
          complement: finalAddress.complement ?? null,
          updated_at: new Date(),
        });
      }

      // Register customer in Celcoin with address
      await CelcoinService.registerCustomer({
        id: order.customer_id,
        name: order.name,
        cpf: order.cpf,
        email: order.email,
        whatsapp: order.whatsapp,
        address: {
          zipCode: finalAddress.zipCode,
          street: finalAddress.street,
          number: finalAddress.number,
          neighborhood: finalAddress.neighborhood,
          city: finalAddress.city,
          state: finalAddress.state,
          complement: finalAddress.complement,
        },
      });

      // Load upsells from order_upsells table
      const orderUpsells = await db('order_upsells')
        .join('upsells', 'order_upsells.upsell_id', '=', 'upsells.id')
        .where('order_upsells.order_id', orderId)
        .where('upsells.active', true)
        .select('upsells.price_cents');

      const upsellsTotal = orderUpsells.reduce((sum: number, u: any) => sum + u.price_cents, 0);
      const totalCents = order.price_cents + upsellsTotal;

      const subData = await CelcoinService.subscribeBoleto(
        order.customer_id,
        totalCents,
        order.order_id,
        order.celcoin_plan_id_pix
      );

      await db.transaction(async (trx) => {
        await trx('orders').where({ id: orderId }).update({
          celcoin_charge_id: subData.subscriptionId,
          updated_at: new Date(),
        });

        await trx('subscriptions').where({ order_id: orderId }).update({
          celcoin_subscription_id: subData.subscriptionId,
          payment_link: subData.paymentLink,
          updated_at: new Date(),
        });
      });

      return res.json({
        subscriptionId: subData.subscriptionId,
        paymentLink: subData.paymentLink,
        boletoPdf: subData.boletoPdf,
        boletoBankLine: subData.boletoBankLine,
        boletoPage: subData.boletoPage,
      });
    } catch (error: any) {
      console.error('[PaymentController.payWithBoleto]', error?.response?.data ?? error);
      return res.status(500).json({ error: 'Failed to create boleto subscription' });
    }
  },

  /**
   * POST /webhook/celcoin
   * Celcoin fires this when a transaction status changes (paid, canceled, etc).
   * Handles both one-time charges and subscription transactions.
   * Must return 200 immediately to stop retries.
   */
  async webhook(req: Request, res: Response) {
    try {
      res.status(200).send('OK');

      const body = req.body;
      const event = body?.event;

      const oldSystemUrl = 'https://api.cashbarber.com.br/api/blackbarber/galaxpay/webhook';
      setImmediate(() => {
        const hashToSend = req.headers['webhook-hash'] || process.env.CELCOIN_WEBHOOK_HASH;
        console.log('[Webhook Forwarder] Repassando para sistema antigo com hash:', hashToSend);

        axios.post(oldSystemUrl, body, {
          headers: {
            'Webhook-Hash': hashToSend
          }
        }).catch(err => {
          console.warn('[Webhook Forwarder] O sistema antigo falhou:', err.response?.data || err.message);
        });
      });

      if (!event) return;

      if (event === 'transaction.updateStatus' || event === 'charge.statusChanged') {
        const transaction = body?.Transaction ?? body?.Charge;
        if (!transaction) return;

        const newStatus = transaction.status;
        const subscriptionId = transaction.subscriptionGalaxPayId?.toString()
          ?? transaction.galaxPayId?.toString()
          ?? null;

        if (!subscriptionId) return;

        const order = await db('orders').where({ celcoin_charge_id: subscriptionId }).first();
        if (!order) {
          console.warn(`[Celcoin Webhook] No order found for subscriptionId=${subscriptionId}`);
          return;
        }

        let payment_status: string;
        let order_status: string;

        if (['payedPix', 'payedBoleto', 'payedCreditCard', 'paid'].includes(newStatus)) {
          payment_status = 'confirmed';
          order_status = 'registered';
        } else if (['canceled', 'denied', 'error'].includes(newStatus)) {
          payment_status = 'error';
          order_status = 'payment_pending';
        } else {
          return;
        }

        await db.transaction(async (trx) => {
          await trx('orders').where({ id: order.id }).update({
            payment_status,
            order_status,
            status_updated_at: new Date(),
            updated_at: new Date(),
          });

          const pixLink = transaction.Pix?.page ?? transaction.Boleto?.pdf ?? null;

          await trx('subscriptions').where({ order_id: order.id }).update({
            payment_status,
            payment_link: pixLink,
            updated_at: new Date(),
          });
        });

      }

    } catch (err) {
      console.error('[Celcoin Webhook] Error processing:', err);
    }
  },
};
