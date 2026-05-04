import axios from 'axios';

interface CelcoinToken {
  access_token: string;
  expiresAt: number;
}

interface CardData {
  number: string;
  holderName: string;
  month: string;
  year: string;
  cvv: string;
}

let tokenCache: CelcoinToken | null = null;

const celcoinApi = axios.create({
  baseURL: process.env.CELCOIN_URL,
});

/**
 * Obtains a bearer token using Basic Auth (GalaxId:GalaxHash).
 * Tokens last 600s — cached with a 30s safety buffer.
 */
async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.access_token;
  }

  const authString = Buffer.from(
    `${process.env.CELCOIN_ID}:${process.env.CELCOIN_HASH}`
  ).toString('base64');

  const response = await celcoinApi.post('/token', {
    grant_type: 'authorization_code',
    scope: 'customers.read customers.write plans.read plans.write subscriptions.read subscriptions.write transactions.read transactions.write charges.read charges.write',
  }, {
    headers: {
      Authorization: `Basic ${authString}`,
      'Content-Type': 'application/json',
    },
  });

  const expiresIn: number = response.data.expires_in ?? 600;
  tokenCache = {
    access_token: response.data.access_token,
    expiresAt: Date.now() + (expiresIn - 30) * 1000,
  };

  return tokenCache.access_token;
}

function today(): string {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/**
 * Normalizes MM/YY or MM+YYYY into the 'YYYY-MM' format required by Celcoin.
 */
function parseExpiresAt(month: string, year: string): string {
  const raw = month.trim();
  if (raw.includes('/')) {
    const [mm, yy] = raw.split('/');
    const yyyy = yy.trim().length === 2 ? `20${yy.trim()}` : yy.trim();
    return `${yyyy}-${mm.trim().padStart(2, '0')}`;
  }
  const yyyy = year.trim().length === 2 ? `20${year.trim()}` : year.trim();
  return `${yyyy}-${raw.padStart(2, '0')}`;
}

export const CelcoinService = {
  /**
   * Registers or updates a customer in Celcoin.
   * Safe to call multiple times — Celcoin will upsert by myId.
   */
  async registerCustomer(customer: {
    id: string;
    name: string;
    cpf: string;
    email: string;
    whatsapp: string;
    address?: {
      zipCode: string;
      street: string;
      number: string;
      neighborhood: string;
      city: string;
      state: string;
      complement?: string;
    };
  }) {
    const token = await getAccessToken();

    const payload: Record<string, any> = {
      myId: customer.id,
      name: customer.name,
      document: customer.cpf.replace(/\D/g, ''),
      emails: [customer.email],
      phones: [customer.whatsapp.replace(/\D/g, '')],
    };

    if (customer.address) {
      payload.Address = {
        zipCode: customer.address.zipCode.replace(/\D/g, ''),
        street: customer.address.street,
        number: customer.address.number,
        neighborhood: customer.address.neighborhood,
        city: customer.address.city,
        state: customer.address.state,
        complement: customer.address.complement ?? '',
      };
    }

    const res = await celcoinApi.post('/customers', payload, { headers: authHeaders(token) });

    return res.data;
  },


  /**
   * Creates a monthly Credit Card subscription.
   * - First charge: today (debited immediately)
   * - Celcoin automatically debits the card every month
   */
  async subscribeCreditCard(
    customerId: string,
    amountInCents: number,
    orderId: string,
    card: CardData,
    planGalaxPayId?: number,
    firstAmount?: number,
    firstPayDayDate?: string
  ) {
    const token = await getAccessToken();
    const expiresAt = parseExpiresAt(card.month, card.year);

    const payload: any = {
      myId: `SUB_CC_${orderId}`,
      planGalaxPayId,
      value: amountInCents,
      quantity: 0,
      periodicity: 'monthly',
      firstPayDayDate: firstPayDayDate ?? today(),
      mainPaymentMethodId: 'creditcard',
      Customer: { myId: customerId },
      PaymentMethodCreditCard: {
        Card: {
          number: card.number.replace(/\s/g, ''),
          holder: card.holderName,
          expiresAt,                 // 'YYYY-MM' format
          cvv: card.cvv,
        },
      },
    };

    // Support for pro-rata: if firstAmount is different from amountInCents
    if (firstAmount && firstAmount !== amountInCents) {
      payload.Transactions = [
        {
          value: firstAmount,
          paydayDate: today(),
          myId: `TRX_UPGRADE_${orderId}`
        }
      ];
    }

    const res = await celcoinApi.post('/subscriptions', payload, { headers: authHeaders(token) });

    const sub = res.data?.Subscription;

    return {
      subscriptionId: sub?.galaxPayId?.toString() ?? null,
      status: sub?.status ?? null,
    };
  },

  /**
   * Creates a subscription without providing credit card data.
   * Used for plan changes — Celcoin returns a payment link to enter card details.
   * Pro-rata logic: the first transaction can have a different value than the recurring one.
   */
  async subscribeWithoutCard(
    customer: any,
    proRataAmount: number,
    fullAmountInCents: number,
    orderId: string,
    paymentMethodId: string,
    planGalaxPayId?: number,
    firstPayDayDate?: string
  ) {
    const token = await getAccessToken();

    const normalizedPaymentMethod = paymentMethodId === 'credit_card' ? 'creditcard' : paymentMethodId;

    const quantity = normalizedPaymentMethod === 'creditcard' ? 0 : 3;

    const payload: any = {
      myId: `SUB_UPGRADE_${orderId}`,
      planGalaxPayId,
      value: fullAmountInCents,
      quantity,
      periodicity: 'monthly',
      firstPayDayDate: firstPayDayDate ?? today(),
      mainPaymentMethodId: normalizedPaymentMethod,
      Customer: {
        myId: customer.id,
        name: customer.name,
        document: customer.cpf.replace(/\D/g, ''),
        emails: [customer.email],
      },
      Transactions: [
        {
          myId: `TR_UPGRADE_1_${orderId}`,
          value: proRataAmount,
          paydayDate: today()
        }
      ]
    };

    if (customer.address) {
      const addr = typeof customer.address === 'string' ? JSON.parse(customer.address) : customer.address;
      payload.Customer.Address = {
        zipCode: addr.zipCode.replace(/\D/g, ''),
        street: addr.street,
        number: addr.number,
        neighborhood: addr.neighborhood,
        city: addr.city,
        state: addr.state,
        complement: addr.complement ?? '',
      };
    }

    const res = await celcoinApi.post('/subscriptions', payload, { headers: authHeaders(token) });

    const sub = res.data?.Subscription;

    return {
      subscriptionId: sub?.galaxPayId?.toString() ?? null,
      paymentLink: sub?.paymentLink ?? null,
    };
  },

  /**
   * Creates a monthly Boleto subscription.
   * Returns boleto PDF, bank line, and payment page from the first transaction.
   * Field path: Subscription.Transactions[0].Boleto
   */
  async subscribeBoleto(customerId: string, amountInCents: number, orderId: string, planGalaxPayId?: number, firstPayDayDate?: string) {
    const token = await getAccessToken();

    const res = await celcoinApi.post('/subscriptions', {
      myId: `SUB_BOLETO_${orderId}`,
      planGalaxPayId,
      value: amountInCents,
      quantity: 3,
      periodicity: 'monthly',
      firstPayDayDate: firstPayDayDate ?? today(),
      mainPaymentMethodId: 'boleto',
      Customer: { myId: customerId },
    }, { headers: authHeaders(token) });

    const sub = res.data?.Subscription;
    const boleto = sub?.Transactions?.[0]?.Boleto;

    return {
      subscriptionId: sub?.galaxPayId?.toString() ?? null,
      paymentLink: sub?.paymentLink ?? null,
      boletoPdf: boleto?.pdf ?? null,
      boletoBankLine: boleto?.bankLine ?? null,
      boletoPage: boleto?.page ?? null,
    };
  },

  /**
   * Cancels a subscription in Celcoin.
   */
  async cancelSubscription(subscriptionId: string) {
    const token = await getAccessToken();

    const res = await celcoinApi.delete(`/subscriptions/${subscriptionId}/galaxPayId`, {
      headers: authHeaders(token),
    });

    return res.data;
  },

  /**
   * Updates the credit card of an existing subscription.
   */
  async updateSubscriptionCard(subscriptionId: string, card: CardData) {
    const token = await getAccessToken();
    const expiresAt = parseExpiresAt(card.month, card.year);

    const res = await celcoinApi.put(`/subscriptions/${subscriptionId}/galaxPayId`, {
      PaymentMethodCreditCard: {
        Card: {
          number: card.number.replace(/\s/g, ''),
          holder: card.holderName,
          expiresAt,
          cvv: card.cvv,
        },
      },
    }, { headers: authHeaders(token) });

    return res.data;
  },

  /**
   * Updates the credit card of a SPECIFIC failed transaction and triggers a new payment attempt.
   */
  async updateTransactionCard(transactionId: string, card: CardData) {
    const token = await getAccessToken();
    const expiresAt = parseExpiresAt(card.month, card.year);

    const res = await celcoinApi.put(`/transactions/${transactionId}/galaxPayId`, {
      paydayDate: today(), // Forces immediate reprocessing
      PaymentMethodCreditCard: {
        Card: {
          number: card.number.replace(/\s/g, ''),
          holder: card.holderName,
          expiresAt,
          cvv: card.cvv,
        },
      },
    }, { headers: authHeaders(token) });

    return res.data;
  },

  /**
   * Fetches subscription details + ALL transactions via dedicated /transactions endpoint.
   * The /subscriptions endpoint only embeds a limited set of transactions; the dedicated
   * /transactions endpoint with subscriptionGalaxPayIds filter returns the full history.
   */
  async getSubscriptionPaymentInfo(subscriptionId: string) {
    const token = await getAccessToken();

    // Fetch subscription metadata and all transactions in parallel
    const [subRes, trxRes] = await Promise.all([
      celcoinApi.get(`/subscriptions?galaxPayIds=${subscriptionId}&startAt=0&limit=1`, {
        headers: authHeaders(token)
      }),
      celcoinApi.get(`/transactions?subscriptionGalaxPayIds=${subscriptionId}&startAt=0&limit=100`, {
        headers: authHeaders(token)
      }).catch(() => null), // graceful fallback if endpoint unavailable
    ]);

    const sub = subRes.data?.Subscriptions?.[0];
    if (!sub) {
      throw new Error("Subscription not found in Celcoin");
    }

    const pendingStatuses = new Set([
      'pending', 'pendingBoleto', 'pendingPix', 'pendingCreditCard',
      'waitingPayment', 'notSend', 'denied', 'waitingBoleto', 'waitingPix',
    ]);
    const paidStatuses = new Set([
      'paid', 'payedBoleto', 'payedPix', 'payedCreditCard', 'confirmed',
    ]);

    // Prefer dedicated /transactions response (full history); fall back to embedded ones
    const rawTransactions: any[] =
      trxRes?.data?.Transactions?.length
        ? trxRes.data.Transactions
        : (sub?.Transactions ?? []);

    // Sort: pending first, then by paydayDate desc
    const sorted = [...rawTransactions].sort((a, b) => {
      const aPending = pendingStatuses.has(a.status) ? 0 : 1;
      const bPending = pendingStatuses.has(b.status) ? 0 : 1;
      if (aPending !== bPending) return aPending - bPending;
      return new Date(b.paydayDate ?? 0).getTime() - new Date(a.paydayDate ?? 0).getTime();
    });

    const mapTransaction = (t: any) => ({
      transactionId: t.galaxPayId?.toString() ?? null,
      status: t.status,
      isPending: pendingStatuses.has(t.status),
      isPaid: paidStatuses.has(t.status),
      value: t.value,
      paydayDate: t.paydayDate,
	  payday: t.payday,
      boleto: t.Boleto ? {
        pdf: t.Boleto.pdf,
        bankLine: t.Boleto.bankLine,
        paymentPage: t.Boleto.page ?? null,
      } : null,
      pix: t.Pix ? {
        qrCode: t.Pix.qrCode ?? null,
        paymentLink: t.Pix.paymentLink ?? null,
      } : null,
    });

    // All transactions for full history display
    const allTransactions = sorted.map(mapTransaction);

    // Primary = first pending, for legacy fields
    const primaryRaw =
      rawTransactions.find((t: any) => pendingStatuses.has(t.status))
      ?? rawTransactions[0];

    return {
      paymentMethod: sub?.mainPaymentMethodId,
      status: primaryRaw?.status ?? null,
      transactionId: primaryRaw?.galaxPayId?.toString() ?? null,
      paymentLink: sub?.paymentLink ?? null,
      boleto: primaryRaw?.Boleto ? {
        pdf: primaryRaw.Boleto.pdf,
        bankLine: primaryRaw.Boleto.bankLine,
        paymentPage: primaryRaw.Boleto.page ?? null,
      } : null,
      pix: primaryRaw?.Pix ? {
        qrCode: primaryRaw.Pix.qrCode ?? null,
        paymentLink: primaryRaw.Pix.paymentLink ?? null,
      } : null,
      transactions: allTransactions,
    };
  }
};
