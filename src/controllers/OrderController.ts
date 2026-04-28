import { Request, Response } from 'express';
import db from '../database/connection';
import { CheckoutRequest } from '../middlewares/checkoutAuth';

const PLAN_PRICES: Record<string, number> = {
  plano_barba: 9800,
  plano_black: 11800,
  plano_premium: 17800,
};

export const OrderController = {
  async createOrder(req: CheckoutRequest, res: Response) {
    try {
      // customerId is extracted server-side from the signed checkout token —
      // never trusted from the request body.
      const customerId = req.checkoutCustomerId;
      const { plan, additionalEyebrow, paymentType } = req.body;

      if (!customerId || !plan || !paymentType) {
        return res.status(400).json({ error: 'Missing required payload fields' });
      }

      // Idempotency check: check if there's already an identical pending order
      const existingOrder = await db('orders')
        .where({
          customer_id: customerId,
          plan,
          additional_eyebrow: additionalEyebrow || false,
          payment_type: paymentType,
          payment_status: 'pending',
          order_status: 'payment_pending'
        })
        .first();

      if (existingOrder) {
        return res.status(200).json({
          message: 'Existing pending order returned',
          orderId: existingOrder.id
        });
      }

      // We need to use a transaction to ensure both order and subscription are created
      const orderId = await db.transaction(async (trx) => {
        const [order] = await trx('orders').insert({
          customer_id: customerId,
          plan,
          additional_eyebrow: additionalEyebrow || false,
          payment_type: paymentType,
          payment_status: 'pending',
          order_status: 'payment_pending'
        }).returning('*');

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

      return res.status(201).json({
        message: 'Order created successfully',
        orderId: orderId
      });
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
          'orders.additional_eyebrow',
          'orders.payment_type',
          'orders.payment_status',
          'orders.order_status',
          'orders.created_at',
          'orders.updated_at'
        );

      if (name) {
        query = query.where('customers.name', 'ilike', `%${name}%`);
      }

      if (date) {
        query = query.whereRaw("DATE(orders.created_at AT TIME ZONE 'America/Sao_Paulo') = ?", [date as unknown as Buffer<ArrayBufferLike>]);
      }

      if (paymentStatus && paymentStatus !== 'all') {
        query = query.where('orders.payment_status', paymentStatus);
      }

      if (erpStatus && erpStatus !== 'all') {
        if (erpStatus === 'pending') {
          query = query.whereIn('orders.order_status', ['pending', 'payment_pending']);
        } else {
          query = query.where('orders.order_status', erpStatus);
        }
      }

      const orders = await query.orderBy('orders.created_at', 'desc');

      const mappedOrders = orders.map(o => ({
        id: o.order_id,
        name: o.name,
        email: o.email,
        phone: o.phone,
        plan: o.plan,
        additionalEyebrow: o.additional_eyebrow,
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
