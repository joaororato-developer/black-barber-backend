import { Request, Response } from 'express';
import db from '../database/connection';
import { CelcoinService } from '../services/CelcoinService';

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
      'plans.price_cents',
      'orders.additional_eyebrow',
      'customers.id as customer_id',
      'customers.name',
      'customers.cpf',
      'customers.email',
      'customers.whatsapp'
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
  async payWithPix(req: Request, res: Response) {
    try {
      const { orderId } = req.body;
      if (!orderId) return res.status(400).json({ error: 'orderId is required' });

      const order = await getOrderForPayment(orderId);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (order.celcoin_charge_id) {
        return res.status(400).json({ error: 'Pagamento já foi iniciado para este pedido. Acesse sua conta para ver os detalhes.' });
      }

      // Register/upsert customer in Celcoin (idempotent)
      await CelcoinService.registerCustomer({
        id: order.customer_id,
        name: order.name,
        cpf: order.cpf,
        email: order.email,
        whatsapp: order.whatsapp,
      });

      const eyebrowExtra = order.additional_eyebrow ? 4000 : 0;
      const totalCents = order.price_cents + eyebrowExtra;

      // Create recurring monthly subscription via PIX
      const subData = await CelcoinService.subscribePix(
        order.customer_id,
        totalCents,
        order.order_id
      );

      // Store the Celcoin subscription ID on the order and subscription
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
      });

      return res.json({
        subscriptionId: subData.subscriptionId,
        qrCodeImage: subData.qrCodeImage,  // URL to QR Code image
        qrCodeText: subData.qrCodeText,    // EMV copy-paste string
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
  async payWithCreditCard(req: Request, res: Response) {
    try {
      const { orderId, card } = req.body;
      if (!orderId || !card) return res.status(400).json({ error: 'orderId and card are required' });

      const order = await getOrderForPayment(orderId);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (order.celcoin_charge_id) {
        return res.status(400).json({ error: 'Pagamento já foi iniciado para este pedido. Acesse sua conta para ver os detalhes.' });
      }

      await CelcoinService.registerCustomer({
        id: order.customer_id,
        name: order.name,
        cpf: order.cpf,
        email: order.email,
        whatsapp: order.whatsapp,
      });

      const eyebrowExtra = order.additional_eyebrow ? 4000 : 0;
      const totalCents = order.price_cents + eyebrowExtra;

      // Create recurring monthly subscription via credit card
      const result = await CelcoinService.subscribeCreditCard(
        order.customer_id,
        totalCents,
        order.order_id,
        card
      );

      await db.transaction(async (trx) => {
        await trx('orders').where({ id: orderId }).update({
          celcoin_charge_id: result.subscriptionId,
          updated_at: new Date(),
        });

        await trx('subscriptions').where({ order_id: orderId }).update({
          celcoin_subscription_id: result.subscriptionId,
          updated_at: new Date(),
        });
      });

      return res.json({ subscriptionId: result.subscriptionId, status: result.status });
    } catch (error: any) {
      console.error('[PaymentController.payWithCreditCard]', error?.response?.data ?? error);
      return res.status(500).json({ error: 'Failed to create credit card subscription' });
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
