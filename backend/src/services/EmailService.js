const nodemailer = require('nodemailer');

class EmailService {
  static transporter = null;

  static getTransporter() {
    if (!this.transporter) {
      const host = process.env.SMTP_HOST;
      const user = process.env.SMTP_USER;
      const pass = process.env.SMTP_PASS;

      // SMTP должен быть настроен явно: иначе код подтверждения "уйдёт" в
      // тестовый ethereal.email, и реальный пользователь письмо не получит.
      if (!host || !user || !pass) {
        throw new Error(
          'SMTP не настроен: заполните SMTP_HOST, SMTP_USER и SMTP_PASS в backend/.env'
        );
      }

      const port = parseInt(process.env.SMTP_PORT, 10) || 465;
      // 465 — неявный TLS (secure: true), 587 — STARTTLS (secure: false)
      const secure = process.env.SMTP_SECURE
        ? process.env.SMTP_SECURE === 'true'
        : port === 465;

      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
      });
    }
    return this.transporter;
  }

  static async sendVerificationEmail(email, name, code) {
    const transporter = this.getTransporter();

    const subject = 'Подтверждение email — Ozon Manager';
    const text = [
      `Добро пожаловать, ${name}!`,
      '',
      `Ваш код подтверждения: ${code}`,
      'Код действителен 15 минут.',
      '',
      'Если вы не регистрировались — просто проигнорируйте это письмо.',
    ].join('\n');
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h1 style="font-size: 20px;">Добро пожаловать, ${name}!</h1>
        <p>Для подтверждения вашего email введите этот код на странице подтверждения:</p>
        <div style="background: #f4f4f5; border-radius: 8px; padding: 16px; text-align: center; margin: 16px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px;">${code}</span>
        </div>
        <p style="color: #666;">Код действителен 15 минут.</p>
        <p style="color: #999; font-size: 12px;">Если вы не регистрировались — просто проигнорируйте это письмо.</p>
      </div>
    `;

    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || `"Ozon Manager" <${process.env.SMTP_USER}>`,
      to: email,
      subject,
      text,
      html,
    });

    console.log(`[Email] Отправлено письмо на ${email}, messageId: ${info.messageId}`);
    // Предпросмотр письма полезен только для тестового ethereal,
    // если его прописали в SMTP_HOST явно
    if (transporter.options.host === 'smtp.ethereal.email') {
      console.log(`[Email] Предпросмотр: ${nodemailer.getTestMessageUrl(info)}`);
    }
    return info;
  }

  static async sendPasswordResetEmail(email, name, code) {
    const transporter = this.getTransporter();

    const subject = 'Сброс пароля — Ozon Manager';
    const text = [
      `Здравствуйте, ${name || 'пользователь'}!`,
      '',
      `Ваш код для сброса пароля: ${code}`,
      'Код действителен 15 минут.',
      '',
      'Если вы не запрашивали сброс пароля — просто проигнорируйте это письмо, ваш пароль останется прежним.',
    ].join('\n');
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h1 style="font-size: 20px;">Сброс пароля</h1>
        <p>Здравствуйте, ${name || 'пользователь'}!</p>
        <p>Был получен запрос на сброс пароля от вашей учетной записи. Введите код ниже для установки нового пароля:</p>
        <div style="background: #f4f4f5; border-radius: 8px; padding: 16px; text-align: center; margin: 16px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px;">${code}</span>
        </div>
        <p style="color: #666;">Код действителен 15 минут.</p>
        <p style="color: #999; font-size: 12px;">Если вы не запрашивали сброс пароля — просто проигнорируйте это письмо, пароль не изменится.</p>
      </div>
    `;

    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || `"Ozon Manager" <${process.env.SMTP_USER}>`,
      to: email,
      subject,
      text,
      html,
    });

    console.log(`[Email] Отправлено письмо сброса пароля на ${email}, messageId: ${info.messageId}`);
    if (transporter.options.host === 'smtp.ethereal.email') {
      console.log(`[Email] Предпросмотр: ${nodemailer.getTestMessageUrl(info)}`);
    }
    return info;
  }

}

module.exports = EmailService;