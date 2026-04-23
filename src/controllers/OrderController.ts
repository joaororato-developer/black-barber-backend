import { Request, Response } from 'express';
import db from '../database/connection';

export const OrderController = {
  async createOrder(req: Request, res: Response) {
    try {
      const { customerId, plan, additionalEyebrow, paymentType } = req.body;

      if (!customerId || !plan || !paymentType) {
        return res.status(400).json({ error: 'Missing required payload fields' });
      }

      const [order] = await db('orders').insert({
        customer_id: customerId,
        plan,
        additional_eyebrow: additionalEyebrow || false,
        payment_type: paymentType,
        payment_status: 'pending',
        order_status: 'payment_pending'
      }).returning('*');

      return res.status(201).json({
        message: 'Order created successfully',
        orderId: order.id
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
        .select(
          'orders.id as order_id',
          'customers.id as customer_id',
          'customers.name',
          'customers.email',
          'customers.whatsapp as phone',
          'orders.plan',
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
