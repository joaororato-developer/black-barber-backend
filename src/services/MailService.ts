import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export const MailService = {
  async sendConfirmationCode(to: string, code: string) {
    const htmlTemplate = `
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta name="color-scheme" content="dark">
        <meta name="supported-color-schemes" content="dark">
        <style>
          :root {
            color-scheme: dark;
            supported-color-schemes: dark;
          }
          u + #body a { color: inherit; text-decoration: none; font-size: inherit; font-family: inherit; font-weight: inherit; line-height: inherit; }
        </style>
      </head>
      <body id="body" style="margin: 0; padding: 0; background-color: #000000; background-image: linear-gradient(#000000, #000000);">
        <div style="background-color: #000000; background-image: linear-gradient(#000000, #000000); padding: 40px 20px; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #ffffff;">
          <div style="max-width: 500px; margin: 0 auto; background-color: #0A0A0A; background-image: linear-gradient(#0A0A0A, #0A0A0A); border: none; border-radius: 16px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.8);">
            <div style="background-color: #111111; background-image: linear-gradient(#111111, #111111); padding: 30px; text-align: center; border-bottom: none;">
              <h1 style="color: #FFD700; margin: 0; font-size: 24px; font-weight: 900; letter-spacing: 2px; text-transform: uppercase;">Black Barber</h1>
              <p style="color: #999999; margin: 5px 0 0 0; font-size: 12px; font-weight: bold; letter-spacing: 1px;">PREMIUM CLUB</p>
            </div>
            <div style="padding: 40px 30px; background-color: #0A0A0A; background-image: linear-gradient(#0A0A0A, #0A0A0A);">
              <h2 style="color: #FFFFFF; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">Confirme seu acesso</h2>
              <p style="color: #999999; margin: 0 0 30px 0; font-size: 15px; line-height: 1.6;">
                Estamos quase lá. Falta apenas um passo para você fazer parte do clube exclusivo Black Barber. Utilize o código de segurança abaixo para confirmar a criação da sua conta:
              </p>
              <div style="background-color: #050505; background-image: linear-gradient(#050505, #050505); border: 1px solid #FFD700; border-radius: 12px; padding: 25px; text-align: center; margin-bottom: 30px;">
                <span style="font-size: 38px; font-weight: 900; letter-spacing: 8px; color: #FFD700; text-shadow: 0 0 15px rgba(255,215,0,0.3);">
                  ${code}
                </span>
              </div>
              <p style="color: #888888; margin: 0; font-size: 13px; text-align: center;">
                &#9201;&#65039; Este código expira em <strong style="color: #888888;">5 minutos</strong>.
              </p>
            </div>
            <div style="background-color: #050505; background-image: linear-gradient(#050505, #050505); padding: 25px; text-align: center; border-top: none;">
              <p style="color: #888888; margin: 0; font-size: 11px; line-height: 1.5;">
                Se você não solicitou esta assinatura, apenas ignore este e-mail.<br>
                A equipe Black Barber nunca pedirá sua senha.
              </p>
              <p style="color: #111111; margin: 10px 0 0 0; font-size: 10px; text-align: center;">
                Ref: ${new Date().getTime()}
              </p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      await transporter.sendMail({
        from: `Black Barber <${process.env.SMTP_FROM}>`,
        to,
        subject: `Código ${code} - Black Barber`,
        html: htmlTemplate,
      });
    } catch (error) {
      throw new Error('Falha no envio de e-mail');
    }
  },

  async sendDataDeletionAlert(customer: { name: string; email: string; cpf: string }) {
    const requestedAt = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const adminEmail = process.env.ADMIN_EMAIL || process.env.SMTP_FROM;

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
        <h2 style="color: #cc0000;">[LGPD] Solicitação de Exclusão de Dados</h2>
        <p>Um cliente solicitou a exclusão de seus dados pessoais conforme o Art. 18, IV da LGPD.</p>
        <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: #f5f5f5;">Nome</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${customer.name}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: #f5f5f5;">E-mail</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${customer.email}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: #f5f5f5;">CPF</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${customer.cpf}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: #f5f5f5;">Data/Hora</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${requestedAt}</td>
          </tr>
        </table>
        <p style="margin-top: 20px; color: #666; font-size: 13px;">
          O prazo legal para resposta é de <strong>15 dias úteis</strong>. Cancele a assinatura e exclua os dados do cliente no sistema e na Celcoin.
        </p>
      </div>
    `;

    await transporter.sendMail({
      from: `Black Barber <${process.env.SMTP_FROM}>`,
      to: adminEmail!,
      subject: `[LGPD] Solicitação de exclusão de dados — ${customer.name}`,
      html,
    });
  },
};
