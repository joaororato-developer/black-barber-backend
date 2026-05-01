import { Request, Response } from 'express';
import db from '../database/connection';
import { CheckoutRequest } from '../middlewares/checkoutAuth';

export const OrderController = {
  async createOrder(req: CheckoutRequest, res: Response) {
    try {
      const customerId = req.checkoutCustomerId;
      const { plan, additionalEyebrow, paymentType } = req.body;

      if (!customerId || !plan || !paymentType) {
        return res.status(400).json({ error: 'Missing required payload fields' });
      }

      // Idempotency: check if there's already a pending order for this customer
      const existingOrder = await db('orders')
        .where({
          customer_id: customerId,
          payment_status: 'pending',
          order_status: 'payment_pending'
        })
        .first();

      if (existingOrder) {
        // Update the existing pending order with the new plan/payment selections
        await db('orders')
          .where({ id: existingOrder.id })
          .update({ plan, payment_type: paymentType, updated_at: new Date() });

        // Sync upsells: delete existing and re-insert based on current selection
        await db('order_upsells').where({ order_id: existingOrder.id }).delete();

        if (additionalEyebrow) {
          const upsell = await db('upsells').where({ key: 'additional_eyebrow', active: true }).first();
          if (upsell) {
            await db('order_upsells').insert({ order_id: existingOrder.id, upsell_id: upsell.id });
          }
        }

        return res.status(200).json({
          message: 'Existing pending order updated and returned',
          orderId: existingOrder.id
        });
      }

      // Create new order + subscription in a single transaction
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

        return order.id;
      });

      return res.status(201).json({ message: 'Order created successfully', orderId });
    } catch (error) {
      console.error(error);
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

      // For each order, load associated upsells in one batch query
      const orderIds = orders.map(o => o.order_id);
      const upsellRows = orderIds.length
        ? await db('order_upsells')
            .join('upsells', 'order_upsells.upsell_id', '=', 'upsells.id')
            .whereIn('order_upsells.order_id', orderIds)
            .select('order_upsells.order_id', 'upsells.key', 'upsells.label')
        : [];

      // Group upsells by order_id
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
        createdAt: o.created_at,
        updatedAt: o.updated_at
      }));

      return res.json(mappedOrders);
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  async updateERPStatus(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { erp_status } = req.body;

      if (!erp_status || !['pending', 'registered'].includes(erp_status)) {
        return res.status(400).json({ error: 'Invalid ERP status' });
      }

      const updateCount = await db('orders')
        .where({ id })
        .update({ order_status: erp_status, status_updated_at: db.fn.now(), updated_at: db.fn.now() });

      if (updateCount === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }

      return res.json({ message: 'ERP status updated properly' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
};
