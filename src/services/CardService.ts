import crypto from 'crypto';
import db from '../database/connection';

const ENCRYPTION_KEY = process.env.CARD_ENCRYPTION_KEY || 'black_barber_card_secret_key_2026';
const IV_LENGTH = 16;

export const CardService = {
  async saveCard(customerId: string, card: { number: string; holderName: string; month: string; year: string; cvv: string }) {
    const dataToEncrypt = JSON.stringify({
      number: card.number.replace(/\s/g, ''),
      cvv: card.cvv,
      holderName: card.holderName,
      month: card.month,
      year: card.year
    });

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).substring(0, 32)), iv);
    let encrypted = cipher.update(dataToEncrypt);
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    const encryptedData = iv.toString('hex') + ':' + encrypted.toString('hex');

    const brand = this.getCardBrand(card.number);
    const lastDigits = card.number.replace(/\s/g, '').slice(-4);

    await db('customer_cards').insert({
      customer_id: customerId,
      encrypted_data: encryptedData,
      brand,
      last_digits: lastDigits,
      holder_name: card.holderName,
      expiry_month: card.month.padStart(2, '0'),
      expiry_year: card.year.length === 2 ? `20${card.year}` : card.year,
      is_default: true,
      updated_at: new Date()
    }).onConflict(['customer_id']).merge();
  },

  async getCard(customerId: string) {
    const cardRow = await db('customer_cards').where({ customer_id: customerId }).first();
    if (!cardRow) return null;

    const textParts = cardRow.encrypted_data.split(':');
    const iv = Buffer.from(textParts.shift()!, 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).substring(0, 32)), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return JSON.parse(decrypted.toString());
  },

  getCardBrand(number: string) {
    const re = {
      visa: /^4/,
      mastercard: /^5[1-5]/,
      amex: /^3[47]/,
      elo: /^4011|4389|4514|4576|5041|5066|5090|6277|6362|6363|6500|6504|6505|6507|6509|6516|6550/,
      hipercard: /^3841|6062/
    };

    if (re.visa.test(number)) return 'visa';
    if (re.mastercard.test(number)) return 'mastercard';
    if (re.amex.test(number)) return 'amex';
    if (re.elo.test(number)) return 'elo';
    if (re.hipercard.test(number)) return 'hipercard';
    return 'unknown';
  }
};
