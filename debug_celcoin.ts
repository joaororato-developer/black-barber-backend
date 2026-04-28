import axios from 'axios';
import dotenv from 'dotenv';
const { Client } = require('pg');
dotenv.config();

async function test() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  try {
    await client.connect();
    const resDb = await client.query('SELECT celcoin_subscription_id FROM subscriptions WHERE celcoin_subscription_id IS NOT NULL LIMIT 1');
    const subscriptionId = resDb.rows[0]?.celcoin_subscription_id;
    console.log('Testing with real sub ID:', subscriptionId);
    
    if (!subscriptionId) {
      console.log('No subscription found in DB.');
      return;
    }

    const authString = Buffer.from(`${process.env.CELCOIN_ID}:${process.env.CELCOIN_HASH}`).toString('base64');
    
    const tokenRes = await axios.post(`${process.env.CELCOIN_URL}/token`, {
      grant_type: 'authorization_code',
      scope: 'customers.read customers.write charges.read charges.write subscriptions.read subscriptions.write',
    }, {
      headers: {
        Authorization: `Basic ${authString}`,
        'Content-Type': 'application/json',
      },
    });

    const token = tokenRes.data.access_token;

    const subRes = await axios.get(`${process.env.CELCOIN_URL}/subscriptions?galaxPayIds=${subscriptionId}&startAt=0&limit=1`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    console.log('Subscription API Response:', JSON.stringify(subRes.data, null, 2));

    // Wait, let's also test the transactions endpoint
    const transRes = await axios.get(`${process.env.CELCOIN_URL}/transactions?galaxPayIds=${subscriptionId}&startAt=0&limit=1`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log('Transactions API Response:', JSON.stringify(transRes.data, null, 2));

  } catch (err: any) {
    console.error('Error:', JSON.stringify(err?.response?.data || err.message, null, 2));
  } finally {
    await client.end();
  }
}

test();
