import { Request, Response } from 'express';
import db from '../database/connection';

export const CustomerController = {
  async createLead(req: Request, res: Response) {
    try {
      const { name, email, phone, plan, payment_method, payment_status } = req.body;

      if (!name || !email || !phone || !plan || !payment_method) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const [newCustomer] = await db('customers').insert({
        name,
        email,
        phone,
        plan,
        payment_method,
        payment_status: payment_status || 'pending',
        erp_status: 'pending'
      }).returning('*');

      return res.status(201).json(newCustomer);
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  async index(req: Request, res: Response) {
    try {
      const customers = await db('customers').orderBy('created_at', 'desc');
      
      const mappedCustomers = customers.map(c => ({
        id: c.id,
        name: c.name,
        email: c.email,
        phone: c.phone,
        plan: c.plan,
        paymentMethod: c.payment_method,
        paymentStatus: c.payment_status,
        erpStatus: c.erp_status,
        createdAt: c.created_at,
        updatedAt: c.updated_at
      }));

      return res.json(mappedCustomers);
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

      const updateCount = await db('customers')
        .where({ id })
        .update({ erp_status, updated_at: db.fn.now() });

      if (updateCount === 0) {
        return res.status(404).json({ error: 'Customer not found' });
      }

      return res.json({ message: 'ERP status updated properly' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
};
