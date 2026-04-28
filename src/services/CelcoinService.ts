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
    scope: 'customers.read customers.write charges.read charges.write subscriptions.read subscriptions.write',
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
  }) {
    const token = await getAccessToken();

    const res = await celcoinApi.post('/customers', {
      myId: customer.id,
      name: customer.name,
      document: customer.cpf.replace(/\D/g, ''),
      emails: [customer.email],
      phones: [customer.whatsapp.replace(/\D/g, '')],
    }, { headers: authHeaders(token) });

    return res.data;
  },

  /**
   * Creates a monthly PIX subscription.
   * - First charge: today (generates QR Code immediately)
   * - Celcoin generates a new PIX automatically every month
   *
   * Returns QR code data for the first payment.
   * Field path: Subscription.Transactions[0].Pix
   */
  async subscribePix(customerId: string, amountInCents: number, orderId: string) {
    const token = await getAccessToken();

    const res = await celcoinApi.post('/subscriptions', {
      myId: `SUB_PIX_${orderId}`,
      value: amountInCents,
      quantity: 0,            // 0 = indefinite (monthly forever until cancelled)
      periodicity: 'monthly',
      firstPayDayDate: today(),
      mainPaymentMethodId: 'pix',
      Customer: { myId: customerId },
    }, { headers: authHeaders(token) });

    const sub = res.data?.Subscription;
    const pix = sub?.Transactions?.[0]?.Pix;

    return {
      subscriptionId: sub?.galaxPayId?.toString() ?? null,
      qrCodeImage: pix?.image ?? null,    // URL to QR Code image
      qrCodeText: pix?.qrCode ?? null,    // EMV copy-paste string
      paymentPage: pix?.page ?? null,
    };
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
    card: CardData
  ) {
    const token = await getAccessToken();
    const expiresAt = parseExpiresAt(card.month, card.year);

    console.log('[CelcoinService.subscribeCreditCard] expiresAt resolved to:', expiresAt);

    const res = await celcoinApi.post('/subscriptions', {
      myId: `SUB_CC_${orderId}`,
      value: amountInCents,
      quantity: 0,
      periodicity: 'monthly',
      firstPayDayDate: today(),
      mainPaymentMethodId: 'creditcard',
      Customer: { myId: customerId },
      PaymentMethodCreditCard: {
        Card: {
          number: card.number.replace(/\s/g, ''),
          holder: card.holderName,   // 'holder', not 'holderName'
          expiresAt,                 // 'YYYY-MM' format
          cvv: card.cvv,
        },
      },
    }, { headers: authHeaders(token) });

    const sub = res.data?.Subscription;

    return {
      subscriptionId: sub?.galaxPayId?.toString() ?? null,
      status: sub?.status ?? null,
    };
  },

  /**
   * Cancels a subscription in Celcoin.
   */
  async cancelSubscription(subscriptionId: string) {
    const token = await getAccessToken();

    const res = await celcoinApi.delete(`/subscriptions/${subscriptionId}`, {
      headers: authHeaders(token),
    });

    return res.data;
  },

  /**
   * Fetches subscription details to get the current payment information (QR Code/Link).
   */
  async getSubscriptionPaymentInfo(subscriptionId: string) {
    const token = await getAccessToken();
    const res = await celcoinApi.get(`/subscriptions?galaxPayIds=${subscriptionId}&startAt=0&limit=1`, {
      headers: authHeaders(token)
    });
    
    const sub = res.data?.Subscriptions?.[0];
    if (!sub) {
      throw new Error("Subscription not found in Celcoin");
    }
    
    // The first transaction in the list is usually the current/latest one.
    const transaction = sub?.Transactions?.[0];
    
    return {
      paymentMethod: sub?.mainPaymentMethodId,
      status: transaction?.status,
      pix: transaction?.Pix ? {
        qrCodeImage: transaction.Pix.image,
        qrCodeText: transaction.Pix.qrCode,
        paymentPage: transaction.Pix.page
      } : null,
      boleto: transaction?.Boleto ? {
        pdf: transaction.Boleto.pdf,
        bankLine: transaction.Boleto.bankLine,
        paymentPage: transaction.Boleto.page
      } : null
    };
  }
};
